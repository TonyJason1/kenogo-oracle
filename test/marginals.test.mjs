/* KenoGO Oracle — per-ball inclusion marginals vs the frozen Monte Carlo
 * reference (Mk II guard, adapted where keno's shallower compression
 * demands it — adaptations disclosed below).
 *
 * The fixture (test/fixtures/oracle-marginals.json, generator
 * make-oracle-marginals.mjs) freezes BOTH the stats and a 10,000,000-line
 * successive-sampling reference for the shipped spot count (k=10) at
 * Classic and Maximum — Subtle and Strong bracket between them. Frozen
 * stats mean the 6-hourly data commit can never drift the reference.
 *
 * Three layers:
 *  1. COHERENCE — the fixture is what it claims: sample depth, preset ↔
 *     intensity, frozen stats validate, Σ marginals = k exactly (every
 *     line contributes exactly k inclusions), every ball reachable.
 *  2. ANTI-NAIVE CONTROL (deterministic) — recompute naive k·w/Σw from the
 *     frozen stats and assert the reference sits MANY σ away from it at
 *     the 10M sample depth. Keno's compression at k=10 is real but small
 *     (measured: worst rel. error 0.87% Classic, 2.03% Maximum — cf. Mk
 *     II's 7.68%/21.53% at their k=20 cap), which is INSIDE the 100k
 *     replay's noise floor — so unlike Mk II the replay cannot reject
 *     naive; this deterministic check is what catches a naive-poisoned
 *     fixture instead. Disclosed adaptation.
 *  3. REPLAY — 100,000 fresh lines against the FROZEN stats per case;
 *     per-ball binomial z vs the reference, two-sided Bonferroni across
 *     the pool at family α = 0.0001 (zCrit ≈ 4.85). Mk II used α = 0.001,
 *     but this suite rides the 6-hourly Action — 4 runs/day at 0.001/case
 *     would false-alarm every ~4 months; at 0.0001 it is once in ~3.4
 *     years, while a real regression (uniform fallback, index shift,
 *     wrong weights) lands tens of σ out. Disclosed tightening.
 */
import { readFileSync } from "node:fs";
import {
  POOL, intensityOf, oracleStats, pickWeighted, unifiedWeights
} from "../js/oracle.js";

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

/** Acklam's inverse normal CDF — |relative error| < 1.15e-9, ample for a
 * test threshold. */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  return -invNorm(1 - p);
}

const FAMILY_ALPHA = 0.0001;
const REPLAY_N = 100_000;

const FIX = JSON.parse(readFileSync(new URL("./fixtures/oracle-marginals.json", import.meta.url), "utf8"));

await check("fixture coherence: depth, cases, preset ↔ intensity, frozen stats validate", () => {
  ok(FIX.samples >= 1e7, `reference depth ${FIX.samples} < 10M`);
  eq(FIX.spots, 10, "the shipped default spot count");
  eq(FIX.cases.length, 2);
  eq(FIX.cases[0].preset, "classic");
  eq(FIX.cases[1].preset, "maximum");
  for (const c of FIX.cases) {
    eq(c.intensity, intensityOf(c.preset), `${c.preset} stored intensity`);
    eq(c.marginals.length, POOL);
  }
  ok(oracleStats(FIX.stats), "frozen stats must validate (identity included)");
});

await check("Σ marginals = k exactly, every ball reachable, weights bounded on frozen stats", () => {
  const s = oracleStats(FIX.stats);
  for (const c of FIX.cases) {
    const sum = c.marginals.reduce((a, b) => a + b, 0);
    near(sum, FIX.spots, 1e-9, `${c.preset}: every line contributes exactly k inclusions`);
    ok(c.marginals.every((m) => m > 0 && m < 1), `${c.preset}: all balls reachable`);
    const w = unifiedWeights(s, c.intensity);
    for (let ball = 1; ball <= POOL; ball++) {
      ok(w[ball] >= 1 && w[ball] <= 1 + c.intensity + 1e-12, `${c.preset}: frozen weight bound ball ${ball}`);
    }
  }
});

await check("anti-naive control: the reference is successive sampling, NOT k·w/Σw (≥8σ at 10M)", () => {
  const s = oracleStats(FIX.stats);
  for (const c of FIX.cases) {
    const w = unifiedWeights(s, c.intensity);
    const totalW = w.reduce((a, b) => a + b, 0);
    let worstRel = 0, worstSigma = 0;
    for (let ball = 1; ball <= POOL; ball++) {
      const m = c.marginals[ball - 1];
      const naive = (FIX.spots * w[ball]) / totalW;
      const se = Math.sqrt((m * (1 - m)) / FIX.samples);
      worstRel = Math.max(worstRel, Math.abs(naive - m) / m);
      worstSigma = Math.max(worstSigma, Math.abs(naive - m) / se);
    }
    near(worstRel, c.naiveWorstRelErr, 1e-9, `${c.preset}: recorded compression re-derives`);
    ok(worstSigma >= 8,
      `${c.preset}: naive sits only ${worstSigma.toFixed(1)}σ from the reference — a naive-poisoned fixture would slip through`);
    // Compression is real and bounded (measured 0.87% / 2.03%; growing with I).
    const [lo, hi] = c.preset === "classic" ? [0.004, 0.05] : [0.01, 0.10];
    ok(worstRel > lo && worstRel < hi,
      `${c.preset}: compression ${(100 * worstRel).toFixed(2)}% outside the measured band (${100 * lo}%–${100 * hi}%)`);
  }
});

await check(`replay: 100k fresh lines match the reference (Bonferroni family α = ${FAMILY_ALPHA})`, () => {
  const s = oracleStats(FIX.stats);
  const zCrit = invNorm(1 - FAMILY_ALPHA / (2 * POOL)); // ≈ 4.85
  for (const c of FIX.cases) {
    const w = unifiedWeights(s, c.intensity);
    const counts = new Array(POOL + 1).fill(0);
    for (let i = 0; i < REPLAY_N; i++) {
      for (const ball of pickWeighted(FIX.spots, w)) counts[ball]++;
    }
    let worst = 0, worstBall = 0;
    for (let ball = 1; ball <= POOL; ball++) {
      const m = c.marginals[ball - 1];
      const z = (counts[ball] - REPLAY_N * m) / Math.sqrt(REPLAY_N * m * (1 - m));
      if (Math.abs(z) > Math.abs(worst)) { worst = z; worstBall = ball; }
    }
    ok(Math.abs(worst) < zCrit,
      `${c.preset}: ball ${worstBall} z = ${worst.toFixed(2)} beyond ±${zCrit.toFixed(2)} — sampler drifted from its reference`);
    console.log(`     ${c.preset}: worst |z| ${Math.abs(worst).toFixed(2)} (ball ${worstBall}) vs crit ${zCrit.toFixed(2)}`);
  }
});

console.log(`\nMarginals: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
