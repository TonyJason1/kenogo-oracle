/* KenoGO Oracle — archive reconciliation audit.
 *
 *   npm run audit                                   (offline, report + gates)
 *   node scripts/audit-data.mjs --strict            (post-updater: must be current)
 *   node scripts/audit-data.mjs --as-of=2026-08-13T12:00:00Z   (deterministic clock)
 *
 * Report-only reconciliation doctrine: everything measured is printed; only
 * the NAMED hard-fail checks gate (exit 1). New checks start report-only.
 *
 * HARD FAILS:
 *   structure  — any CSV line that does not parse, any non-ascending or
 *                duplicate drawingDate
 *   chain      — any adjacent gap that is neither exact cadence nor a
 *                ledgered anomaly (era-crossing / missed-slots)
 *   ledger     — cadence math vs actual count disagrees with the ledger
 *   coverage   — a ball absent from an archive big enough to make that
 *                impossible (n >= 500 → P < 1e-6)
 *   identity   — Σ per-ball counts ≠ 20 × n (every record carries exactly
 *                20 balls; stats consumers derive balls-per-draw from this)
 *   weekly-chi2 — trailing-week corrected chi² at or past the corruption
 *                threshold (typical fluctuation stays report-only)
 *   stats      — data/stats.json missing or drifted from the files on disk
 *   freshness  — more draws pending than one refresh cycle explains
 *                (suspended in catch-up mode unless --strict; the local
 *                backfill legitimately owns a large gap)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CATCHUP_BUCKETS, DRAWN, ERA_160_START_MS, GAP_160_MS, GAP_180_MS, POOL,
  WEEK_DRAWS, chi2Corrected, computeStats, judgeGap, readAllRecords, readJson
} from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* --data-dir=<path> points the audit at a synthetic archive (tests only). */
const dataDirFlag = process.argv.find((a) => a.startsWith("--data-dir="));
const DATA_DIR = dataDirFlag ? dataDirFlag.slice("--data-dir=".length) : join(ROOT, "data");
const DRAWS_DIR = join(DATA_DIR, "draws");

/* Freshness budgets, in scheduled draws at the 160 s cadence.
 * Normal: one 6-hourly refresh period + the ~1 h not-yet-complete bucket the
 * walk cannot fetch + grace ≈ 7.25 h → 164 draws.
 * Strict (right after an updater run): the ~1 h bucket lag + publish/retry
 * slack only. */
const NORMAL_BUDGET_DRAWS = Math.ceil(7.25 * 3600 * 1000 / GAP_160_MS); // 164
const STRICT_BUDGET_DRAWS = 30;

/* ------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const asOfFlag = argv.find((a) => a.startsWith("--as-of="));
const asOfArg = asOfFlag ? asOfFlag.slice("--as-of=".length) : null;
if (asOfFlag !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(asOfArg ?? "") || Number.isNaN(Date.parse(asOfArg)))) {
  console.error(`--as-of must be a full UTC instant YYYY-MM-DDTHH:MM:SSZ, got "${asOfArg}"`);
  process.exit(2);
}
const AS_OF_MS = asOfArg ? Date.parse(asOfArg) : Date.now();
const asOfIso = new Date(AS_OF_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
const sydney = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short"
}).format(new Date(AS_OF_MS));

const fmt = (n) => n.toLocaleString("en-AU");
let hardFails = 0;
const fail = (name, msg) => { hardFails++; console.error(`FAIL ${name}: ${msg}`); };

console.log(`audit: anchor ${asOfIso} (${sydney} in Australia/Sydney)${strict ? " — STRICT (post-updater)" : ""}`);

/* -------------------------------------------- 1. structure + chain walk */

const ledger = readJson(join(DATA_DIR, "anomalies.json")) ?? [];
const ledgerKeys = new Set(ledger.map((e) => `${e.type}|${e.detail}`));
const isLedgered = (j) => j.ledger && ledgerKeys.has(`${j.ledger.type}|${j.ledger.detail}`);

let n = 0, first = null, prev = null, tail = null;
let structureBad = 0, chainBad = 0, ledgeredSeen = 0, missedSlots = 0;
let crossing = null; // { prevMs, laterMs } once the archive spans the era pin
const ballSeen = new Array(80).fill(0);
const htHist = { heads: 0, tails: 0, evens: 0 };
const bonusHist = new Map();
const jackpotHist = new Map();
/* Trailing-week ring buffer for the weekly chi-square: per-ball counts over
 * the last WEEK_DRAWS records, maintained in the same single pass. */
const weekFreq = new Array(80).fill(0);
const weekRing = new Array(WEEK_DRAWS).fill(null);

try {
  for (const rec of readAllRecords(DRAWS_DIR)) {
    if (prev) {
      if (rec.ms <= prev.ms) {
        structureBad++;
        if (structureBad <= 3) fail("structure", `non-ascending drawingDate at ${rec.drawingDate}`);
      } else {
        const j = judgeGap(prev.ms, rec.ms);
        if (j.ok) { /* exact cadence */ }
        else if (j.ledger && isLedgered(j)) {
          ledgeredSeen++;
          if (j.ledger.type === "missed-slots") {
            missedSlots += (rec.ms - prev.ms) / (rec.ms >= ERA_160_START_MS ? GAP_160_MS : GAP_180_MS) - 1;
          }
          if (j.ledger.type === "era-crossing") crossing = { prevMs: prev.ms, laterMs: rec.ms };
        } else {
          chainBad++;
          if (chainBad <= 3) {
            fail("chain", j.fatal ?? `unledgered anomaly: ${j.ledger.type} — ${j.ledger.detail}`);
          }
        }
      }
    }
    for (const b of rec.numbers) ballSeen[b - 1]++;
    const slot = n % WEEK_DRAWS;
    if (weekRing[slot]) for (const b of weekRing[slot]) weekFreq[b - 1]--;
    weekRing[slot] = rec.numbers;
    for (const b of rec.numbers) weekFreq[b - 1]++;
    htHist[rec.headsTails]++;
    bonusHist.set(rec.bonusFactor, (bonusHist.get(rec.bonusFactor) ?? 0) + 1);
    jackpotHist.set(rec.jackpotLevel, (jackpotHist.get(rec.jackpotLevel) ?? 0) + 1);
    if (!first) first = rec;
    prev = rec;
    n++;
  }
} catch (err) {
  fail("structure", err.message);
}
tail = prev;

if (n === 0) {
  console.log("audit: archive is EMPTY — nothing to reconcile (backfill has not started).");
  process.exit(hardFails ? 1 : 0);
}

console.log(`\narchive: ${fmt(n)} draws, ${first.drawingDate} → ${tail.drawingDate}`);
if (structureBad > 3) fail("structure", `${structureBad - 3} further ordering violations suppressed`);
if (chainBad > 3) fail("chain", `${chainBad - 3} further chain violations suppressed`);
if (!structureBad && !chainBad) {
  console.log(`ok   chain: every adjacent gap is exact cadence or ledgered ` +
    `(${ledgeredSeen} ledgered anomaly(ies): ${fmt(missedSlots)} missed slot(s)` +
    `${crossing ? ", 1 era crossing" : ""})`);
}

/* ------------------------------------- 2. cadence math vs actual count */

/* Independent of the pair walk: slot arithmetic over the archive span, split
 * at the measured era crossing, must land exactly on n + missed slots. */
{
  let expected;
  if (tail.ms < ERA_160_START_MS) {
    expected = (tail.ms - first.ms) / GAP_180_MS + 1;
  } else if (first.ms >= ERA_160_START_MS) {
    expected = (tail.ms - first.ms) / GAP_160_MS + 1;
  } else if (crossing) {
    expected = (crossing.prevMs - first.ms) / GAP_180_MS + 1 +
               (tail.ms - crossing.laterMs) / GAP_160_MS + 1;
  } else {
    expected = null;
    fail("ledger", "archive spans the era pin but no era-crossing entry is ledgered");
  }
  if (expected !== null) {
    if (!Number.isInteger(expected)) {
      fail("ledger", `cadence math is fractional (${expected}) — span does not tile the cadence`);
    } else if (expected - missedSlots !== n) {
      fail("ledger", `cadence math expects ${fmt(expected)} slots − ${fmt(missedSlots)} ledgered missed ` +
        `= ${fmt(expected - missedSlots)}, archive holds ${fmt(n)}`);
    } else {
      console.log(`ok   ledger: cadence math reconciles exactly — ${fmt(expected)} slots − ` +
        `${fmt(missedSlots)} missed = ${fmt(n)} draws`);
    }
  }
}

/* --------------------------------------------------- 3. ball coverage */

{
  const absent = ballSeen.map((c, i) => [i + 1, c]).filter(([, c]) => c === 0);
  // P(one given ball absent from n draws) = C(79,20)/C(80,20) = 0.75^... = (60/80)^n exact: (1 - 20/80)^n approx
  if (n >= 500 && absent.length) {
    fail("coverage", `ball(s) ${absent.map(([b]) => b).join(", ")} absent from ${fmt(n)} draws (P < 1e-6 each)`);
  } else if (absent.length) {
    console.log(`     coverage: ${absent.length} ball(s) not yet seen at n=${fmt(n)} — expected while tiny, report-only`);
  } else {
    const min = Math.min(...ballSeen), max = Math.max(...ballSeen);
    console.log(`ok   coverage: all 80 balls present (per-ball count ${fmt(min)}–${fmt(max)})`);
  }
}

/* -------------------------------------- 3b. conservation identity */

/* Every archived record carries exactly 20 balls (parseCsvLine enforces the
 * shape), so Σ per-ball counts === 20 × n ALWAYS. Stats consumers lean on
 * this: the client re-derives balls-per-draw from Σfreq/n instead of
 * trusting a stored constant. Cheap, and the one check that would catch a
 * tallying logic drift no byte-compare can. */
{
  const total = ballSeen.reduce((a, b) => a + b, 0);
  if (total !== n * DRAWN) {
    fail("identity", `Σ per-ball counts = ${fmt(total)}, expected ${DRAWN} × ${fmt(n)} = ${fmt(n * DRAWN)}`);
  } else {
    console.log(`ok   identity: Σ per-ball counts = ${DRAWN} × n = ${fmt(total)} exactly`);
  }
}

/* ------------------------------- 3c. weekly chi-square, trailing week */

/* The chain-gap law proves the draws ARRIVED on schedule; this checks what
 * is IN them. A feed that started serving garbled-but-parseable ball sets
 * (valid 20-of-80, valid chain) would slip every structural gate — a wildly
 * skewed per-ball distribution over the trailing week is the tell. The
 * statistic is corrected for sampling without replacement (×79/60 — the
 * repo's pinned convention; the probe-week fixture reproduces raw 48.14 →
 * corrected 63.38 @ 79 dof). Typical fluctuation is REPORT-ONLY, per the
 * reconciliation doctrine; the named hard fail is promoted at birth only for
 * the corruption regime: chi² ≥ 180 is p ≈ 1e-9 at 79 dof, so four runs a
 * day false-alarm about once in 10^5 years, while a garbled feed lands
 * orders of magnitude past it. */
const CHI2_WEEKLY_FATAL = 180;
{
  const windowN = Math.min(n, WEEK_DRAWS);
  const chi2 = chi2Corrected(weekFreq, windowN);
  const label = `corrected chi² ${chi2.toFixed(2)} @ ${POOL - 1} dof over the trailing ${fmt(windowN)} draw(s)`;
  if (chi2 >= CHI2_WEEKLY_FATAL) {
    fail("weekly-chi2", `${label} — at or past the corruption threshold ${CHI2_WEEKLY_FATAL} (p ≈ 1e-9): ` +
      `the feed is serving non-uniform ball sets; quarantine before trusting new data`);
  } else {
    console.log(`ok   weekly-chi2: ${label} (×79/60 without-replacement correction, fatal at ${CHI2_WEEKLY_FATAL})`);
  }
}

/* ------------------------------------------- 4. report-only histograms */

{
  const pct = (c) => `${(100 * c / n).toFixed(1)}%`;
  // Exact hypergeometric reference, computed rather than pinned:
  // P(evens) = C(40,10)² / C(80,20); heads/tails split the rest evenly.
  const choose = (nn, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (nn - k + i)) / i; return r; };
  const pEvens = (choose(40, 10) ** 2) / choose(80, 20);
  const pSide = (1 - pEvens) / 2;
  console.log(`     headsTails: heads ${pct(htHist.heads)} / tails ${pct(htHist.tails)} / evens ${pct(htHist.evens)}` +
    ` (hypergeometric reference ${(100 * pSide).toFixed(1)}% / ${(100 * pSide).toFixed(1)}% / ${(100 * pEvens).toFixed(1)}%) — report-only`);
  const hist = (m) => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => `${k}×${fmt(v)}`).join(", ");
  console.log(`     bonus: {${hist(bonusHist)}} | jackpot level: {${hist(jackpotHist)}} — report-only`);
}

/* ----------------------------------------------------- 5. stats drift */

/* In catch-up mode (and not --strict) drift is the EXPECTED state — the local
 * backfill appends continuously and stats.json is rebuilt at session close.
 * Everywhere else it is byte-enforced: a stale stats file is a lying footer. */
const inCatchup = Math.floor((AS_OF_MS - tail.ms) / 3_600_000) > CATCHUP_BUCKETS;

{
  const statsPath = join(DATA_DIR, "stats.json");
  let onDisk = null;
  try { onDisk = readFileSync(statsPath, "utf8").trim(); } catch { /* missing */ }
  const derived = JSON.stringify(computeStats(readAllRecords(DRAWS_DIR)));
  if (onDisk === derived) {
    console.log(`ok   stats: stats.json re-derives byte-identical (n=${fmt(n)}, through ${tail.drawingDate})`);
  } else if (inCatchup && !strict) {
    const parsed = onDisk ? JSON.parse(onDisk) : null;
    console.log(`     stats: ${parsed ? `describes n=${fmt(parsed.n)}, archive is at n=${fmt(n)}` : "absent"} ` +
      `— backfill in progress, rebuilt at session close. Report-only in catch-up.`);
  } else if (onDisk === null) {
    fail("stats", "data/stats.json missing — run `npm run stats`; the footer's data currency depends on it");
  } else {
    fail("stats", "data/stats.json drifted from the archive — a stale or hand-edited stats file is a lying footer; run `npm run stats`");
  }
}

/* ------------------------------------------------- 6. cursor (advisory) */

{
  const cursor = readJson(join(DATA_DIR, "cursor.json"));
  if (!cursor) console.log("     cursor: data/cursor.json absent — advisory only, files are the resume truth");
  else if (cursor.lastDrawingDate !== tail.drawingDate) {
    console.log(`     cursor: says ${cursor.lastDrawingDate}, files say ${tail.drawingDate} — advisory only (files win), likely a mid-walk snapshot`);
  } else {
    console.log(`ok   cursor: matches the archive tail (next bucket ${cursor.nextBucket})`);
  }
}

/* -------------------------------------------------------- 7. freshness */

{
  const gapMs = AS_OF_MS - tail.ms;
  const pending = Math.max(0, Math.floor(gapMs / GAP_160_MS));
  const gapBuckets = Math.floor(gapMs / 3_600_000);
  const catchup = gapBuckets > CATCHUP_BUCKETS;
  const budget = strict ? STRICT_BUDGET_DRAWS : NORMAL_BUDGET_DRAWS;

  if (catchup && !strict) {
    console.log(`     freshness: CATCH-UP MODE — archive tail ${tail.drawingDate} is ~${fmt(gapBuckets)} buckets ` +
      `(${fmt(pending)} draws) behind ${asOfIso}. The one-off local backfill owns this gap; ` +
      `the 6-hourly Action takes over below ${CATCHUP_BUCKETS} buckets. Report-only until then.`);
  } else if (pending <= budget) {
    console.log(`ok   freshness: ${fmt(pending)} scheduled draw(s) pending as of ${asOfIso} ` +
      `(budget ${budget}${strict ? ", strict" : ", one 6-hourly refresh cycle"})`);
  } else {
    fail("freshness", `${fmt(pending)} scheduled draw(s) missing since ${tail.drawingDate} as of ${asOfIso} ` +
      `— budget is ${budget}${strict ? " (strict)" : ""}. The 6-hourly update Action has not landed data; ` +
      `check its run history before trusting this archive.`);
  }
}

/* ---------------------------------------------------------- verdict */

console.log(hardFails ? `\nAUDIT FAILED — ${hardFails} hard failure(s)` : "\nAUDIT CLEAN — archive reconciles");
process.exit(hardFails ? 1 : 0);
