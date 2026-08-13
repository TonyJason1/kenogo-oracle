/* KenoGO Oracle — the adjacency tripwire (Mk II guard, re-measured for keno).
 *
 * CLOSED FORM (uniform k-of-n draw):
 *     P(no adjacent pair) = C(n−k+1, k) / C(n, k)
 * Stars and bars: subtracting i−1 from the i-th smallest element is a
 * bijection between k-subsets of {1..n} with no two consecutive and
 * arbitrary k-subsets of {1..n−k+1}. So
 *     P(line contains ≥1 consecutive pair) = 1 − C(n−k+1, k)/C(n, k),
 * and equivalently E[# adjacent pairs] = k(k−1)/n (79 pairs × the
 * inclusion probability k(k−1)/(n(n−1))) — the fraction-of-lines form is
 * what the gate measures. Hand-check at k=2: 1 − C(79,2)/C(80,2) =
 * 79/3160 = 0.025 exactly.
 *
 * WHY THIS STATISTIC: the blend's three signals are spatially noise-like
 * across ball values, so weighting moves the pair fraction only marginally.
 * A sampler bug that correlates NEIGHBOURING balls — cumulative-sum
 * indexing, an off-by-one in the proposal loop — shifts it by whole
 * percentage points and trips every gate at once. Adjacency is the canary
 * for exactly the bug class a weighted sampler can regress into.
 *
 * OFFSETS: measured 2026-08-14 at 1,000,000 lines per case over EVERY
 * preset × k = 1..10 against the shipped stats.json (n = 718,947), se ≈
 * 0.05pp — generator test/fixtures/make-adjacency-offsets.mjs, committed
 * record test/fixtures/adjacency-offsets.json. Worst |observed − closed|:
 *     subtle  0.110pp (k=8)     classic 0.126pp (k=8)
 *     strong  0.353pp (k=9)     maximum 0.500pp (k=9)
 * The tilt sits adjacency slightly BELOW uniform, growing with I — the
 * same shape and worst magnitude Mk II measured on the lotto matrices.
 *
 * GATES: ±1pp through Strong, ±1.25pp at Maximum. Numerically the Mk II
 * constants, kept because keno's own measurement re-earns them: at this
 * test's 100,000 lines binomial σ ≈ 0.158pp, so the thinnest margins are
 * (1 − 0.353)/0.158 ≈ 4.1σ (Strong) and (1.25 − 0.500)/0.158 ≈ 4.7σ
 * (Maximum). ≥3σ no-flake headroom holds everywhere; nothing was widened
 * beyond Mk II's own Maximum allowance. Re-measure and re-derive after ANY
 * sampler or blend change.
 */
import { readFileSync } from "node:fs";
import {
  INTENSITY_PRESETS, POOL, oracleStats, pickWeighted, unifiedWeights
} from "../js/oracle.js";

const N_LINES = 100_000;
const GATE = { subtle: 0.01, classic: 0.01, strong: 0.01, maximum: 0.0125 };

function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
const closedPairFraction = (n, k) => 1 - choose(n - k + 1, k) / choose(n, k);

const raw = JSON.parse(readFileSync(new URL("../data/stats.json", import.meta.url), "utf8"));
const stats = oracleStats(raw);

let pass = 0, fail = 0;
const report = [];

/* Doctrine pins: the closed form itself, at the exact hand-checkable point
 * and at the shipped default spot count — a changed default k or a broken
 * choose() moves these before anything statistical runs. */
{
  const k2 = closedPairFraction(POOL, 2);
  const k10 = closedPairFraction(POOL, 10);
  if (Math.abs(k2 - 0.025) < 1e-12 && Math.abs(k10 - 0.7195625476) < 1e-9) { pass += 1; }
  else {
    fail += 1;
    console.error(`FAIL doctrine: closed form k=2 ${k2} (expect 0.025 ±1e-12), k=10 ${k10} (expect 0.7195625476 ±1e-9)`);
  }
}

for (const preset of INTENSITY_PRESETS) {
  const w = unifiedWeights(stats, preset.I);
  for (let k = 1; k <= 10; k++) {
    let withPair = 0;
    for (let i = 0; i < N_LINES; i++) {
      const line = pickWeighted(k, w); // sorted ascending
      for (let j = 1; j < k; j++) {
        if (line[j] - line[j - 1] === 1) { withPair++; break; }
      }
    }
    const observed = withPair / N_LINES;
    const closed = closedPairFraction(POOL, k);
    const delta = observed - closed;
    // k=1 cannot contain a pair: the observation must be EXACTLY zero.
    const okCase = k === 1 ? withPair === 0 : Math.abs(delta) <= GATE[preset.key];
    if (okCase) pass++; else fail++;
    report.push(
      `${preset.key.padEnd(8)} k=${String(k).padStart(2)}  closed ${closed.toFixed(6)}  ` +
      `observed ${observed.toFixed(6)}  Δ ${(100 * delta).toFixed(3).padStart(7)}pp  ` +
      `gate ±${(100 * GATE[preset.key]).toFixed(2)}pp  ${okCase ? "PASS" : "FAIL"}`
    );
    if (!okCase) console.error(`FAIL adjacency: ${report[report.length - 1]}`);
  }
}

console.log(`\nKenoGO Oracle — adjacency tripwire (${N_LINES.toLocaleString()} lines per case)\n`);
for (const line of report) console.log(line);
console.log(`\nAdjacency: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
