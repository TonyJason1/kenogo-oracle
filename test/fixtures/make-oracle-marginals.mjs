/* KenoGO Oracle — OFFLINE marginals reference generator (Mk II method).
 *
 *   node test/fixtures/make-oracle-marginals.mjs [samples-per-case]
 *
 * The acceptance–rejection sampler is SUCCESSIVE sampling: per-ball
 * inclusion probabilities are compressed toward uniform relative to the
 * naive k·w/Σw, and the compression grows with k and I. There is no cheap
 * closed form (Wallenius territory), so the reference is Monte Carlo at
 * 10,000,000 lines per case — se per ball ≈ √(p(1−p)/1e7) ≈ 1.1e-4, an
 * order of magnitude below the replay test's resolution.
 *
 * The stats the weights derive from are FROZEN INSIDE the fixture, so the
 * 6-hourly data commit can never drift the reference: the replay test
 * samples against the frozen stats, not the live file.
 *
 * Cases: the SHIPPED default spot count (10) at Classic and Maximum —
 * Subtle and Strong bracket between them (Mk II case selection).
 *
 * Writes test/fixtures/oracle-marginals.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { POOL, intensityOf, oracleStats, pickWeighted, unifiedWeights } from "../../js/oracle.js";

const SAMPLES = Number(process.argv[2] ?? 10_000_000);
const SPOTS = 10; // the app's shipped default (SPOTS_DEFAULT)

const raw = JSON.parse(readFileSync(new URL("../../data/stats.json", import.meta.url), "utf8"));
const stats = oracleStats(raw);

console.log(`oracle marginals: ${SAMPLES.toLocaleString()} lines per case, k=${SPOTS}, ` +
  `frozen stats n=${raw.n.toLocaleString()} through ${raw.dataThrough}\n`);

const cases = [];
for (const presetKey of ["classic", "maximum"]) {
  const I = intensityOf(presetKey);
  const w = unifiedWeights(stats, I);
  const totalW = w.reduce((a, b) => a + b, 0);
  const t0 = process.hrtime.bigint();

  const counts = new Array(POOL + 1).fill(0);
  for (let i = 0; i < SAMPLES; i++) {
    for (const ball of pickWeighted(SPOTS, w)) counts[ball]++;
  }

  const marginals = [];
  let naiveWorstRelErr = 0, sumMarg = 0;
  for (let b = 1; b <= POOL; b++) {
    const m = counts[b] / SAMPLES;
    marginals.push(m);
    sumMarg += m;
    const naive = (SPOTS * w[b]) / totalW;
    naiveWorstRelErr = Math.max(naiveWorstRelErr, Math.abs(naive - m) / m);
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(`${presetKey}: Σmarginals=${sumMarg.toFixed(9)} (must be ${SPOTS}), ` +
    `naive k·w/Σw worst relative error ${(100 * naiveWorstRelErr).toFixed(2)}% — ` +
    `the successive-sampling compression — ${secs.toFixed(0)}s`);
  cases.push({ preset: presetKey, intensity: I, marginals, naiveWorstRelErr });
}

const out = {
  samples: SAMPLES,
  spots: SPOTS,
  stats: raw, // FROZEN — the replay test uses this, never the live file
  cases
};
writeFileSync(new URL("./oracle-marginals.json", import.meta.url), JSON.stringify(out) + "\n");
console.log("\nwritten: test/fixtures/oracle-marginals.json");
