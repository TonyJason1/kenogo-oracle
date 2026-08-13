/* KenoGO Oracle — data currency: archive stats + live top-up.
 *
 * Two layers, degrading gracefully to nothing:
 *
 * 1. data/stats.json (the ONLY data file the client ever loads — the CSV
 *    corpus stays server-side). Rides the service worker's runtime data
 *    cache, so the date works offline once fetched and data commits land
 *    without a VERSION bump. Footer: "draws to <stamp> · N draws".
 *
 * 2. Live top-up: the KenoGO API is CORS-open, so when the gap between
 *    stats.dataThrough and now is small (≤ LIVE_MAX_BUCKETS hour buckets —
 *    i.e. the 6-hourly Action is in steady state) the client fetches the
 *    no-date window plus the missing buckets and returns the NEW finished
 *    draws in full — numbers and side bets — so the Oracle can fold them
 *    into ONE merged state that the footer, the Reading panel and the
 *    sampler all share. Every new item is validated to the same bar the
 *    pipeline holds (20 unique ints in 1–80, pinned side-bet sets, the
 *    derived heads/tails cross-check); ONE garbled item aborts the whole
 *    top-up and the archive state stands — a poisoned weight is worse than
 *    a stale one. A big gap (backfill territory) or ANY fetch failure
 *    leaves the archive standing too. The top-up can only ever improve the
 *    state, never break it.
 *
 * Every exported function is pure-ish (fetch + clock injectable) for jsdom
 * tests.
 */

export const API_BASE = "https://api-kenogo.lttlapp.com/api/v1/draws";
export const API_PARAMS = "productId=kenoGo&currencyId=AUD";
export const LIVE_MAX_BUCKETS = 6;

const HOUR_MS = 3_600_000;
const POOL = 80;
const DRAWN = 20;

const HEADS_TAILS = new Set(["heads", "tails", "evens"]);
const JACKPOT_LEVELS = new Set(["regular", "minor", "major"]);
const BONUS_FACTORS = new Set([1, 2, 3, 4, 5, 10]);

/** "13 Aug 2026 09:50 UTC" — compact, honest, unambiguous. */
export function formatStamp(isoZ) {
  const d = new Date(isoZ);
  const day = d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const hm = d.toISOString().slice(11, 16);
  return `${day} ${hm} UTC`;
}

export function footerText(stats, live = null) {
  const n = live ? stats.n + live.newDraws : stats.n;
  const through = live ? live.dataThrough : stats.dataThrough;
  return ` · draws to ${formatStamp(through)} · ${n.toLocaleString("en-AU")} draws${live ? " · live" : ""}`;
}

/** Hour-bucket helpers (UTC), mirrored from scripts/lib.mjs for the browser. */
export const bucketOf = (ms) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);

function bucketUrls(fromMs, toMs) {
  const urls = [];
  for (let t = Math.floor(fromMs / HOUR_MS) * HOUR_MS; t <= toMs; t += HOUR_MS) {
    urls.push(`${API_BASE}?${API_PARAMS}&date=${encodeURIComponent(`${bucketOf(t)}:00:00Z`)}`);
  }
  return urls;
}

async function fetchItems(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.items)) throw new Error("no items[]");
  return json.items;
}

/** heads = majority of the 20 drawn balls in 1–40 — derivable, so a free
 * garbled-payload cross-check (same law the pipeline enforces). */
function headsTailsOf(numbers) {
  const low = numbers.filter((n) => n <= 40).length;
  return low > DRAWN / 2 ? "heads" : low < DRAWN / 2 ? "tails" : "evens";
}

const SKIP = Symbol("skip");

/**
 * One API item → validated record, SKIP (not archivable / already stored),
 * or null (garbled — the caller aborts the whole top-up).
 */
function parseLiveItem(it, throughMs) {
  if (!it || typeof it !== "object") return null;
  if (it.state !== "finished") return SKIP; // scheduled/opened future draws
  if (typeof it.drawingDate !== "string") return null;
  const ms = Date.parse(it.drawingDate);
  if (Number.isNaN(ms)) return null;
  if (ms <= throughMs) return SKIP; // already in the archive

  const numbers = it.numbers;
  if (!Array.isArray(numbers) || numbers.length !== DRAWN ||
      !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= POOL) ||
      new Set(numbers).size !== DRAWN) {
    return null;
  }
  const sb = it.sideBetResults;
  if (!sb || typeof sb !== "object") return null;
  if (!HEADS_TAILS.has(sb.headsTails) || !JACKPOT_LEVELS.has(sb.jackpot) || !BONUS_FACTORS.has(sb.bonus)) {
    return null;
  }
  if (headsTailsOf(numbers) !== sb.headsTails) return null;

  return {
    drawingDate: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ms,
    numbers: numbers.slice(), // drawn order preserved
    headsTails: sb.headsTails,
    jackpotLevel: sb.jackpot,
    bonusFactor: sb.bonus
  };
}

const recKey = (rec) =>
  `${rec.numbers.join(" ")}|${rec.headsTails}|${rec.jackpotLevel}|${rec.bonusFactor}`;

/**
 * Try to tighten the archive with live data. Returns
 * `{ newDraws, dataThrough, draws }` — draws ascending, fully validated —
 * or null (any failure, any garbled item, or gap too wide).
 */
export async function liveTopUp(stats, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  try {
    const throughMs = Date.parse(stats.dataThrough);
    if (Number.isNaN(throughMs)) return null;
    const gapBuckets = Math.floor(now() / HOUR_MS) - Math.floor(throughMs / HOUR_MS);
    if (gapBuckets < 0 || gapBuckets > LIVE_MAX_BUCKETS) return null;

    // No-date window first (recent finished + scheduled), then the gap
    // buckets. Deduped by drawingDate; a conflicting duplicate is garble.
    const fresh = new Map(); // ms → rec
    const ingest = (items) => {
      for (const it of items) {
        const rec = parseLiveItem(it, throughMs);
        if (rec === SKIP) continue;
        if (rec === null) throw new Error("garbled live item — archive stands");
        const prev = fresh.get(rec.ms);
        if (prev && recKey(prev) !== recKey(rec)) {
          throw new Error(`conflicting duplicates at ${rec.drawingDate} — archive stands`);
        }
        fresh.set(rec.ms, rec);
      }
    };

    ingest(await fetchItems(`${API_BASE}?${API_PARAMS}`, fetchImpl));
    for (const url of bucketUrls(throughMs, now())) {
      ingest(await fetchItems(url, fetchImpl));
      await new Promise((r) => setTimeout(r, 150)); // client politeness
    }

    if (fresh.size === 0) return null; // nothing newer — archive stands
    const draws = [...fresh.values()].sort((a, b) => a.ms - b.ms);
    return {
      newDraws: draws.length,
      dataThrough: draws[draws.length - 1].drawingDate,
      draws
    };
  } catch {
    return null; // any failure → archive stands
  }
}

/** Fetch + shape-check data/stats.json. Returns the raw object or null. */
export async function loadStats({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl("data/stats.json", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null; // first visit offline — the version stands alone
    const stats = await res.json();
    if (!Number.isInteger(stats?.n) || typeof stats?.dataThrough !== "string") return null;
    return stats;
  } catch {
    return null;
  }
}

/**
 * Wire the footer span: archive stamp immediately, live tightening after.
 * `onData(stats, live)` fires once with (stats, null) when the archive
 * stats land and again with (stats, live) if the top-up succeeds — the
 * app's ONE entry point for building its merged Oracle state, so the
 * footer and the Oracle can never describe different data.
 */
export async function initFooter(el, { fetchImpl = fetch, now = () => Date.now(), onData = () => {} } = {}) {
  const stats = await loadStats({ fetchImpl });
  if (!stats) return;
  el.textContent = footerText(stats);
  onData(stats, null);
  const live = await liveTopUp(stats, { fetchImpl, now });
  if (live) {
    el.textContent = footerText(stats, live);
    onData(stats, live);
  }
}
