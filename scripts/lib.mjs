/* KenoGO Oracle — shared data core.
 *
 * Pure functions + tiny IO helpers for the backfill, the 6-hourly updater,
 * the stats builder and the audit. Everything here is exported so the tests
 * can exercise the exact code the pipeline runs. Node builtins only.
 *
 * API facts (probed 2026-08-13, re-verified live at scaffold time):
 *   GET https://api-kenogo.lttlapp.com/api/v1/draws
 *       ?productId=kenoGo&currencyId=AUD&date=<YYYY-MM-DDTHH:00:00Z>
 *   returns { items: [...] } for that UTC HOUR bucket (20 items in the 180 s
 *   era, 22–23 in the 160 s era). No other params work. Items carry `state`
 *   ("finished" is all we ingest), `numbers[20]` in DRAWING ORDER,
 *   `drawingDate` with a +00:00 offset, `externalId` as a STRING cycling
 *   1..999 (~44.4 h — NEVER a key, and NOT contiguous per draw in the 180 s
 *   era: the floor bucket spans ids 129..150 over 20 draws with a perfect
 *   180 s time chain), `sideBetResults {headsTails, jackpot, bonus}` (present
 *   all the way down to the 2022-10-18 floor — verified), and a ~7.7 KB
 *   `odds` paytable we strip and never store.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/* ------------------------------------------------------------- constants */

export const API_BASE = "https://api-kenogo.lttlapp.com/api/v1/draws";
export const API_PARAMS = "productId=kenoGo&currencyId=AUD";
export const USER_AGENT = "kenogo-oracle data pipeline (github.com/TonyJason1/kenogo-oracle)";

/** API publication floor, probed 2026-08-13 (starts mid-cycle at game 129 —
 * a truncation point, possibly rolling retention; floor-scan handles drift). */
export const FLOOR_BUCKET = "2022-10-18T00";

/** Cadence era pin (probe 2026-08-13): 180 s per draw from the floor through
 * 2024-05-20, 160 s since 2024-05-21. The exact crossing gap is unknown until
 * the backfill walks it; the single era-crossing pair is ledgered, not fatal. */
export const ERA_160_START_MS = Date.parse("2024-05-21T00:00:00Z");
export const GAP_160_MS = 160_000;
export const GAP_180_MS = 180_000;

/** A time gap that is an exact multiple of the cadence (2..MAX_MISSED_SLOTS
 * slots) reads as cancelled/skipped draws — a fact about the world, ledgered
 * and accepted loudly. Anything else is corruption and fatal. */
export const MAX_MISSED_SLOTS = 45; // ~2 h of the 160 s cadence

/** Updater self-restraint: while the archive tail is further than this many
 * buckets behind the wall clock, the Action must not fetch at all — the local
 * backfill owns the walk. ~48 h of buckets. */
export const CATCHUP_BUCKETS = 48;

/** Buckets one 6-hourly Action run may walk in steady state (6 h of buckets
 * + overlap + one spare). */
export const RUN_BUCKETS = 10;

export const CSV_HEADER = "drawingDate,externalId,numbers,headsTails,jackpotLevel,bonusFactor";

export const HEADS_TAILS = new Set(["heads", "tails", "evens"]);
export const JACKPOT_LEVELS = new Set(["regular", "minor", "major"]);
export const BONUS_FACTORS = new Set([1, 2, 3, 4, 5, 10]);

export const POOL = 80;
export const DRAWN = 20;

/* ------------------------------------------------------------ time utils */

const HOUR_MS = 3_600_000;

/** "2022-10-18T05" for any ms/ISO input (UTC). */
export function bucketOf(t) {
  const ms = typeof t === "number" ? t : Date.parse(t);
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);
}

export function bucketStartMs(bucket) {
  const ms = Date.parse(`${bucket}:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`bad bucket "${bucket}"`);
  return ms;
}

export function nextBucket(bucket) {
  return bucketOf(bucketStartMs(bucket) + HOUR_MS);
}

/** Whole buckets strictly between two instants' buckets (0 = same bucket). */
export function bucketsBetween(fromMs, toMs) {
  return Math.max(0, Math.floor(toMs / HOUR_MS) - Math.floor(fromMs / HOUR_MS));
}

export function bucketUrl(bucket) {
  return `${API_BASE}?${API_PARAMS}&date=${encodeURIComponent(`${bucket}:00:00Z`)}`;
}

/** UTC month "2022-10" a record belongs to. */
export const monthOf = (isoZ) => isoZ.slice(0, 7);

/** Normalise an API timestamp (+00:00 offset, or already Z) to second-precision Z. */
export function toZ(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ------------------------------------------------------- record parsing */

/** Side-bet result derivable from the numbers — a free garbled-payload check.
 * heads = majority of the 20 drawn balls in 1–40, tails = majority in 41–80. */
export function headsTailsOf(numbers) {
  const low = numbers.filter((n) => n <= 40).length;
  return low > DRAWN / 2 ? "heads" : low < DRAWN / 2 ? "tails" : "evens";
}

/**
 * API item → archive record, `{ rec }` | `{ skip, reason }` | `{ err, reason }`.
 *
 * skip = legitimately not archivable (scheduled/open future draw).
 * err  = the payload is garbled or violates a pinned fact — FATAL upstream:
 *        anomalies are flagged and stop the run, never silently accepted.
 */
export function parseItem(raw) {
  const err = (reason) =>
    ({ err: true, reason: `${reason} — ${JSON.stringify(raw ?? null).slice(0, 200)}` });
  if (!raw || typeof raw !== "object") return err("item not an object");
  if (raw.state !== "finished") return { skip: true, reason: `state ${raw.state}` };

  const drawingDate = typeof raw.drawingDate === "string" ? toZ(raw.drawingDate) : null;
  if (!drawingDate) return err("bad drawingDate");

  const externalId = String(raw.externalId ?? "");
  if (!/^\d{1,3}$/.test(externalId) || +externalId < 1 || +externalId > 999) {
    return err(`externalId "${externalId}" outside the pinned 1..999 counter`);
  }

  const numbers = raw.numbers;
  if (!Array.isArray(numbers) || numbers.length !== DRAWN ||
      !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= POOL)) {
    return err(`numbers is not ${DRAWN} ints in 1..${POOL}`);
  }
  if (new Set(numbers).size !== DRAWN) return err("duplicate ball in numbers");

  const sb = raw.sideBetResults;
  if (!sb || typeof sb !== "object") return err("missing sideBetResults");
  if (!HEADS_TAILS.has(sb.headsTails)) return err(`headsTails "${sb.headsTails}" outside pinned set`);
  if (!JACKPOT_LEVELS.has(sb.jackpot)) return err(`jackpot "${sb.jackpot}" outside pinned set`);
  if (!BONUS_FACTORS.has(sb.bonus)) return err(`bonus "${sb.bonus}" outside pinned set`);
  const derived = headsTailsOf(numbers);
  if (derived !== sb.headsTails) {
    return err(`headsTails cross-check failed: numbers say "${derived}", payload says "${sb.headsTails}"`);
  }

  return {
    rec: {
      drawingDate,
      ms: Date.parse(drawingDate),
      externalId,
      numbers: numbers.slice(), // drawn order preserved
      headsTails: sb.headsTails,
      jackpotLevel: sb.jackpot,
      bonusFactor: sb.bonus
    }
  };
}

/* --------------------------------------------------------- chain-gap law */

/** Expected gap INTO the draw at `laterMs`, by era. */
export function expectedGapMs(laterMs) {
  return laterMs >= ERA_160_START_MS ? GAP_160_MS : GAP_180_MS;
}

/**
 * Judge one adjacent pair. This is the hole detector: a short or padded
 * bucket cannot pass it.
 *   { ok: true }                          exact cadence gap
 *   { ledger: {...} }                     accepted, but recorded loudly:
 *       type "era-crossing"  the single 180→160 boundary pair
 *       type "missed-slots"  gap = k × cadence (2..MAX_MISSED_SLOTS)
 *   { fatal: "..." }                      corruption — refuse the write
 */
export function judgeGap(prevMs, laterMs) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const gap = laterMs - prevMs;
  if (gap <= 0) return { fatal: `non-increasing drawingDate (gap ${gap} ms)` };

  const crossing = prevMs < ERA_160_START_MS && laterMs >= ERA_160_START_MS;
  if (crossing) {
    if (gap > 48 * HOUR_MS) return { fatal: `era-crossing gap ${gap} ms exceeds 48 h — API hole` };
    return {
      ledger: {
        type: "era-crossing",
        detail: `180s→160s era boundary: ${iso(prevMs)} → ${iso(laterMs)} (gap ${gap / 1000}s)`
      }
    };
  }

  const cadence = expectedGapMs(laterMs);
  if (gap === cadence) return { ok: true };
  if (gap % cadence === 0) {
    const missed = gap / cadence - 1;
    if (missed <= MAX_MISSED_SLOTS) {
      return {
        ledger: {
          type: "missed-slots",
          detail: `${missed} skipped slot(s) before ${iso(laterMs)} ` +
                  `(gap ${gap / 1000}s at ${cadence / 1000}s cadence)`
        }
      };
    }
    return { fatal: `${missed} missed slots before ${iso(laterMs)} — beyond MAX_MISSED_SLOTS, suspected API hole` };
  }
  return {
    fatal: `off-cadence gap ${gap / 1000}s into ${iso(laterMs)} ` +
           `(expected ${cadence / 1000}s or a whole multiple)`
  };
}

/**
 * Validate a batch of new records against the stored tail.
 * Records must already be sorted ascending and deduped.
 * Returns { fatal: string | null, ledger: [...] }.
 */
export function validateChain(tailMs, records) {
  const ledger = [];
  let prev = tailMs;
  for (const rec of records) {
    if (prev != null) {
      const j = judgeGap(prev, rec.ms);
      if (j.fatal) return { fatal: `${j.fatal}`, ledger };
      if (j.ledger) ledger.push(j.ledger);
    }
    prev = rec.ms;
  }
  return { fatal: null, ledger };
}

/* ---------------------------------------------------------------- CSV io */

export function toCsvLine(rec) {
  return [
    rec.drawingDate, rec.externalId, rec.numbers.join(" "),
    rec.headsTails, rec.jackpotLevel, rec.bonusFactor
  ].join(",");
}

/** Parse one archive line back to a record; throws on any malformation. */
export function parseCsvLine(line) {
  const parts = line.split(",");
  if (parts.length !== 6) throw new Error(`CSV line has ${parts.length} fields: "${line.slice(0, 80)}"`);
  const [drawingDate, externalId, numbersStr, headsTails, jackpotLevel, bonusStr] = parts;
  const ms = Date.parse(drawingDate);
  if (!/Z$/.test(drawingDate) || Number.isNaN(ms)) throw new Error(`bad drawingDate "${drawingDate}"`);
  const numbers = numbersStr.split(" ").map(Number);
  if (numbers.length !== DRAWN || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > POOL) ||
      new Set(numbers).size !== DRAWN) {
    throw new Error(`bad numbers field in "${line.slice(0, 80)}"`);
  }
  if (!HEADS_TAILS.has(headsTails)) throw new Error(`bad headsTails "${headsTails}"`);
  if (!JACKPOT_LEVELS.has(jackpotLevel)) throw new Error(`bad jackpotLevel "${jackpotLevel}"`);
  const bonusFactor = Number(bonusStr);
  if (!BONUS_FACTORS.has(bonusFactor)) throw new Error(`bad bonusFactor "${bonusStr}"`);
  if (headsTailsOf(numbers) !== headsTails) throw new Error(`headsTails cross-check failed on "${line.slice(0, 80)}"`);
  return { drawingDate, ms, externalId, numbers, headsTails, jackpotLevel, bonusFactor };
}

/** Sorted list of monthly archive files ("2022-10.csv", ...). */
export function listMonthFiles(drawsDir) {
  try {
    return readdirSync(drawsDir).filter((f) => /^\d{4}-\d{2}\.csv$/.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * Repair a possibly torn tail (a kill mid-append): if the file does not end
 * with \n, or its last line does not parse, truncate back to the last good
 * line. Returns the number of bytes cut (0 = clean).
 */
export function repairMonthFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0; // absent — nothing to repair
  }
  let end = text.length;
  if (end === 0) return 0;
  if (!text.endsWith("\n")) {
    end = text.lastIndexOf("\n") + 1; // drop the torn final line (may be 0)
  }
  // The last complete line must parse; if not, drop it too (once). A stray
  // \r (a CRLF checkout despite .gitattributes) is tolerated, not "torn" —
  // this loop must never be able to eat a good file line by line.
  while (end > 0) {
    const prevNl = text.lastIndexOf("\n", end - 2);
    const lastLine = text.slice(prevNl + 1, end - 1).replace(/\r$/, "");
    if (lastLine === CSV_HEADER) break;
    try { parseCsvLine(lastLine); break; }
    catch { end = prevNl + 1; }
  }
  const cut = text.length - end;
  if (cut > 0) truncateSync(path, end);
  return cut;
}

/** Last archived record across all month files, or null. Repairs the tail. */
export function lastRecordOnDisk(drawsDir) {
  const files = listMonthFiles(drawsDir);
  for (let i = files.length - 1; i >= 0; i--) {
    const path = join(drawsDir, files[i]);
    repairMonthFile(path);
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      if (lines[j] === CSV_HEADER) continue;
      return parseCsvLine(lines[j]);
    }
  }
  return null;
}

/** Append validated records, grouped into monthly files (header on create). */
export async function appendRecords(drawsDir, records) {
  mkdirSync(drawsDir, { recursive: true });
  const byMonth = new Map();
  for (const rec of records) {
    const m = monthOf(rec.drawingDate);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(rec);
  }
  for (const [month, recs] of byMonth) {
    const path = join(drawsDir, `${month}.csv`);
    let prefix = "";
    try { statSync(path); } catch { prefix = `${CSV_HEADER}\n`; }
    await appendFile(path, prefix + recs.map(toCsvLine).join("\n") + "\n", "utf8");
  }
}

/** Stream every archived record in order. Throws on any malformed line. */
export function* readAllRecords(drawsDir) {
  for (const file of listMonthFiles(drawsDir)) {
    const lines = readFileSync(join(drawsDir, file), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line === CSV_HEADER) continue;
      yield parseCsvLine(line);
    }
  }
}

/* ---------------------------------------------------------- cursor + ledger */

export async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Append entries to the committed anomaly ledger (data/anomalies.json). */
export async function appendLedger(dataDir, entries) {
  if (!entries.length) return;
  const path = join(dataDir, "anomalies.json");
  const existing = readJson(path) ?? [];
  const seen = new Set(existing.map((e) => `${e.type}|${e.detail}`));
  for (const e of entries) {
    if (!seen.has(`${e.type}|${e.detail}`)) existing.push(e);
  }
  await writeJsonAtomic(path, existing);
}

/* ------------------------------------------------------------- fetching */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one hour bucket → raw items. 3 attempts with linear backoff; an
 * empty PAST bucket is retried once more (5 s) and then thrown — a whole
 * silent hour is an API hole, never acceptable data.
 */
export async function fetchBucket(bucket, { fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(bucketUrl(bucket), {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.items)) throw new Error("response has no items[]");
      return json.items;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`bucket ${bucket}: ${lastErr.message}`);
}

/* ------------------------------------------------------------- the walk */

/**
 * The shared bucket-walk engine (backfill AND updater run this exact code).
 *
 * Resume truth: the FILES win. The tail record on disk decides the starting
 * bucket (its own bucket is re-fetched and deduped by ms), the cursor file is
 * a statement of position, rewritten after every bucket. With no tail, the
 * walk floor-scans forward from FLOOR_BUCKET across empty buckets (rolling
 * retention) until data appears.
 *
 * Stops when: bucket not yet fully in the past | maxBuckets walked |
 * fatal anomaly (nothing from that bucket is written; cursor untouched).
 *
 * opts: { dataDir, maxBuckets, delayMs, fetchImpl, now, log }
 */
export async function walkBuckets(opts) {
  const {
    dataDir,
    maxBuckets = Infinity,
    delayMs = 1000,
    holeRecheckMs = 5000,
    fetchImpl = fetch,
    now = () => Date.now(),
    log = () => {}
  } = opts;
  const drawsDir = join(dataDir, "draws");
  const cursorPath = join(dataDir, "cursor.json");

  let tail = lastRecordOnDisk(drawsDir);
  const cursor = readJson(cursorPath);
  let bucket = tail
    ? bucketOf(tail.ms)
    : (cursor?.discoveredFloor ?? FLOOR_BUCKET);
  let discoveredFloor = cursor?.discoveredFloor ?? null;
  let floorScanned = false; // an empty bucket was crossed → the floor moved

  const out = { buckets: 0, draws: 0, skipped: 0, ledgered: 0, tail, stopped: "caught-up" };

  while (out.buckets < maxBuckets) {
    if (bucketStartMs(bucket) + HOUR_MS > now()) { out.stopped = "caught-up"; break; }

    let items;
    try {
      items = await fetchBucket(bucket, { fetchImpl });
    } catch (err) {
      out.stopped = `fetch-failed: ${err.message}`;
      return out;
    }
    out.buckets++;

    if (items.length === 0) {
      if (!tail) {
        // floor-scan: retention has rolled past the pinned floor
        log(`  floor-scan: ${bucket} empty, advancing`);
        floorScanned = true;
        bucket = nextBucket(bucket);
        await sleep(delayMs);
        continue;
      }
      // one respectful re-check, then refuse — a silent hour is a hole
      await sleep(holeRecheckMs);
      let again;
      try { again = await fetchBucket(bucket, { fetchImpl }); } catch { again = []; }
      if (again.length === 0) {
        out.stopped = `empty-past-bucket: ${bucket} returned no items twice — suspected API hole, refusing to advance`;
        return out;
      }
      items = again;
    }

    const records = [];
    for (const raw of items) {
      const parsed = parseItem(raw);
      if (parsed.err) { out.stopped = `reject: ${parsed.reason}`; return out; }
      if (parsed.skip) { out.skipped++; continue; }
      records.push(parsed.rec);
    }
    records.sort((a, b) => a.ms - b.ms);

    // in-bucket duplicate drawingDate: identical rows collapse, conflicting rows are fatal
    const fresh = [];
    for (const rec of records) {
      if (tail && rec.ms <= tail.ms) {
        if (rec.ms === tail.ms && toCsvLine(rec) !== toCsvLine(tail)) {
          out.stopped = `conflict: refetched draw ${rec.drawingDate} differs from stored record`;
          return out;
        }
        continue; // already stored (bucket overlap on resume)
      }
      const prev = fresh[fresh.length - 1];
      if (prev && prev.ms === rec.ms) {
        if (toCsvLine(prev) !== toCsvLine(rec)) {
          out.stopped = `conflict: two items share drawingDate ${rec.drawingDate} with different content`;
          return out;
        }
        continue; // exact duplicate — collapse
      }
      fresh.push(rec);
    }

    if (fresh.length) {
      const { fatal, ledger } = validateChain(tail?.ms ?? null, fresh);
      if (fatal) { out.stopped = `chain: ${fatal}`; return out; }
      if (ledger.length) {
        for (const e of ledger) log(`  LEDGER ${e.type}: ${e.detail}`);
        await appendLedger(dataDir, ledger);
        out.ledgered += ledger.length;
      }
      await appendRecords(drawsDir, fresh);
      tail = fresh[fresh.length - 1];
      out.draws += fresh.length;
    }
    if (tail && (floorScanned || !discoveredFloor)) {
      discoveredFloor = bucket; // where data actually starts (rolling retention)
      floorScanned = false;
    }

    await writeJsonAtomic(cursorPath, {
      nextBucket: nextBucket(bucket),
      lastDrawingDate: tail?.drawingDate ?? null,
      discoveredFloor: discoveredFloor ?? FLOOR_BUCKET,
      updatedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z")
    });

    log(`  ${bucket}: +${fresh.length} draws (archive → ${tail?.drawingDate ?? "empty"})`);
    bucket = nextBucket(bucket);
    out.tail = tail;
    if (out.buckets < maxBuckets) await sleep(delayMs);
  }

  if (out.buckets >= maxBuckets) out.stopped = "max-buckets";
  out.tail = tail;
  return out;
}

/* --------------------------------------------------------------- stats */

export const STATS_SCHEMA = 1;
export const HALF_LIFE_DRAWS = 540; // one 160 s-era day of draws

/**
 * Single pass over the archive → data/stats.json content. Deterministic
 * (no wall-clock field): the audit re-derives and byte-compares it.
 */
export function computeStats(recordIterator) {
  const freq = new Array(POOL).fill(0);
  const decayed = new Array(POOL).fill(0);
  const lastIndex = new Array(POOL).fill(-1);
  const d = Math.pow(0.5, 1 / HALF_LIFE_DRAWS);
  let n = 0, first = null, last = null;

  for (const rec of recordIterator) {
    for (let b = 0; b < POOL; b++) decayed[b] *= d;
    for (const ball of rec.numbers) {
      freq[ball - 1]++;
      decayed[ball - 1] += 1;
      lastIndex[ball - 1] = n;
    }
    if (!first) first = rec.drawingDate;
    last = rec.drawingDate;
    n++;
  }

  return {
    schema: STATS_SCHEMA,
    n,
    firstDraw: first,
    dataThrough: last,
    halfLifeDraws: HALF_LIFE_DRAWS,
    freq,
    lastSeenDrawsAgo: lastIndex.map((i) => (i === -1 ? null : n - 1 - i)),
    decayedFreq: decayed.map((v) => Math.round(v * 1e6) / 1e6)
  };
}

export async function writeStats(dataDir) {
  const stats = computeStats(readAllRecords(join(dataDir, "draws")));
  if (stats.n === 0) return null; // nothing archived yet — no stats to describe
  // Compact on purpose: this is the one data file the client fetches.
  const path = join(dataDir, "stats.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(stats) + "\n", "utf8");
  await rename(tmp, path);
  return stats;
}
