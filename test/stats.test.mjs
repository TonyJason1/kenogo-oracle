/* KenoGO Oracle — stats precompute + the keno-corrected chi-square fixture.
 *
 * The fixture (test/fixtures/week-freq.json) is a REAL full week of KenoGO
 * draws captured by the 2026-08-13 probe: n = 3,780, per-ball frequencies.
 * The feasibility report computed raw Pearson chi² = 48.14 and the
 * without-replacement-corrected value ×(N−1)/(N−K) = ×79/60 = 63.38
 * (79 dof, p ≈ 0.90 — uniform). This suite re-derives both from the pinned
 * frequencies, so the correction math in any future consumer can never
 * drift from the reference. Zero dependencies.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HALF_LIFE_DRAWS, POOL, STATS_SCHEMA, WEEK_DRAWS, appendRecords,
  chi2Corrected, computeStats, headsTailsOf, readAllRecords, writeStats
} from "../scripts/lib.mjs";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function near(a, b, tol, what = "") {
  if (Math.abs(a - b) > tol) throw new Error(`${what} expected ${b} ±${tol}, got ${a}`);
}

const WEEK = JSON.parse(readFileSync(new URL("./fixtures/week-freq.json", import.meta.url), "utf8"));

function makeRec(ms, numbers, { jackpotLevel = "regular", bonusFactor = 1 } = {}) {
  return {
    drawingDate: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ms, externalId: "1", numbers,
    headsTails: headsTailsOf(numbers), jackpotLevel, bonusFactor
  };
}
const T0 = Date.parse("2026-01-01T00:00:00Z");
const seq = (start) => Array.from({ length: 20 }, (_, i) => start + i);

/* ------------------------------------------------------- computeStats */

await check("freq, lastSeenDrawsAgo and span over a hand-checkable archive", () => {
  const recs = [
    makeRec(T0, seq(1)),            // balls 1..20
    makeRec(T0 + 160_000, seq(21)), // balls 21..40
    makeRec(T0 + 320_000, seq(1))   // balls 1..20 again
  ];
  const s = computeStats(recs[Symbol.iterator]());
  eq(s.n, 3);
  eq(s.firstDraw, recs[0].drawingDate);
  eq(s.dataThrough, recs[2].drawingDate);
  eq(s.freq[0], 2, "ball 1 twice");
  eq(s.freq[20], 1, "ball 21 once");
  eq(s.freq[79], 0, "ball 80 never");
  eq(s.freq.reduce((a, b) => a + b, 0), 3 * 20, "total observations = n × 20");
  eq(s.lastSeenDrawsAgo[0], 0, "ball 1 in the latest draw");
  eq(s.lastSeenDrawsAgo[20], 1, "ball 21 one draw ago");
  eq(s.lastSeenDrawsAgo[79], null, "ball 80 never seen");
});

await check("recency decay follows the pinned half-life exactly", () => {
  const recs = [makeRec(T0, seq(1)), makeRec(T0 + 160_000, seq(21))];
  const s = computeStats(recs[Symbol.iterator]());
  const d = Math.pow(0.5, 1 / HALF_LIFE_DRAWS);
  near(s.decayedFreq[0], d, 1e-6, "ball 1 decayed once");     // seen draw 0, aged 1 step
  near(s.decayedFreq[20], 1, 1e-6, "ball 21 fresh");          // seen in the latest draw
  eq(s.halfLifeDraws, HALF_LIFE_DRAWS);
  // one half-life of absence really halves the weight
  const long = [makeRec(T0, seq(1))];
  for (let i = 1; i <= HALF_LIFE_DRAWS; i++) long.push(makeRec(T0 + i * 160_000, seq(21)));
  const s2 = computeStats(long[Symbol.iterator]());
  near(s2.decayedFreq[0], 0.5, 1e-9, "ball 1 after exactly one half-life of absence");
});

await check("schema 2 doctrine pins: half-life = one week of the 160 s cadence", () => {
  eq(STATS_SCHEMA, 2, "stats schema");
  eq(HALF_LIFE_DRAWS, 3780, "half-life: 7 × 540 draws — one week at 160 s");
  eq(WEEK_DRAWS, 3780, "the weekly chi² window IS the half-life window, deliberately");
});

await check("sideBets aggregates count exactly what the archive says (display-only)", () => {
  const recs = [
    makeRec(T0, seq(1)),                                              // heads (20 low)
    makeRec(T0 + 160_000, seq(61), { jackpotLevel: "major", bonusFactor: 10 }), // tails
    makeRec(T0 + 320_000, [...seq(31).slice(0, 10), ...seq(41).slice(0, 10)],
      { jackpotLevel: "minor", bonusFactor: 5 })                      // 10 low + 10 high = evens
  ];
  const s = computeStats(recs[Symbol.iterator]());
  eq(s.sideBets.headsTails.heads, 1);
  eq(s.sideBets.headsTails.tails, 1);
  eq(s.sideBets.headsTails.evens, 1);
  eq(s.sideBets.jackpot.regular, 1);
  eq(s.sideBets.jackpot.minor, 1);
  eq(s.sideBets.jackpot.major, 1);
  eq(s.sideBets.bonus[1], 1);
  eq(s.sideBets.bonus[5], 1);
  eq(s.sideBets.bonus[10], 1);
  eq(s.sideBets.bonus[2] + s.sideBets.bonus[3] + s.sideBets.bonus[4], 0, "unused factors stay 0");
});

await check("stats are deterministic — same records, same bytes", () => {
  const recs = () => [makeRec(T0, seq(5)), makeRec(T0 + 160_000, seq(41))][Symbol.iterator]();
  eq(JSON.stringify(computeStats(recs())), JSON.stringify(computeStats(recs())));
});

await check("writeStats round-trips through the CSV archive byte-stably", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kg-stats-"));
  await appendRecords(join(dir, "draws"), [makeRec(T0, seq(1)), makeRec(T0 + 160_000, seq(30))]);
  const s1 = await writeStats(dir);
  const bytes1 = readFileSync(join(dir, "stats.json"), "utf8");
  const s2 = await writeStats(dir);
  const bytes2 = readFileSync(join(dir, "stats.json"), "utf8");
  eq(bytes1, bytes2, "byte-stable across rebuilds");
  eq(s1.n, s2.n);
  const derived = computeStats(readAllRecords(join(dir, "draws")));
  eq(JSON.stringify(derived), bytes1.trim(), "file equals the derivation (the audit's drift law)");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------- the keno-corrected chi-square fixture */

function chiCrit999(df) {
  const z = 3.0902323061678132;
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

await check("week fixture: totals reconcile (n×20 observations over 80 balls)", () => {
  eq(WEEK.freq.length, POOL);
  eq(WEEK.n, 3780, "the probe week");
  eq(WEEK.freq.reduce((a, b) => a + b, 0), WEEK.n * 20);
});

await check("raw Pearson chi² reproduces the feasibility report: 48.14", () => {
  const expected = (WEEK.n * 20) / POOL;
  let chi2 = 0;
  for (const c of WEEK.freq) chi2 += (c - expected) ** 2 / expected;
  eq(chi2.toFixed(2), "48.14", "raw chi² vs the probe report");
});

await check("corrected chi² ×(N−1)/(N−K) = ×79/60 reproduces the report: 63.38, and is uniform at df=79", () => {
  const expected = (WEEK.n * 20) / POOL;
  let raw = 0;
  for (const c of WEEK.freq) raw += (c - expected) ** 2 / expected;
  const corrected = raw * (POOL - 1) / (POOL - 20);
  eq(corrected.toFixed(2), "63.38", "corrected chi² vs the probe report");
  ok(corrected < chiCrit999(POOL - 1),
    `corrected ${corrected.toFixed(2)} must sit below crit999(79) = ${chiCrit999(POOL - 1).toFixed(2)} — real draws are uniform`);
});

await check("lib's chi2Corrected (the audit's weekly gate) reproduces the fixture exactly", () => {
  // The audit runs this function over the trailing week every 6-hourly
  // cycle; tying it to the probe-week fixture means the Action's reference
  // can never drift from the report's 63.38.
  eq(chi2Corrected(WEEK.freq, WEEK.n).toFixed(2), "63.38");
});

await check("the correction matters: raw chi² alone would understate the statistic by 24%", () => {
  // Without-replacement sampling shrinks E[chi²_raw] to (N−K)/(N−1)·(N−1) = 60.
  // Anyone comparing raw 48.14 against a 79-dof table would call the data
  // suspiciously uniform (p ≈ 0.998). The correction restores the right scale.
  const ratio = (POOL - 1) / (POOL - 20);
  near(ratio, 79 / 60, 1e-12);
  ok(ratio > 1.31 && ratio < 1.32, "79/60 ≈ 1.3167");
});

console.log(`\nStats + chi²: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
