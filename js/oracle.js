/* KenoGO Oracle — the Oracle blend engine. quickpick-au Mk II DESIGN, ported;
 * the era constants are keno's own (pool 80, drawn 20, half-life pinned
 * INSIDE stats.json — never re-declared here).
 *
 * The one formula (tiltComponents) is shared by the sampler AND the Reading
 * panel — the one-formatter law: what the panel prints IS what the sampler
 * used, asserted `===` in tests. Structural bounds instead of clamping:
 * each norm ∈ [0,1] and TILT_BLEND sums to exactly 1, so a ball's weight is
 * always in [1, 1+I] — no ball can be starved or excluded at any preset,
 * and the max/min ratio can never exceed 1+I.
 *
 * Selection stays on the CSPRNG: every random decision below is secureInt
 * (crypto.getRandomValues + rejection sampling). The blend only ever tilts
 * acceptance probabilities. Entertainment only — every combination of a spot
 * count has identical odds; the disclaimer is not negotiable.
 */

import { secureInt } from "../rng.js";
import { formatStamp } from "./live.js";

export const POOL = 80;
export const DRAWN = 20;

/** How the tilt budget divides between the three signals. Must sum to 1 so
 * the structural cap stays exactly 1 + I regardless of blend. (Mk II values,
 * unchanged — the blend is design, not an era constant.) */
export const TILT_BLEND = { hot: 0.5, overdue: 0.2, recent: 0.3 };

/** Intensity dial presets (Mk II values, unchanged). The cap IS 1 + I —
 * there is no separate clamp. Not a free slider, deliberately: each preset
 * has a measured adjacency offset and a parameterised weight-bound guard. */
export const INTENSITY_PRESETS = [
  { key: "subtle", I: 0.25, label: "Subtle" },
  { key: "classic", I: 0.5, label: "Classic" },
  { key: "strong", I: 1, label: "Strong" },
  { key: "maximum", I: 2, label: "Maximum" }
];
export const DEFAULT_INTENSITY = "classic";
export const MAX_INTENSITY = Math.max(...INTENSITY_PRESETS.map((p) => p.I));
export const CLASSIC_I = 0.5;

export function intensityPreset(key) {
  return INTENSITY_PRESETS.find((p) => p.key === key) ?? null;
}

/** Preset key → I. Throws on unknown — the caller owns the fallback. */
export function intensityOf(key) {
  const p = intensityPreset(key);
  if (!p) throw new RangeError(`unknown intensity preset "${key}"`);
  return p.I;
}

function assertIntensity(I) {
  if (!Number.isFinite(I) || I <= 0 || I > MAX_INTENSITY) {
    throw new RangeError(`intensity ${I} outside (0, ${MAX_INTENSITY}] — use an INTENSITY_PRESETS value`);
  }
}

/* ------------------------------------------------------ stats validation */

const isCountArray = (a, len) =>
  Array.isArray(a) && a.length === len && a.every((v) => Number.isInteger(v) && v >= 0);

/**
 * Validate a raw data/stats.json object and derive the engine's view.
 * Throws with an actionable message on anything suspect — the app catches
 * and degrades to plain CSPRNG picks with the Oracle panels hidden.
 *
 * The conservation identity Σfreq === n × 20 is a hard requirement: the
 * z-score derives balls-per-draw from it instead of trusting a constant,
 * so a stats file that breaks it is lying about something.
 */
export function oracleStats(raw) {
  if (!raw || typeof raw !== "object") throw new Error("stats missing or not an object");
  if (raw.schema !== 2) throw new Error(`stats schema ${raw.schema} — this build reads schema 2`);
  if (!Number.isInteger(raw.n) || raw.n <= 0) throw new Error(`bad stats n ${raw.n}`);
  if (!Number.isFinite(raw.halfLifeDraws) || raw.halfLifeDraws <= 0) {
    throw new Error("stats lack the pinned halfLifeDraws — decay math would drift from the Action's");
  }
  if (!isCountArray(raw.freq, POOL)) throw new Error("stats freq is not 80 non-negative counts");
  if (!Array.isArray(raw.lastSeenDrawsAgo) || raw.lastSeenDrawsAgo.length !== POOL ||
      !raw.lastSeenDrawsAgo.every((v) => v === null || (Number.isInteger(v) && v >= 0))) {
    throw new Error("stats lastSeenDrawsAgo is not 80 gaps (int or null)");
  }
  if (!Array.isArray(raw.decayedFreq) || raw.decayedFreq.length !== POOL ||
      !raw.decayedFreq.every((v) => Number.isFinite(v) && v >= 0)) {
    throw new Error("stats decayedFreq is not 80 non-negative numbers");
  }
  if (typeof raw.dataThrough !== "string" || Number.isNaN(Date.parse(raw.dataThrough))) {
    throw new Error(`bad stats dataThrough ${raw.dataThrough}`);
  }
  const freqTotal = raw.freq.reduce((a, b) => a + b, 0);
  if (freqTotal !== raw.n * DRAWN) {
    throw new Error(`stats break the conservation identity: Σfreq ${freqTotal} ≠ ${DRAWN} × ${raw.n}`);
  }

  // Never-seen sorts most overdue: gap = n (impossible at archive scale, but
  // the merge path must stay correct for any file it is handed).
  const gap = raw.lastSeenDrawsAgo.map((v) => (v === null ? raw.n : v));
  const recent = raw.decayedFreq;
  return {
    n: raw.n,
    firstDraw: raw.firstDraw,
    dataThrough: raw.dataThrough,
    halfLifeDraws: raw.halfLifeDraws,
    freq: raw.freq,
    gap,
    recent,
    freqTotal,
    minFreq: Math.min(...raw.freq), maxFreq: Math.max(...raw.freq),
    minGap: Math.min(...gap), maxGap: Math.max(...gap),
    minRecent: Math.min(...recent), maxRecent: Math.max(...recent),
    sideBets: raw.sideBets ?? null
  };
}

/* ------------------------------------------------------------- the blend */

/** Min–max normalisation with the zero-span guard: a flat signal tilts
 * nothing (all weights exactly 1) rather than dividing by zero. */
const norm = (v, lo, hi) => (hi - lo === 0 ? 0 : (v - lo) / (hi - lo));

/**
 * THE formula — the single source of truth for both the sampler and the
 * Reading panel. weight = 1 + hot + overdue + recent, each component
 * I × blend × norm(signal) ∈ [0, I × blend].
 */
export function tiltComponents(s, ball, intensity = CLASSIC_I) {
  assertIntensity(intensity);
  const i = ball - 1;
  return {
    hot: intensity * TILT_BLEND.hot * norm(s.freq[i], s.minFreq, s.maxFreq),
    overdue: intensity * TILT_BLEND.overdue * norm(s.gap[i], s.minGap, s.maxGap),
    recent: intensity * TILT_BLEND.recent * norm(s.recent[i], s.minRecent, s.maxRecent)
  };
}

/** Sampling weights, 1-indexed (w[0] unused) — w[n] ∈ [1, 1+I] structurally. */
export function unifiedWeights(s, intensity = CLASSIC_I) {
  const w = new Array(POOL + 1).fill(0);
  for (let ball = 1; ball <= POOL; ball++) {
    const c = tiltComponents(s, ball, intensity);
    w[ball] = 1 + c.hot + c.overdue + c.recent;
  }
  return w;
}

/* ------------------------------------------------------------ the sampler */

const ACCEPT_SCALE = 1 << 20;

/**
 * Weighted sampling without replacement: acceptance–rejection over the
 * crypto RNG (Mk II sampler, verbatim design). Propose uniformly with
 * secureInt(POOL); accept with probability w/wMax via a second secureInt
 * draw — unbiased up to 2^−20 threshold rounding. Acceptance rate is at
 * least 1/(1+I) ≥ 1/3 even at Maximum; the guard is unreachable-in-theory
 * insurance, never a code path.
 */
export function pickWeighted(k, w, label = "pickWeighted") {
  if (!Number.isInteger(k) || k < 1 || k > POOL) {
    throw new RangeError(`${label}: k ${k} outside 1..${POOL}`);
  }
  let wMax = 0;
  for (let ball = 1; ball <= POOL; ball++) if (w[ball] > wMax) wMax = w[ball];
  if (!(wMax > 0)) throw new RangeError(`${label}: weights are empty`);
  const picked = new Set();
  let guard = 0;
  while (picked.size < k) {
    if (++guard > 1_000_000) throw new Error(`${label}: rejection sampling did not converge`);
    const ball = 1 + secureInt(POOL);
    if (picked.has(ball)) continue;
    const threshold = Math.round((w[ball] / wMax) * ACCEPT_SCALE);
    if (secureInt(ACCEPT_SCALE) < threshold) picked.add(ball);
  }
  return [...picked].sort((a, b) => a - b);
}

/** One Oracle line: k spots tilted by the preset intensity. */
export function pickOracleLine(s, k, intensity = CLASSIC_I) {
  return pickWeighted(k, unifiedWeights(s, intensity), "pickOracleLine");
}

/* ------------------------------------------------------------ the Reading */

/**
 * Everything the panel shows for one ball. `weight` is the sampling weight,
 * recomputed from the SAME tiltComponents the sampler used.
 *
 * z-score: balls-per-draw comes from the conservation identity
 * (Σfreq / n = 20 — validated at load, never a trusted constant), so
 * p = perDraw/POOL = 1/4. The variance starts from the ball-slot binomial
 * n·perDraw·q(1−q) with q = 1/POOL and applies the FINITE-POPULATION
 * CORRECTION for drawing 20-of-80 without replacement,
 * (POOL−perDraw)/(POOL−1) = 60/79 — the same correction the repo's
 * chi-square convention pins. The product collapses to the exact
 * hypergeometric marginal n·p(1−p):
 *   n·20·(1/80)(79/80) × 60/79 = n·(20/80)(60/80) = n·¼·¾.
 */
export function ballReading(s, ball, intensity = CLASSIC_I) {
  const components = tiltComponents(s, ball, intensity);
  const perDraw = s.freqTotal / s.n; // = 20 by the validated identity
  const q = 1 / POOL;
  const expected = s.n * perDraw * q;
  const fpc = (POOL - perDraw) / (POOL - 1); // 60/79
  const sd = Math.sqrt(s.n * perDraw * q * (1 - q) * fpc);
  const z = sd === 0 ? 0 : (s.freq[ball - 1] - expected) / sd;
  let below = 0, equal = 0;
  for (let i = 0; i < POOL; i++) {
    if (s.gap[i] < s.gap[ball - 1]) below++;
    else if (s.gap[i] === s.gap[ball - 1]) equal++;
  }
  return {
    n: ball,
    freq: s.freq[ball - 1],
    gap: s.gap[ball - 1],
    expected,
    z,
    // Midrank percentile over the pool. Keno gaps are dense (20 balls sit at
    // gap 0 after every draw), so the ½·equal midrank term carries real
    // weight here — far more than in a lotto pool.
    gapPercentile: Math.round((100 * (below + 0.5 * equal)) / POOL),
    components,
    weight: 1 + components.hot + components.overdue + components.recent
  };
}

const fmtInt = (v) => v.toLocaleString("en-AU");

export function ordinal(v) {
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[v % 10] ?? "th";
  return `${v}${suffix}`;
}

/** One decimal, true minus sign (U+2212), explicit +. */
const signed1 = (v) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`;

/** Panel line 1 — also the pill tooltip. ONE formatter, no drift. */
export function tooltipText(s, ball) {
  const r = ballReading(s, ball);
  const seen = r.gap >= s.n ? "not yet seen" : `last seen ${fmtInt(r.gap)} draw${r.gap === 1 ? "" : "s"} ago`;
  return `drawn ${fmtInt(r.freq)}× · ${seen}`;
}

/**
 * The displayed weight is 1 + Σ(rounded components), so the equation always
 * visibly adds up; display drift from the true sampling weight is bounded by
 * 3 × 0.005 = 0.015 (rounding, never divergence — tests pin both).
 */
export function formatWeightLine(reading) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const hot = r2(reading.components.hot);
  const overdue = r2(reading.components.overdue);
  const recent = r2(reading.components.recent);
  return `w ${(1 + hot + overdue + recent).toFixed(2)} = 1 + ${hot.toFixed(2)} hot` +
    ` + ${overdue.toFixed(2)} overdue + ${recent.toFixed(2)} recent`;
}

/** The three Reading lines for one ball. */
export function readingLines(s, ball, intensity = CLASSIC_I) {
  const r = ballReading(s, ball, intensity);
  return [
    tooltipText(s, ball),
    `expected ${r.expected.toFixed(1)}× (z ${signed1(r.z)}) · gap ${ordinal(r.gapPercentile)} percentile`,
    formatWeightLine(r)
  ];
}

const YEAR_MS = 31_557_600_000; // Julian year, matching quickpick's span math

/** Header: preset + cap, n, span, data-through, live/archive badge. */
export function readingHeader(s, presetKey, { live = false } = {}) {
  const preset = intensityPreset(presetKey);
  if (!preset) throw new RangeError(`unknown intensity preset "${presetKey}"`);
  const cap = `${+(1 + preset.I).toFixed(2)}×`;
  const yrs = ((Date.parse(s.dataThrough) - Date.parse(s.firstDraw)) / YEAR_MS).toFixed(1);
  return `${preset.label} tilt (${cap} cap) · ${fmtInt(s.n)} draws over ${yrs} yrs · ` +
    `data through ${formatStamp(s.dataThrough)} · ${live ? "live" : "archive"}`;
}

/* -------------------------------------------------------- live-draw merge */

/**
 * Fold freshly fetched draws (ascending, already validated by live.js) into
 * a RAW stats object, returning a NEW raw stats object — the input is never
 * mutated, so "archive" and "merged" can coexist. Decay uses THE PINNED
 * stats.halfLifeDraws — whichever file the client holds, its own half-life
 * travels with it, so client and Action can never disagree.
 *
 * Draw ages are counted in ARRIVED draws. If the API window has a hole
 * (a not-yet-published slot), gaps run marginally short until the next
 * 6-hourly archive rebuild corrects the record — display-and-entertainment
 * tolerance, never archive truth.
 */
export function mergeStats(raw, draws) {
  if (!draws.length) return raw;
  const d = Math.pow(0.5, 1 / raw.halfLifeDraws);
  const freq = raw.freq.slice();
  const decayed = raw.decayedFreq.slice();
  const gap = raw.lastSeenDrawsAgo.slice();
  const sideBets = raw.sideBets ? {
    headsTails: { ...raw.sideBets.headsTails },
    jackpot: { ...raw.sideBets.jackpot },
    bonus: { ...raw.sideBets.bonus }
  } : null;
  let n = raw.n;
  let through = raw.dataThrough;

  for (const rec of draws) {
    for (let i = 0; i < POOL; i++) {
      decayed[i] *= d;
      if (gap[i] !== null) gap[i]++;
    }
    for (const ball of rec.numbers) {
      freq[ball - 1]++;
      decayed[ball - 1] += 1;
      gap[ball - 1] = 0;
    }
    if (sideBets) {
      sideBets.headsTails[rec.headsTails]++;
      sideBets.jackpot[rec.jackpotLevel]++;
      sideBets.bonus[rec.bonusFactor]++;
    }
    n++;
    through = rec.drawingDate;
  }

  return { ...raw, n, dataThrough: through, freq, lastSeenDrawsAgo: gap, decayedFreq: decayed, sideBets };
}

/* --------------------------------------------- side-bet flavour (display) */

/** C(n, k) — exact enough in doubles for the hypergeometric reference. */
function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * DISPLAY-ONLY archive flavour: observed side-bet shares vs the exact
 * hypergeometric reference where one exists. Heads/tails/evens have a
 * mathematical truth (P(evens) = C(40,10)²/C(80,20); heads and tails split
 * the rest evenly — the audit prints the same reference). Jackpot level and
 * bonus factor are operator-scheduled, so they get observed shares only.
 * NONE of this ever feeds weights.
 */
export function flavourReadings(raw) {
  const sb = raw.sideBets;
  if (!sb) return null;
  const n = raw.n;
  const pEvens = (choose(40, 10) ** 2) / choose(80, 20);
  const pSide = (1 - pEvens) / 2;
  const share = (c) => (n === 0 ? 0 : c / n);
  return {
    n,
    headsTails: [
      { key: "heads", label: "Heads (1–40 majority)", count: sb.headsTails.heads, observed: share(sb.headsTails.heads), reference: pSide },
      { key: "tails", label: "Tails (41–80 majority)", count: sb.headsTails.tails, observed: share(sb.headsTails.tails), reference: pSide },
      { key: "evens", label: "Evens (10–10 split)", count: sb.headsTails.evens, observed: share(sb.headsTails.evens), reference: pEvens }
    ],
    jackpot: ["regular", "minor", "major"].map((key) => ({
      key, label: key[0].toUpperCase() + key.slice(1), count: sb.jackpot[key], observed: share(sb.jackpot[key]), reference: null
    })),
    bonus: [1, 2, 3, 4, 5, 10].map((key) => ({
      key: String(key), label: `×${key}`, count: sb.bonus[key], observed: share(sb.bonus[key]), reference: null
    }))
  };
}

/** "39.8%" — one decimal, the flavour panel's single number format. */
export const pct1 = (share) => `${(100 * share).toFixed(1)}%`;
