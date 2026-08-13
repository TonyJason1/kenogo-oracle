/* KenoGO Oracle — OFFLINE adjacency-offset measurement (Mk II method).
 *
 *   node test/fixtures/make-adjacency-offsets.mjs [samples-per-case]
 *
 * For every intensity preset × spots k = 1..10, samples 1,000,000 Oracle
 * lines against the SHIPPED data/stats.json weights and measures the
 * fraction of lines containing at least one consecutive pair, versus the
 * uniform-draw closed form
 *
 *     P(no adjacent pair in a k-of-n pick) = C(n−k+1, k) / C(n, k)
 *
 * (stars and bars: k chosen values with no two adjacent ↔ k values among
 * n−k+1 slots once each chosen value donates its right neighbour).
 *
 * The measured offsets (observed − closed form) parameterise the gates in
 * test/adjacency.test.mjs: gate = worst |offset| across k per preset + ≥3σ
 * no-flake headroom at the test's 100k sample size. Weighted sampling
 * shifts adjacency only through per-ball marginal tilts (the blend's three
 * signals are spatially noise-like across ball values), so offsets stay
 * small — anything spatially structured would move the fraction by
 * percentage points and trip every gate. That is the tripwire's purpose:
 * a cumulative-sum or off-by-one sampler bug correlates NEIGHBOURING
 * balls, and adjacency is the canary for exactly that class.
 *
 * Writes test/fixtures/adjacency-offsets.json (the measurement record;
 * regenerate after any sampler change and re-derive the gates).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { INTENSITY_PRESETS, POOL, oracleStats, pickWeighted, unifiedWeights } from "../../js/oracle.js";

const SAMPLES = Number(process.argv[2] ?? 1_000_000);

const raw = JSON.parse(readFileSync(new URL("../../data/stats.json", import.meta.url), "utf8"));
const stats = oracleStats(raw);

function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
const closedNoPair = (n, k) => choose(n - k + 1, k) / choose(n, k);

console.log(`adjacency offsets: ${SAMPLES.toLocaleString()} lines per case, weights from stats.json ` +
  `(n=${raw.n.toLocaleString()}, through ${raw.dataThrough})\n`);
console.log("preset    k   closed     observed   offset(pp)   se(pp)   secs");
console.log("-".repeat(66));

const cases = [];
for (const preset of INTENSITY_PRESETS) {
  const w = unifiedWeights(stats, preset.I);
  for (let k = 1; k <= 10; k++) {
    const t0 = process.hrtime.bigint();
    let withPair = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const line = pickWeighted(k, w); // sorted ascending
      for (let j = 1; j < k; j++) {
        if (line[j] - line[j - 1] === 1) { withPair++; break; }
      }
    }
    const closed = 1 - closedNoPair(POOL, k);
    const observed = withPair / SAMPLES;
    const offset = observed - closed;
    const se = Math.sqrt(Math.max(closed * (1 - closed), 1e-12) / SAMPLES);
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    cases.push({ preset: preset.key, I: preset.I, k, closed, observed, offset });
    console.log(
      `${preset.key.padEnd(8)}${String(k).padStart(3)}   ${closed.toFixed(6)}   ${observed.toFixed(6)}   ` +
      `${(100 * offset).toFixed(3).padStart(8)}   ${(100 * se).toFixed(3).padStart(6)}   ${secs.toFixed(1).padStart(5)}`
    );
  }
}

console.log("-".repeat(66));
for (const preset of INTENSITY_PRESETS) {
  const worst = cases.filter((c) => c.preset === preset.key)
    .reduce((a, c) => (Math.abs(c.offset) > Math.abs(a.offset) ? c : a));
  console.log(`worst |offset| ${preset.key.padEnd(8)} ${(100 * Math.abs(worst.offset)).toFixed(3)}pp at k=${worst.k}`);
}

const out = {
  samples: SAMPLES,
  statsN: raw.n,
  statsThrough: raw.dataThrough,
  cases
};
writeFileSync(new URL("./adjacency-offsets.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("\nwritten: test/fixtures/adjacency-offsets.json");
