/* KenoGO Oracle — RNG statistical validation, per spot count.
 *
 * For every spots value the app offers (1–10) plus the house draw size (20):
 * 100,000 simulated lines, asserting
 *   (a) correct pick count
 *   (b) no duplicates within a line
 *   (c) all values in [1, 80]
 *   (d) FULL-POOL COVERAGE — every ball 1..80 appears (at 100k lines even
 *       spots=1 misses a given ball with P = (79/80)^100000 ≈ 10^-546)
 *   (e) chi-square per-ball frequency < 99.9% critical value at df = 79,
 *       CORRECTED for sampling without replacement: drawing K of N per line
 *       makes per-ball counts negatively correlated, so E[chi²_raw] is only
 *       (N−K)/(N−1) × 79 — the raw statistic is scaled by (N−1)/(N−K)
 *       before comparison (79/70 at spots=10, 79/60 at the house K=20).
 * Exits 1 on any failure.
 */
import { drawLine, validateMatrix } from "../rng.js";

const N_LINES = 100_000;
const POOL = 80;
const SPOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]; // 20 = the house draw itself

/* Upper-tail chi-square critical value, Wilson–Hilferty approximation.
 * alpha = 0.001, matching quickpick-au's stated reasoning: 11 matrices tested
 * independently at 95% would false-alarm in 1 − 0.95^11 = 43% of runs, and
 * test:core is what the 6-hourly data Action executes — an alert that cries
 * wolf weekly is worthless. At 0.001 the family-wise rate is ~1.1%, while a
 * real bias defect lands orders of magnitude past the line. */
function chiCrit999(df) {
  const z = 3.0902323061678132; // Phi^-1(0.999)
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

function runSpots(picks) {
  const counts = new Uint32Array(POOL + 1);
  let badCount = 0, badDup = 0, badRange = 0;

  for (let i = 0; i < N_LINES; i++) {
    const line = drawLine(POOL, picks);
    if (line.length !== picks) badCount++;
    const seen = new Set(line);
    if (seen.size !== picks) badDup++;
    for (const v of line) {
      if (!Number.isInteger(v) || v < 1 || v > POOL) { badRange++; break; }
      counts[v]++;
    }
  }

  let uncovered = 0;
  for (let v = 1; v <= POOL; v++) if (counts[v] === 0) uncovered++;

  const expected = (N_LINES * picks) / POOL;
  let chi2raw = 0;
  for (let v = 1; v <= POOL; v++) {
    const d = counts[v] - expected;
    chi2raw += (d * d) / expected;
  }
  const correction = (POOL - 1) / (POOL - picks); // (N−1)/(N−K)
  const chi2 = chi2raw * correction;
  const df = POOL - 1;
  const crit = chiCrit999(df);
  const pass = badCount === 0 && badDup === 0 && badRange === 0 && uncovered === 0 && chi2 < crit;
  return { picks, badCount, badDup, badRange, uncovered, chi2raw, correction, chi2, crit, pass };
}

/* ---- validation guards ---- */
let guardsPass = true;
const mustThrow = [
  () => validateMatrix(10, 11),  // picks > pool
  () => validateMatrix(1, 1),    // pool too small
  () => validateMatrix(80, 0),   // zero picks
  () => drawLine(80, 81)
];
for (const fn of mustThrow) {
  try { fn(); guardsPass = false; } catch { /* expected */ }
}
try { validateMatrix(80, 10); drawLine(2, 1); } catch { guardsPass = false; }

/* ---- run + report ---- */
const rows = SPOTS.map(runSpots);

const pad = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w);
console.log(`\nKenoGO Oracle — per-spot RNG validation (${N_LINES.toLocaleString()} lines per spot count, pool ${POOL})\n`);
console.log(
  pad("spots", 7, true) + pad("count✗", 8, true) + pad("dup✗", 6, true) + pad("range✗", 8, true) +
  pad("uncovered", 11, true) + pad("chi²raw", 10, true) + pad("×corr", 8, true) +
  pad("chi²", 9, true) + pad("crit999", 9, true) + "  result"
);
console.log("-".repeat(78));
for (const r of rows) {
  console.log(
    pad(r.picks, 7, true) + pad(r.badCount, 8, true) + pad(r.badDup, 6, true) + pad(r.badRange, 8, true) +
    pad(r.uncovered, 11, true) + pad(r.chi2raw.toFixed(2), 10, true) + pad(r.correction.toFixed(3), 8, true) +
    pad(r.chi2.toFixed(2), 9, true) + pad(r.crit.toFixed(2), 9, true) +
    (r.pass ? "  PASS" : "  FAIL")
  );
}
console.log("-".repeat(78));
console.log(`Validation guards (invalid matrices throw): ${guardsPass ? "PASS" : "FAIL"}`);

const allPass = guardsPass && rows.every((r) => r.pass);
console.log(allPass
  ? "\nALL SPOT COUNTS PASS (α = 0.001, df = 79, without-replacement correction (N−1)/(N−K))\n"
  : "\nFAILURE — see table above\n");
process.exit(allPass ? 0 : 1);
