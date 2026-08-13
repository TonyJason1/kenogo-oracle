/* KenoGO Oracle — app logic. Selection is ALWAYS the CSPRNG (rng.js);
 * the Oracle blend only tilts acceptance probabilities inside it, and when
 * stats are unavailable picks degrade to plain uniform crypto-random. The
 * 80-ball chamber is presentation only, and under frame pressure it
 * degrades its BALL COUNT, never the selection. Entertainment only — every
 * combination of your spot count has identical odds. */
import { drawLine, shuffled } from "./rng.js";
import { clearHistory, loadHistory, saveHistory } from "./js/history.js";
import { pillsHTML, revealBall, revealRemaining } from "./js/reveal.js";
import { initFooter } from "./js/live.js";
import {
  DEFAULT_INTENSITY, INTENSITY_PRESETS, flavourReadings, intensityOf,
  intensityPreset, mergeStats, oracleStats, pct1, pickOracleLine,
  readingHeader, readingLines
} from "./js/oracle.js";

/* ---------------------------------------------------------------- game */
const POOL = 80;
const SPOTS_MIN = 1, SPOTS_MAX = 10, SPOTS_DEFAULT = 10;
const LINES_MIN = 1, LINES_MAX = 10, LINES_DEFAULT = 1;
const ACCENT = "#ffb02e";

/* ---------------------------------------------------------------- state */
const PREFS_KEY = "kg_prefs_v1";

const state = {
  spots: SPOTS_DEFAULT,
  lines: LINES_DEFAULT,
  intensity: DEFAULT_INTENSITY, // the ONE Oracle dial (single game)
  fastReveal: false,     // skip the chamber — results land instantly
  animating: false
};

/* Prefs are salvaged FIELD BY FIELD (quickpick-au M6 doctrine): each field
 * validates independently and falls back alone, so one corrupt key can never
 * discard the rest. Reading prefs must never throw into module init. */
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
  if (saved && typeof saved === "object") {
    if (Number.isInteger(saved.spots)) state.spots = clamp(saved.spots, SPOTS_MIN, SPOTS_MAX);
    if (Number.isInteger(saved.lines)) state.lines = clamp(saved.lines, LINES_MIN, LINES_MAX);
    if (typeof saved.intensity === "string" && intensityPreset(saved.intensity)) {
      state.intensity = saved.intensity; // unknown preset → default, not fatal
    }
    state.fastReveal = saved.fastReveal === true;
  }
} catch { /* fresh start */ }

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      spots: state.spots, lines: state.lines, intensity: state.intensity,
      fastReveal: state.fastReveal
    }));
  } catch { /* storage full/blocked — non-fatal */ }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* ------------------------------------------------------------- elements */
const $ = (id) => document.getElementById(id);
const els = {
  chamber: $("chamber"), skipHint: $("skipHint"), fastReveal: $("fastReveal"),
  spotsVal: $("spotsVal"), linesVal: $("linesVal"), pickControls: $("pickControls"),
  matrixLine: $("matrixLine"), resultsCard: $("resultsCard"), resultsList: $("resultsList"),
  copyAllBtn: $("copyAllBtn"), historyBox: $("historyBox"), historyList: $("historyList"),
  historyCount: $("historyCount"), clearHistoryBtn: $("clearHistoryBtn"), drawBtn: $("drawBtn"),
  revealStatus: $("revealStatus"), dataThrough: $("dataThrough"),
  intensityDial: $("intensityDial"), oracleStatus: $("oracleStatus"),
  readingBox: $("readingBox"), readingHead: $("readingHead"), readingList: $("readingList"),
  flavourBox: $("flavourBox"), flavourList: $("flavourList")
};

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------- ball chamber */
/* Physics inherited from quickpick-au; keno-specific addition is the visual
 * cap ladder. Ball–ball collision is O(n²) — 80 balls is 3,160 pairs per
 * substep, fine on a healthy frame budget and measurable when it is not. */
class Chamber {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.balls = [];
    this.count = 0;
    this.color = ACCENT;
    this.mixUntil = 0;
    this.dpr = 1;
    this.w = 0; this.h = 0; this.r = 14;
    this.visualCap = POOL;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const cw = this.canvas.clientWidth || 320;
    const ch = this.canvas.clientHeight || 240;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cw * this.dpr);
    this.canvas.height = Math.round(ch * this.dpr);
    this.w = cw; this.h = ch;
    this.computeRadius();
    if (this.balls.length) this.containAll();
    this.renderOnce();
  }

  computeRadius() {
    const n = Math.max(1, Math.min(this.count, this.visualCap));
    const fill = 0.42; // fraction of chamber area occupied by balls
    this.r = clamp(Math.sqrt((this.w * this.h * fill) / (n * Math.PI)), 9, 21);
  }

  setPool(count, color) {
    this.count = count;
    this.color = color;
    this.computeRadius();
    this.reset();
  }

  /** Evenly-spread sample of ball numbers when the visual cap is active.
   * Presentation only: a drawn ball missing from the chamber still reveals
   * (extract resolves immediately), the pace comes from the release cadence. */
  visibleNumbers() {
    const m = Math.min(this.count, this.visualCap);
    if (m >= this.count) return Array.from({ length: this.count }, (_, i) => i + 1);
    const nums = [];
    for (let i = 0; i < m; i++) nums.push(1 + Math.floor(i * this.count / m));
    return nums;
  }

  reset() {
    this.balls = [];
    const r = this.r;
    const perRow = Math.max(1, Math.floor((this.w - 2 * r) / (2 * r + 2)));
    const nums = this.visibleNumbers();
    for (let i = 0; i < nums.length; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      this.balls.push({
        n: nums[i],
        x: clamp(r + 2 + col * (2 * r + 2) + (row % 2) * r, r, this.w - r),
        y: this.h - r - 1 - row * (2 * r + 1),
        vx: (Math.random() - 0.5) * 40,
        vy: 0,
        extracted: false,
        resolve: null
      });
    }
    this.renderOnce();
  }

  /** Live pressure relief: drop non-extracted balls above the new cap NOW.
   * Never touches extracted balls (their promises must still resolve). */
  applyCap(cap) {
    this.visualCap = cap;
    if (this.balls.length > cap) {
      const extracted = this.balls.filter((b) => b.extracted);
      const rest = this.balls.filter((b) => !b.extracted).slice(0, Math.max(0, cap - extracted.length));
      this.balls = [...extracted, ...rest];
    }
    this.computeRadius();
  }

  containAll() {
    for (const b of this.balls) {
      b.x = clamp(b.x, this.r, this.w - this.r);
      b.y = clamp(b.y, this.r, this.h - this.r);
    }
  }

  mixing() { return performance.now() < this.mixUntil; }

  step(dt) {
    const r = this.r, w = this.w, h = this.h;
    const G = 1500 * (h / 380);
    const mixing = this.mixing();
    const gate = { x: w / 2, y: h - r * 0.4 };

    for (const b of this.balls) {
      if (b.extracted) {
        // Steer to gate, ignore gravity + collisions. Stronger pull + a wider
        // capture circle than quickpick: with 80 balls the radius is smaller
        // and the crowd deeper, and a 10-spot line at lazy travel speed was
        // measured at 12.6 s end-to-end — the release cadence, not the
        // physics, should set the pace.
        const dx = gate.x - b.x, dy = gate.y - b.y;
        b.vx += dx * 55 * dt; b.vy += dy * 55 * dt;
        b.vx *= 0.88; b.vy *= 0.88;
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (dx * dx + dy * dy < r * r * 2.25) this.capture(b);
        continue;
      }
      b.vy += G * dt;
      if (mixing) {
        b.vx += (Math.random() - 0.5) * 2600 * dt;
        b.vy += (Math.random() - 0.5) * 1600 * dt;
        if (b.y > h * 0.55) b.vy -= (1900 + Math.random() * 2100) * dt; // bottom blower
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // walls
      if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * 0.82; }
      else if (b.x > w - r) { b.x = w - r; b.vx = -Math.abs(b.vx) * 0.82; }
      if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * 0.82; }
      else if (b.y > h - r) { b.y = h - r; b.vy = -Math.abs(b.vy) * 0.82; b.vx *= 0.985; }
    }

    // elastic ball–ball collisions (equal mass)
    const bs = this.balls, len = bs.length, d2min = (2 * r) * (2 * r);
    for (let i = 0; i < len; i++) {
      const a = bs[i];
      if (a.extracted) continue;
      for (let j = i + 1; j < len; j++) {
        const c = bs[j];
        if (c.extracted) continue;
        let dx = c.x - a.x, dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= d2min || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const overlap = 2 * r - d;
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
        c.x += nx * overlap * 0.5; c.y += ny * overlap * 0.5;
        const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -(1 + 0.92) * vn * 0.5; // restitution 0.92, equal mass
          a.vx -= imp * nx; a.vy -= imp * ny;
          c.vx += imp * nx; c.vy += imp * ny;
        }
      }
    }
  }

  capture(b) {
    const res = b.resolve;
    b.resolve = null;
    this.balls = this.balls.filter((x) => x !== b);
    if (res) res();
  }

  /** Promise resolves when ball `n` reaches the gate (or instantly when the
   * visual cap has removed it — the reveal cadence is the caller's sleep). */
  extract(n) {
    return new Promise((resolve) => {
      const b = this.balls.find((x) => x.n === n);
      if (!b) { resolve(); return; }
      b.extracted = true;
      b.resolve = resolve;
      setTimeout(() => { if (b.resolve) this.capture(b); }, 900); // never stall
    });
  }

  flushExtractions() {
    for (const b of [...this.balls]) if (b.extracted) this.capture(b);
  }

  render() {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    // gate slot
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.roundRect(this.w / 2 - this.r * 1.6, this.h - 5, this.r * 3.2, 5, 3);
    ctx.fill();
    for (const b of this.balls) this.drawBall(ctx, b);
  }

  drawBall(ctx, b) {
    const r = this.r;
    const grad = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, r * 0.15, b.x, b.y, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.72, "#f4ead2");
    grad.addColorStop(1, "#e3cb96");
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.13);
    ctx.strokeStyle = this.color;
    ctx.stroke();
    ctx.fillStyle = "#201302";
    ctx.font = `800 ${Math.round(r * 0.92)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.n), b.x, b.y + r * 0.05);
  }

  renderOnce() { if (this.ctx) this.render(); }
}

const chamber = new Chamber(els.chamber);

/* --------------------------------------------------- animation driver */
/* Frame governor: EMA of the frame interval decides the chamber's visual
 * ball cap. Degrading drops balls IMMEDIATELY (pressure relief mid-draw);
 * recovering waits for the next setPool so a run never thrashes. Selection
 * is untouched at every rung — this is presentation-only by construction. */
const CAP_LADDER = [POOL, 64, 48, 36, 28];
const DEGRADE_MS = 26;   // sustained worse-than-~38fps
const RECOVER_MS = 20;   // sustained healthy 60 Hz (16.7 ms + jitter)
const DEGRADE_FRAMES = 90, RECOVER_FRAMES = 600;

const governor = {
  emaMs: 16.7, rung: 0, pendingRaise: false, slow: 0, fastCount: 0,
  frame(dtMs) {
    this.emaMs = 0.9 * this.emaMs + 0.1 * dtMs;
    if (this.emaMs > DEGRADE_MS) {
      if (++this.slow >= DEGRADE_FRAMES && this.rung < CAP_LADDER.length - 1) {
        this.rung++;
        this.slow = 0;
        chamber.applyCap(CAP_LADDER[this.rung]);
      }
    } else this.slow = 0;
    if (this.emaMs < RECOVER_MS && this.rung > 0) {
      if (++this.fastCount >= RECOVER_FRAMES) {
        this.rung--;
        this.fastCount = 0;
        this.pendingRaise = true; // applied at the next setPool
      }
    } else this.fastCount = 0;
  },
  capForNextPool() {
    if (this.pendingRaise) {
      this.pendingRaise = false;
      chamber.visualCap = CAP_LADDER[this.rung];
    }
    return chamber.visualCap;
  }
};
/* Telemetry hook for the perf harness (scripts/perf-profile.mjs).
 * simulateFrames drives the REAL governor with synthetic frame intervals so
 * the degrade ladder can be exercised on hardware too fast to trigger it —
 * presentation-only machinery, selection untouched by construction. */
window.__kenogoPerf = {
  get emaMs() { return governor.emaMs; },
  get cap() { return CAP_LADDER[governor.rung]; },
  get balls() { return chamber.balls.length; },
  simulateFrames(dtMs, n) { for (let i = 0; i < n; i++) governor.frame(dtMs); }
};

let rafId = 0, lastT = 0;
function tick(t) {
  const dtMs = Math.min(64, t - lastT || 16.7);
  lastT = t;
  governor.frame(dtMs);
  const dt = Math.min(0.032, dtMs / 1000);
  // two substeps for stability
  chamber.step(dt / 2); chamber.step(dt / 2);
  chamber.render();
  rafId = requestAnimationFrame(tick);
}
function startLoop() {
  if (!rafId && !reduceMotion.matches && document.visibilityState === "visible") {
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}
function stopLoop() { cancelAnimationFrame(rafId); rafId = 0; }
document.addEventListener("visibilitychange", () =>
  document.visibilityState === "visible" ? startLoop() : stopLoop()
);
reduceMotion.addEventListener?.("change", () => {
  reduceMotion.matches ? (stopLoop(), chamber.renderOnce()) : startLoop();
});

/* ----------------------------------------------------------- controls */
/** Keep a role="spinbutton" value span announceable when it changes. */
function setSpin(el, value, min, max) {
  el.textContent = String(value);
  el.setAttribute("aria-valuenow", String(value));
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));
}

function syncControls() {
  setSpin(els.spotsVal, state.spots, SPOTS_MIN, SPOTS_MAX);
  setSpin(els.linesVal, state.lines, LINES_MIN, LINES_MAX);
  for (const btn of els.pickControls.querySelectorAll(".step-btn")) {
    const dir = parseInt(btn.dataset.dir, 10);
    const [v, lo, hi] = btn.dataset.q === "spots"
      ? [state.spots, SPOTS_MIN, SPOTS_MAX]
      : [state.lines, LINES_MIN, LINES_MAX];
    btn.disabled = dir < 0 ? v <= lo : v >= hi;
  }
  els.matrixLine.textContent =
    `${state.spots} spot${state.spots > 1 ? "s" : ""} from 1–${POOL} · drawn 20-from-80 every 160 s`;
}

function stepQty(which, dir, jump = null) {
  const [lo, hi] = which === "spots" ? [SPOTS_MIN, SPOTS_MAX] : [LINES_MIN, LINES_MAX];
  const current = which === "spots" ? state.spots : state.lines;
  const next = jump === "min" ? lo : jump === "max" ? hi : clamp(current + dir, lo, hi);
  if (which === "spots") state.spots = next;
  else state.lines = next;
  savePrefs();
  syncControls();
}

/** Arrow/Home/End on a spinbutton, as the role promises. */
function wireSpin(el, which) {
  el.addEventListener("keydown", (e) => {
    const dir =
      e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 :
      e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    const jump = e.key === "Home" ? "min" : e.key === "End" ? "max" : null;
    if (!dir && !jump) return;
    e.preventDefault();
    if (state.animating) return;
    stepQty(which, dir, jump);
  });
}
wireSpin(els.spotsVal, "spots");
wireSpin(els.linesVal, "lines");

// steppers (with press-and-hold repeat)
for (const btn of els.pickControls.querySelectorAll(".step-btn")) {
  const which = btn.dataset.q;
  const dir = parseInt(btn.dataset.dir, 10);
  let holdT = 0, repT = 0;
  const fire = () => { if (!state.animating) stepQty(which, dir); };
  btn.addEventListener("click", fire);
  btn.addEventListener("pointerdown", () => {
    holdT = setTimeout(() => { repT = setInterval(fire, 90); }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    btn.addEventListener(ev, () => { clearTimeout(holdT); clearInterval(repT); });
  }
}

/* ------------------------------------------------------------- oracle */
/* ONE data state, shared by the footer, the Reading panel and the sampler
 * (the one-formatter law needs one state to format). `raw` is the
 * stats.json shape (archive, or archive + live merge); `prepared` is the
 * validated engine view, null when the Oracle must degrade to plain
 * uniform crypto picks. */
const oracle = { raw: null, prepared: null, live: false, error: null };

function setOracleData(raw, live) {
  oracle.raw = raw;
  oracle.live = live;
  try {
    oracle.prepared = oracleStats(raw);
    oracle.error = null;
  } catch (err) {
    oracle.prepared = null;
    oracle.error = err.message;
    console.error(`oracle disabled: ${err.message}`);
  }
  syncOracleStatus();
  renderFlavour();
}

function syncOracleStatus() {
  if (!els.oracleStatus) return;
  if (oracle.prepared) {
    els.oracleStatus.textContent =
      `blend over ${oracle.prepared.n.toLocaleString("en-AU")} draws${oracle.live ? " · live" : ""}`;
  } else {
    els.oracleStatus.textContent = "no stats yet — picks are plain crypto-random";
  }
}

/* The intensity dial: a radiogroup built FROM the preset constants so the
 * markup can never disagree with the engine. Roving tabindex; Arrow/Home/
 * End as the role promises. Changing it mid-animation affects the NEXT
 * draw — the spec is captured at draw time. */
function buildIntensityDial() {
  els.intensityDial.innerHTML = "";
  for (const p of INTENSITY_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dial-btn";
    btn.dataset.key = p.key;
    btn.setAttribute("role", "radio");
    btn.innerHTML = `<span class="dial-name"></span><span class="dial-cap"></span>`;
    btn.querySelector(".dial-name").textContent = p.label;
    btn.querySelector(".dial-cap").textContent = `${+(1 + p.I).toFixed(2)}× cap`;
    btn.addEventListener("click", () => setIntensity(p.key));
    els.intensityDial.appendChild(btn);
  }
  els.intensityDial.addEventListener("keydown", (e) => {
    const keys = INTENSITY_PRESETS.map((p) => p.key);
    const at = keys.indexOf(state.intensity);
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? Math.min(keys.length - 1, at + 1) :
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? Math.max(0, at - 1) :
      e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : -1;
    if (to === -1 || to === at) return;
    e.preventDefault();
    setIntensity(keys[to]);
    els.intensityDial.querySelector(`[data-key="${keys[to]}"]`)?.focus();
  });
  syncIntensityDial();
}

function syncIntensityDial() {
  for (const btn of els.intensityDial.querySelectorAll(".dial-btn")) {
    const on = btn.dataset.key === state.intensity;
    btn.setAttribute("aria-checked", String(on));
    btn.tabIndex = on ? 0 : -1;
  }
}

function setIntensity(key) {
  if (!intensityPreset(key)) return;
  state.intensity = key;
  savePrefs();
  syncIntensityDial();
}

/* Side-bet flavour: DISPLAY-ONLY archive shares (never feeds weights).
 * Heads/tails/evens carry the exact hypergeometric reference; jackpot level
 * and bonus factor are operator-scheduled, so observed shares only. */
function renderFlavour() {
  const f = oracle.raw ? flavourReadings(oracle.raw) : null;
  if (!f) { els.flavourBox.hidden = true; return; }
  els.flavourList.innerHTML = "";
  const group = (title, rows) => {
    const h = document.createElement("p");
    h.className = "f-group";
    h.textContent = title;
    els.flavourList.appendChild(h);
    for (const r of rows) {
      const div = document.createElement("div");
      div.className = "f-row";
      div.innerHTML = `<span class="f-label"></span><span class="f-obs spec"></span><span class="f-ref"></span>`;
      div.querySelector(".f-label").textContent = r.label;
      div.querySelector(".f-obs").textContent = pct1(r.observed);
      div.querySelector(".f-ref").textContent =
        r.reference !== null ? `maths ${pct1(r.reference)}` : `${r.count.toLocaleString("en-AU")}×`;
      els.flavourList.appendChild(div);
    }
  };
  group("Heads or Tails — observed vs the maths", f.headsTails);
  group("Jackpot level — observed", f.jackpot);
  group(`Bonus factor — observed (n = ${f.n.toLocaleString("en-AU")})`, f.bonus);
  els.flavourBox.hidden = false;
}

/* -------------------------------------------------------------- draw */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let skipRequested = false;

/* Tap ANYWHERE — or press Escape — to cut a running reveal straight to the
 * results. Guarded on state.animating, so idle taps change nothing. */
document.addEventListener("pointerdown", () => { if (state.animating) skipRequested = true; });
document.addEventListener("keydown", (e) => {
  if (state.animating && e.key === "Escape") skipRequested = true;
});

// Fast reveal: persisted; read at draw time, so flipping it mid-animation
// affects the next draw, not the one in flight.
els.fastReveal.checked = state.fastReveal;
els.fastReveal.addEventListener("change", () => {
  state.fastReveal = els.fastReveal.checked;
  savePrefs();
});

els.drawBtn.addEventListener("click", onDraw);

async function onDraw() {
  if (state.animating) return;
  const spots = state.spots;

  // The draw spec is CAPTURED NOW — dial moves or live top-ups landing
  // after this instant describe the NEXT draw, never this one. The Reading
  // must describe the weights THIS draw actually used.
  const spec = oracle.prepared
    ? { intensityKey: state.intensity, stats: oracle.prepared, live: oracle.live }
    : null;

  // 1) Selection — CSPRNG first, always. The Oracle path tilts acceptance
  //    inside the same CSPRNG; without stats it IS plain drawLine.
  const lines = [];
  for (let i = 0; i < state.lines; i++) {
    lines.push({
      nums: spec
        ? pickOracleLine(spec.stats, spots, intensityOf(spec.intensityKey))
        : drawLine(POOL, spots)
    });
  }

  pushHistory(spots, lines, spec);
  renderHistory();

  const instant = reduceMotion.matches || state.fastReveal;
  renderResults(spots, lines, !instant);
  if (instant) {
    chamber.renderOnce();
    announceDraw(spots, lines);
    renderReading(spec, lines[0]);
    return;
  }

  // 2) Presentation — animate line 1 only.
  state.animating = true;
  skipRequested = false;
  els.drawBtn.disabled = true;
  els.skipHint.hidden = false;
  startLoop();

  try {
    await animateLine(chamber, lines[0].nums);
    if (skipRequested) revealRemaining(lineOne(), lines[0]);
  } finally {
    chamber.flushExtractions();
    revealRemaining(lineOne(), lines[0]); // guarantee nothing stays hidden
    announceDraw(spots, lines);
    renderReading(spec, lines[0]); // after the reveal — the panel must not spoil it
    state.animating = false;
    els.drawBtn.disabled = false;
    els.skipHint.hidden = true;
    governor.capForNextPool();
    chamber.setPool(POOL, ACCENT); // refresh for the next draw
  }
}

async function animateLine(ch, nums) {
  ch.mixUntil = performance.now() + 1500; // vigorous mixing
  let waited = 0;
  while (waited < 1500 && !skipRequested) { await sleep(50); waited += 50; }
  if (skipRequested) return;

  for (const n of shuffled(nums)) {           // release order is cosmetic
    if (skipRequested) return;
    const t0 = performance.now();
    await ch.extract(n);                       // physics travel to gate
    revealBall(lineOne(), n);
    navigator.vibrate?.(30);
    const remaining = 400 - (performance.now() - t0); // ~400ms cadence
    if (remaining > 0) await sleep(remaining);
  }
}

/* ------------------------------------------------------------ results */
let lastDraw = null; // { spots, lines }

const lineText = (line) => line.nums.join(" ");
const lineOne = () => els.resultsList.querySelector('.line[data-idx="0"]');

function renderResults(spots, lines, animateFirst) {
  lastDraw = { spots, lines };
  els.resultsCard.hidden = false;
  els.resultsList.innerHTML = "";
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "line";
    row.dataset.idx = String(i);
    const ph = animateFirst && i === 0;
    row.innerHTML =
      `<span class="line-no">${i + 1}</span>` +
      `<span class="pills">${pillsHTML(line, { placeholder: ph })}</span>` +
      `<button type="button" class="copy-btn" aria-label="Copy line ${i + 1}">⧉</button>`;
    row.querySelector(".copy-btn").addEventListener("click", (e) =>
      copyText(lineText(line), e.currentTarget)
    );
    els.resultsList.appendChild(row);
  });
  if (!animateFirst) return;
  els.resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* The Reading: per-ball count, corrected z, gap percentile and the weight
 * equation — every number from the SAME functions the sampler used (the
 * one-formatter law). Filled only after the reveal completes, so it cannot
 * spoil line 1. Hidden entirely for degraded (uniform) picks. */
function renderReading(spec, line) {
  if (!els.readingBox) return;
  if (!spec) { els.readingBox.hidden = true; return; }
  els.readingHead.textContent = readingHeader(spec.stats, spec.intensityKey, { live: spec.live });
  els.readingList.innerHTML = "";
  const I = intensityOf(spec.intensityKey);
  for (const n of line.nums) {
    const div = document.createElement("div");
    div.className = "r-item";
    div.dataset.ball = String(n);
    div.innerHTML =
      `<span class="r-ball"></span>` +
      `<span class="r-lines"><span></span><span></span><span></span></span>`;
    div.querySelector(".r-ball").textContent = String(n);
    const spans = div.querySelectorAll(".r-lines span");
    readingLines(spec.stats, n, I).forEach((text, i) => { spans[i].textContent = text; });
    els.readingList.appendChild(div);
  }
  els.readingBox.hidden = false;
}

/** One coalesced announcement per draw — never one per released ball. */
function announceDraw(spots, lines) {
  if (!els.revealStatus) return;
  const rest = lines.length > 1
    ? ` ${lines.length - 1} further line${lines.length > 2 ? "s" : ""} listed below.`
    : "";
  els.revealStatus.textContent =
    `${spots}-spot pick. Line 1: ${lines[0].nums.join(", ")}.${rest}`;
}

els.copyAllBtn.addEventListener("click", (e) => {
  if (!lastDraw) return;
  copyText(lastDraw.lines.map(lineText).join("\n"), e.currentTarget);
});

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (btn && ok) {
    const orig = btn.textContent;
    btn.classList.add("copied");
    btn.textContent = "✓";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = orig; }, 1100);
  }
}

/* ------------------------------------------------------------ history */
function pushHistory(spots, lines, spec = null) {
  const preset = spec ? intensityPreset(spec.intensityKey) : null;
  saveHistory(localStorage, {
    name: `${spots}-spot KenoGO${preset ? ` · ${preset.label}` : ""}`,
    ts: Date.now(),
    lines: lines.map((l) => ({ n: l.nums }))
  });
}

function renderHistory() {
  const hist = loadHistory(localStorage);
  els.historyCount.textContent = String(hist.length);
  els.historyList.innerHTML = "";
  if (!hist.length) {
    const empty = document.createElement("p");
    empty.className = "h-empty";
    empty.textContent = "No draws yet.";
    els.historyList.appendChild(empty);
    return;
  }
  const fmt = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });
  for (const h of hist) {
    const div = document.createElement("div");
    div.className = "h-item";
    div.innerHTML =
      `<div class="h-meta"><span class="g"></span><span></span></div>` +
      `<div class="h-nums"></div>`;
    div.querySelector(".g").textContent = `${h.name} · ${h.lines.length} line${h.lines.length > 1 ? "s" : ""}`;
    div.querySelector(".h-meta span:last-child").textContent = fmt.format(new Date(h.ts));
    div.querySelector(".h-nums").textContent = h.lines.map((l) => l.n.join(" ")).join("\n");
    els.historyList.appendChild(div);
  }
}

els.clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("Clear all draw history?")) return;
  clearHistory(localStorage);
  renderHistory();
});

/* ---------------------------------------------------------------- PWA */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

/* Footer data currency + the Oracle's ONE data state: archive stamp from
 * data/stats.json (rides the SW data cache — works offline once fetched,
 * data commits need no VERSION bump), tightened to "· live" when the
 * CORS-open API answers and the gap is small. The SAME onData events feed
 * the Oracle state, so the footer, the Reading and the sampler can never
 * describe different data. Absent both (first visit offline), the version
 * stands alone and picks are plain crypto-random. */
initFooter(els.dataThrough, {
  onData: (stats, live) => {
    setOracleData(live ? mergeStats(stats, live.draws) : stats, !!live);
  }
});

/* ---------------------------------------------------------------- init */
syncControls();
buildIntensityDial();
syncOracleStatus();
renderHistory();
chamber.setPool(POOL, ACCENT);
startLoop();
if (reduceMotion.matches) chamber.renderOnce();
