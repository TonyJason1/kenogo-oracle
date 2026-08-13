/* KenoGO Oracle — the Oracle blend engine suite (zero dependencies).
 *
 * Structure mirrors quickpick-au's predictor suite, because the engine IS
 * that design: doctrine pins (the constants ARE the contract), a TINY
 * hand-computed fixture where every weight is arithmetic a reviewer can
 * redo on paper, the one-formatter law (panel weight === sampling weight,
 * strict equality), merge math against the pinned in-file half-life, and
 * the sampler's output contract with a chi-square distribution check.
 */
import { readFileSync } from "node:fs";
import {
  DRAWN as LIB_DRAWN, HALF_LIFE_DRAWS, POOL as LIB_POOL
} from "../scripts/lib.mjs";
import {
  CLASSIC_I, DEFAULT_INTENSITY, DRAWN, INTENSITY_PRESETS, MAX_INTENSITY,
  POOL, TILT_BLEND, ballReading, flavourReadings, formatWeightLine,
  intensityOf, intensityPreset, mergeStats, oracleStats, ordinal, pct1,
  pickOracleLine, pickWeighted, readingHeader, readingLines, tiltComponents,
  tooltipText, unifiedWeights
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
function mustThrow(fn, re, what) {
  try { fn(); } catch (err) {
    if (re.test(err.message)) return;
    throw new Error(`${what}: threw the wrong message: ${err.message}`);
  }
  throw new Error(`${what}: did not throw`);
}

/* --------------------------------------------------------- doctrine pins */

await check("doctrine pins: blend, presets, default — the Mk II design constants", () => {
  near(TILT_BLEND.hot + TILT_BLEND.overdue + TILT_BLEND.recent, 1, 1e-12,
    "blend must sum to 1 so the structural cap is exactly 1 + I");
  eq(TILT_BLEND.hot, 0.5); eq(TILT_BLEND.overdue, 0.2); eq(TILT_BLEND.recent, 0.3);
  eq(JSON.stringify(INTENSITY_PRESETS.map((p) => [p.key, p.I])),
    JSON.stringify([["subtle", 0.25], ["classic", 0.5], ["strong", 1], ["maximum", 2]]));
  eq(DEFAULT_INTENSITY, "classic");
  eq(MAX_INTENSITY, 2);
  eq(CLASSIC_I, 0.5);
  eq(intensityOf("maximum"), 2);
  eq(intensityPreset("bogus"), null);
  mustThrow(() => intensityOf("bogus"), /unknown intensity preset/, "intensityOf on junk");
});

await check("doctrine pins: matrix constants agree with the data core", () => {
  eq(POOL, LIB_POOL, "pool");
  eq(DRAWN, LIB_DRAWN, "drawn");
});

/* ------------------------------------------- TINY hand-computed fixture */

/* Four hand-crafted draws, half-life 2 (d = 2^(−1/2)):
 *   D1 (age 3): balls 1–20     D2 (age 2): balls 1–20
 *   D3 (age 1): balls 21–40    D4 (age 0): balls 41–60
 * freq: 1–20 → 2, 21–40 → 1, 41–60 → 1, 61–80 → 0 (Σ = 80 = 20 × 4 ✓)
 * gap:  1–20 → 2, 21–40 → 1, 41–60 → 0, 61–80 → null (→ n = 4, most overdue)
 * decayed: 1–20 → d³ + d², 21–40 → d, 41–60 → 1, 61–80 → 0
 */
const D = Math.SQRT1_2; // 2^(−1/2), the half-life-2 per-draw decay
const band = (v20, v40, v60, v80) =>
  [...Array(80)].map((_, i) => (i < 20 ? v20 : i < 40 ? v40 : i < 60 ? v60 : v80));
const TINY = Object.freeze({
  schema: 2,
  n: 4,
  firstDraw: "2026-01-01T00:00:00Z",
  dataThrough: "2026-01-01T00:08:00Z",
  halfLifeDraws: 2,
  freq: band(2, 1, 1, 0),
  lastSeenDrawsAgo: band(2, 1, 0, null),
  decayedFreq: band(D ** 3 + D ** 2, D, 1, 0),
  sideBets: {
    headsTails: { heads: 3, tails: 1, evens: 0 },
    jackpot: { regular: 4, minor: 0, major: 0 },
    bonus: { 1: 4, 2: 0, 3: 0, 4: 0, 5: 0, 10: 0 }
  }
});

await check("TINY: hand-computed tilt components and weights at Classic", () => {
  const s = oracleStats(TINY);
  // ball 1: normFreq (2−0)/2 = 1, normGap (2−0)/(4−0) = 0.5, normRecent (d³+d²)/1
  const c1 = tiltComponents(s, 1, 0.5);
  near(c1.hot, 0.5 * 0.5 * 1, 1e-12, "ball 1 hot");
  near(c1.overdue, 0.5 * 0.2 * 0.5, 1e-12, "ball 1 overdue");
  near(c1.recent, 0.5 * 0.3 * (D ** 3 + D ** 2), 1e-12, "ball 1 recent");
  // ball 41: normFreq 0.5, normGap 0, normRecent 1
  const w = unifiedWeights(s, 0.5);
  near(w[41], 1 + 0.5 * 0.5 * 0.5 + 0 + 0.5 * 0.3 * 1, 1e-12, "ball 41 Classic weight");
  // ball 61: never seen — normFreq 0, normGap 1 (gap = n sorts most overdue), normRecent 0
  near(w[61], 1 + 0 + 0.5 * 0.2 * 1 + 0, 1e-12, "ball 61 Classic weight");
});

await check("TINY: Maximum triples the tilt, bounds hold at every preset", () => {
  const s = oracleStats(TINY);
  const wMax = unifiedWeights(s, 2);
  near(wMax[41], 1 + 2 * 0.5 * 0.5 + 0 + 2 * 0.3 * 1, 1e-12, "ball 41 Maximum weight");
  near(wMax[61], 1 + 2 * 0.2 * 1, 1e-12, "ball 61 Maximum weight");
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(s, p.I);
    for (let b = 1; b <= POOL; b++) {
      ok(w[b] >= 1 && w[b] <= 1 + p.I + 1e-12,
        `${p.key}: w[${b}] = ${w[b]} outside the structural [1, ${1 + p.I}]`);
    }
  }
});

await check("zero-span signals tilt nothing: every weight exactly 1", () => {
  const flat = oracleStats({
    ...TINY,
    freq: new Array(80).fill(1), // Σ = 80 = 20 × 4 — identity holds
    lastSeenDrawsAgo: new Array(80).fill(0),
    decayedFreq: new Array(80).fill(1)
  });
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(flat, p.I);
    for (let b = 1; b <= POOL; b++) eq(w[b], 1, `${p.key} flat w[${b}]`);
  }
});

/* ----------------------------------------------------- stats validation */

await check("oracleStats rejects anything suspect, with actionable messages", () => {
  mustThrow(() => oracleStats(null), /missing/, "null");
  mustThrow(() => oracleStats({ ...TINY, schema: 1 }), /schema 1/, "old schema");
  mustThrow(() => oracleStats({ ...TINY, halfLifeDraws: undefined }), /halfLifeDraws/, "no half-life pin");
  mustThrow(() => oracleStats({ ...TINY, freq: TINY.freq.slice(0, 79) }), /freq/, "short freq");
  mustThrow(() => oracleStats({ ...TINY, freq: TINY.freq.map((v, i) => (i === 0 ? v + 1 : v)) }),
    /conservation identity/, "Σfreq ≠ 20n");
  mustThrow(() => oracleStats({ ...TINY, lastSeenDrawsAgo: band(2, 1, 0, -1) }), /lastSeen/, "negative gap");
  mustThrow(() => oracleStats({ ...TINY, dataThrough: "yesterday-ish" }), /dataThrough/, "bad stamp");
  mustThrow(() => tiltComponents(oracleStats(TINY), 1, 99), /intensity/, "silly intensity");
  mustThrow(() => tiltComponents(oracleStats(TINY), 1, 0), /intensity/, "zero intensity");
});

/* -------------------------------------------------- one-formatter law */

await check("the panel weight IS the sampling weight — strict ===, every preset", () => {
  const s = oracleStats(TINY);
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(s, p.I);
    for (let b = 1; b <= POOL; b++) {
      eq(ballReading(s, b, p.I).weight, w[b], `${p.key} ball ${b}`);
    }
  }
});

await check("the displayed weight equation always sums, drift < 0.015 from the true weight", () => {
  const s = oracleStats(TINY);
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(s, p.I);
    for (let b = 1; b <= POOL; b++) {
      const line = formatWeightLine(ballReading(s, b, p.I));
      const m = line.match(/^w (\d+\.\d{2}) = 1 \+ (\d+\.\d{2}) hot \+ (\d+\.\d{2}) overdue \+ (\d+\.\d{2}) recent$/);
      ok(m, `weight line shape: "${line}"`);
      near(+m[1], 1 + +m[2] + +m[3] + +m[4], 1e-9, "the equation must visibly add up");
      ok(Math.abs(+m[1] - w[b]) < 0.015, `displayed ${m[1]} vs true ${w[b]} — rounding, never divergence`);
    }
  }
});

/* --------------------------------------------------------- the Reading */

await check("z carries the 60/79 finite-population correction (collapses to n·p(1−p))", () => {
  const s = oracleStats(TINY);
  // n=4, perDraw = 80/4 = 20 by the identity, p = ¼.
  // variance = n·20·(1/80)(79/80) × 60/79 = n·¼·¾ = 0.75; sd = √0.75.
  const sd = Math.sqrt(0.75);
  near(ballReading(s, 1).z, (2 - 1) / sd, 1e-12, "ball 1 (freq 2)");
  near(ballReading(s, 61).z, (0 - 1) / sd, 1e-12, "ball 61 (freq 0)");
  near(ballReading(s, 41).z, 0, 1e-12, "ball 41 (freq 1 = expected)");
});

await check("gap percentile is the midrank over the pool (keno gaps tie heavily)", () => {
  const s = oracleStats(TINY);
  // gaps: 20× each of {2, 1, 0, 4(null→n)}
  eq(ballReading(s, 41).gapPercentile, 13, "gap 0: (0 + ½·20)/80 = 12.5 → 13");
  eq(ballReading(s, 21).gapPercentile, 38, "gap 1: (20 + 10)/80 = 37.5 → 38");
  eq(ballReading(s, 1).gapPercentile, 63, "gap 2: (40 + 10)/80 = 62.5 → 63");
  eq(ballReading(s, 61).gapPercentile, 88, "gap n: (60 + 10)/80 = 87.5 → 88");
});

await check("reading lines: exact strings on TINY (the one formatter, verbatim)", () => {
  const s = oracleStats(TINY);
  eq(tooltipText(s, 1), "drawn 2× · last seen 2 draws ago");
  eq(tooltipText(s, 41), "drawn 1× · last seen 0 draws ago");
  eq(tooltipText(s, 61), "drawn 0× · not yet seen");
  const [l1, l2, l3] = readingLines(s, 41, 0.5);
  eq(l1, "drawn 1× · last seen 0 draws ago");
  eq(l2, "expected 1.0× (z +0.0) · gap 13th percentile");
  eq(l3, "w 1.28 = 1 + 0.13 hot + 0.00 overdue + 0.15 recent");
  const neg = readingLines(s, 61, 0.5)[1];
  ok(neg.includes("(z −1.2)"), `true minus sign on negative z (got "${neg}")`);
});

await check("ordinal edge cases (11th–13th stay th)", () => {
  eq(ordinal(1), "1st"); eq(ordinal(2), "2nd"); eq(ordinal(3), "3rd");
  eq(ordinal(11), "11th"); eq(ordinal(12), "12th"); eq(ordinal(13), "13th");
  eq(ordinal(21), "21st"); eq(ordinal(63), "63rd"); eq(ordinal(88), "88th");
});

await check("reading header: preset, cap, n, span, data-through, live/archive badge", () => {
  const s = oracleStats(TINY);
  eq(readingHeader(s, "classic"),
    "Classic tilt (1.5× cap) · 4 draws over 0.0 yrs · data through 01 Jan 2026 00:08 UTC · archive");
  eq(readingHeader(s, "maximum", { live: true }),
    "Maximum tilt (3× cap) · 4 draws over 0.0 yrs · data through 01 Jan 2026 00:08 UTC · live");
  mustThrow(() => readingHeader(s, "bogus"), /unknown intensity preset/, "junk preset");
});

/* ------------------------------------------------------ live-draw merge */

const D5 = {
  drawingDate: "2026-01-01T00:10:40Z",
  ms: Date.parse("2026-01-01T00:10:40Z"),
  numbers: [1, ...Array.from({ length: 19 }, (_, i) => 61 + i)], // 1 + 61..79
  headsTails: "tails", jackpotLevel: "minor", bonusFactor: 5
};

await check("mergeStats: hand-checked fold of one live draw (pinned half-life honoured)", () => {
  const before = JSON.stringify(TINY);
  const m = mergeStats(TINY, [D5]);
  eq(JSON.stringify(TINY), before, "input must never be mutated");
  eq(m.n, 5);
  eq(m.dataThrough, D5.drawingDate);
  eq(m.freq[0], 3, "ball 1 hit again");
  eq(m.freq[60], 1, "ball 61 first hit");
  eq(m.freq[79], 0, "ball 80 still unseen");
  eq(m.freq.reduce((a, b) => a + b, 0), 5 * 20, "identity survives the merge");
  eq(m.lastSeenDrawsAgo[0], 0, "ball 1 reset");
  eq(m.lastSeenDrawsAgo[40], 1, "ball 41 aged by one draw");
  eq(m.lastSeenDrawsAgo[20], 2, "ball 21 aged by one draw");
  eq(m.lastSeenDrawsAgo[79], null, "ball 80 stays never-seen");
  // decay factor comes from TINY's OWN halfLifeDraws = 2 (d = 2^(−1/2)),
  // never a constant of this build — the in-file pin is the whole point.
  near(m.decayedFreq[0], (D ** 3 + D ** 2) * D + 1, 1e-12, "ball 1: aged then refreshed");
  near(m.decayedFreq[40], 1 * D, 1e-12, "ball 41: aged");
  near(m.decayedFreq[60], 1, 1e-12, "ball 61: fresh hit");
  eq(m.sideBets.headsTails.tails, 2);
  eq(m.sideBets.headsTails.heads, 3);
  eq(m.sideBets.jackpot.minor, 1);
  eq(m.sideBets.bonus[5], 1);
  ok(oracleStats(m), "merged stats must validate for the engine");
  eq(mergeStats(TINY, []), TINY, "empty merge returns the same object");
});

/* ------------------------------------------------------------ sampler */

function chiCrit999(df) {
  const z = 3.0902323061678132;
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + z * Math.sqrt(a), 3);
}

await check("pickWeighted output contract: sorted, unique, in range, right size", () => {
  const s = oracleStats(TINY);
  for (const p of INTENSITY_PRESETS) {
    for (const k of [1, 5, 10]) {
      const line = pickOracleLine(s, k, p.I);
      eq(line.length, k, `${p.key} k=${k} size`);
      eq(new Set(line).size, k, `${p.key} k=${k} unique`);
      ok(line.every((v, i) => v >= 1 && v <= POOL && (i === 0 || line[i - 1] < v)),
        `${p.key} k=${k} sorted in-range`);
    }
  }
  mustThrow(() => pickWeighted(0, unifiedWeights(s)), /outside 1\.\.80/, "k 0");
  mustThrow(() => pickWeighted(81, unifiedWeights(s)), /outside 1\.\.80/, "k 81");
  mustThrow(() => pickWeighted(2.5, unifiedWeights(s)), /outside 1\.\.80/, "fractional k");
});

await check("full-pool coverage: k = 80 returns every ball at every preset", () => {
  const s = oracleStats(TINY);
  for (const p of INTENSITY_PRESETS) {
    const line = pickOracleLine(s, POOL, p.I);
    eq(line.length, POOL, p.key);
    eq(line[0], 1); eq(line[POOL - 1], POOL);
  }
});

await check("k=1 sampling distribution matches the weight shares (chi², α=0.001) — TINY, all presets", () => {
  const s = oracleStats(TINY);
  const N = 100_000;
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(s, p.I);
    const total = w.reduce((a, b) => a + b, 0);
    const counts = new Array(POOL + 1).fill(0);
    for (let i = 0; i < N; i++) counts[pickOracleLine(s, 1, p.I)[0]]++;
    let chi2 = 0, uncovered = 0;
    for (let b = 1; b <= POOL; b++) {
      const expected = (N * w[b]) / total;
      chi2 += (counts[b] - expected) ** 2 / expected;
      if (counts[b] === 0) uncovered++;
    }
    eq(uncovered, 0, `${p.key}: every ball must appear at k=1 in ${N} draws`);
    ok(chi2 < chiCrit999(POOL - 1),
      `${p.key}: chi² ${chi2.toFixed(2)} ≥ crit999 ${chiCrit999(POOL - 1).toFixed(2)} — sampler does not follow its own weights`);
  }
});

/* --------------------------------------- against the SHIPPED stats.json */

const SHIPPED = JSON.parse(readFileSync(new URL("../data/stats.json", import.meta.url), "utf8"));

await check("shipped stats.json: validates, carries the lib half-life pin, bounds hold", () => {
  const s = oracleStats(SHIPPED);
  eq(SHIPPED.halfLifeDraws, HALF_LIFE_DRAWS, "the in-file pin IS the lib constant at build time");
  eq(SHIPPED.schema, 2);
  for (const p of INTENSITY_PRESETS) {
    const w = unifiedWeights(s, p.I);
    let lo = Infinity, hi = 0;
    for (let b = 1; b <= POOL; b++) { lo = Math.min(lo, w[b]); hi = Math.max(hi, w[b]); }
    ok(lo >= 1 && hi <= 1 + p.I + 1e-12, `${p.key}: shipped weights [${lo}, ${hi}] outside [1, ${1 + p.I}]`);
    ok(hi / lo <= 1 + p.I + 1e-12, `${p.key}: max/min ratio ${hi / lo} exceeds 1 + I`);
  }
});

await check("shipped stats.json: panel === sampler on the real archive, Classic + Maximum", () => {
  const s = oracleStats(SHIPPED);
  for (const I of [0.5, 2]) {
    const w = unifiedWeights(s, I);
    for (let b = 1; b <= POOL; b++) eq(ballReading(s, b, I).weight, w[b], `I=${I} ball ${b}`);
  }
});

await check("shipped stats.json: k=1 distribution follows the real weights (Classic + Maximum)", () => {
  const s = oracleStats(SHIPPED);
  const N = 100_000;
  for (const key of ["classic", "maximum"]) {
    const I = intensityOf(key);
    const w = unifiedWeights(s, I);
    const total = w.reduce((a, b) => a + b, 0);
    const counts = new Array(POOL + 1).fill(0);
    for (let i = 0; i < N; i++) counts[pickOracleLine(s, 1, I)[0]]++;
    let chi2 = 0;
    for (let b = 1; b <= POOL; b++) {
      const expected = (N * w[b]) / total;
      chi2 += (counts[b] - expected) ** 2 / expected;
    }
    ok(chi2 < chiCrit999(POOL - 1), `${key}: chi² ${chi2.toFixed(2)} on shipped weights`);
  }
});

/* ------------------------------------------------------------- flavour */

await check("flavour readings: hypergeometric reference for heads/tails, observed shares", () => {
  const f = flavourReadings(TINY);
  eq(f.n, 4);
  const heads = f.headsTails.find((r) => r.key === "heads");
  const evens = f.headsTails.find((r) => r.key === "evens");
  eq(heads.count, 3);
  near(heads.observed, 0.75, 1e-12);
  // P(evens) = C(40,10)²/C(80,20) ≈ 0.20334 — the audit prints the same maths
  near(evens.reference, 0.2033, 5e-4, "P(evens)");
  near(heads.reference, (1 - evens.reference) / 2, 1e-12, "heads/tails split the rest");
  const minor = f.jackpot.find((r) => r.key === "minor");
  eq(minor.count, 0);
  eq(minor.reference, null, "operator-scheduled: observed only");
  eq(f.bonus.find((r) => r.key === "10").count, 0);
  eq(pct1(0.398), "39.8%");
  eq(flavourReadings({ ...TINY, sideBets: null }), null, "no sideBets → no panel");
});

console.log(`\nOracle engine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
