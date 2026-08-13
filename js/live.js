/* KenoGO Oracle — footer data currency: archive stats + live top-up.
 *
 * Two layers, degrading gracefully to nothing:
 *
 * 1. data/stats.json (the ONLY data file the client ever loads — the CSV
 *    corpus stays server-side). Rides the service worker's runtime data
 *    cache, so the date works offline once fetched and data commits land
 *    without a VERSION bump. Footer: "draws to <stamp> · N draws".
 *
 * 2. Live top-up, archive-tightening only: the KenoGO API is CORS-open, so
 *    when the gap between stats.dataThrough and now is small (≤ LIVE_MAX_
 *    BUCKETS hour buckets — i.e. the 6-hourly Action is in steady state) the
 *    client fetches the no-date window plus the missing buckets, counts
 *    finished draws newer than the archive, and tightens the footer to
 *    "· live". A big gap (backfill still catching up) or ANY fetch failure
 *    leaves the archive footer standing — the top-up can only ever improve
 *    the stamp, never break the UI. Pure display: picks never touch it.
 *
 * Every exported function is pure-ish (fetch + clock injectable) for jsdom
 * tests.
 */

export const API_BASE = "https://api-kenogo.lttlapp.com/api/v1/draws";
export const API_PARAMS = "productId=kenoGo&currencyId=AUD";
export const LIVE_MAX_BUCKETS = 6;

const HOUR_MS = 3_600_000;

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

/**
 * Try to tighten the archive stamp with live data. Returns
 * `{ newDraws, dataThrough }` or null (any failure, or gap too wide).
 */
export async function liveTopUp(stats, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  try {
    const throughMs = Date.parse(stats.dataThrough);
    if (Number.isNaN(throughMs)) return null;
    const gapBuckets = Math.floor(now() / HOUR_MS) - Math.floor(throughMs / HOUR_MS);
    if (gapBuckets < 0 || gapBuckets > LIVE_MAX_BUCKETS) return null;

    // No-date window first (recent finished + scheduled), then the gap buckets.
    const seen = new Map(); // isoZ → true, deduped across window + buckets
    const ingest = (items) => {
      for (const it of items) {
        if (!it || it.state !== "finished" || typeof it.drawingDate !== "string") continue;
        const ms = Date.parse(it.drawingDate);
        if (Number.isNaN(ms) || ms <= throughMs) continue;
        seen.set(new Date(ms).toISOString(), ms);
      }
    };

    ingest(await fetchItems(`${API_BASE}?${API_PARAMS}`, fetchImpl));
    for (const url of bucketUrls(throughMs, now())) {
      ingest(await fetchItems(url, fetchImpl));
      await new Promise((r) => setTimeout(r, 150)); // client politeness
    }

    if (seen.size === 0) return null; // nothing newer — archive footer stands
    const newest = Math.max(...seen.values());
    return {
      newDraws: seen.size,
      dataThrough: new Date(newest).toISOString().replace(/\.\d{3}Z$/, "Z")
    };
  } catch {
    return null; // any failure → archive footer stands
  }
}

/** Wire the footer span: archive stamp immediately, live tightening after. */
export async function initFooter(el, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  let stats;
  try {
    const res = await fetchImpl("data/stats.json", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return; // first visit offline — the version stands alone
    stats = await res.json();
    if (!Number.isInteger(stats?.n) || typeof stats?.dataThrough !== "string") return;
  } catch {
    return;
  }
  el.textContent = footerText(stats);
  const live = await liveTopUp(stats, { fetchImpl, now });
  if (live) el.textContent = footerText(stats, live);
}
