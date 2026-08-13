/* KenoGO Oracle — performance profile harness (docs/perf-baseline.md).
 *
 *   node scripts/perf-profile.mjs                 # full profile, JSON to stdout
 *   node scripts/perf-profile.mjs --out=perf.json
 *   node scripts/perf-profile.mjs --chrome="C:\...\chrome.exe"
 *   node scripts/perf-profile.mjs --serve         # server only, for npx lighthouse
 *
 * Zero dependencies — Node >= 22 (native WebSocket) + an installed Chrome or
 * Edge. CDP scaffolding inherited from quickpick-au. Everything runs at 4x
 * CPU throttle on a 412×915 mobile viewport (plus an unthrottled control
 * where noted).
 *
 * The keno-specific question this instrument answers: the chamber simulates
 * 80 balls with O(n²) collisions — under 4x throttle, does the frame
 * governor hold the budget, and when it cannot, does it degrade the BALL
 * COUNT (never the selection)? window.__kenogoPerf exposes the governor's
 * own EMA + cap so the harness reads the app's real telemetry, not a proxy.
 */

import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const THROTTLE = 4;

const argv = process.argv.slice(2);
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

/* ------------------------------------------------------------ static server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8"
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const rel = path.endsWith("/") ? `${path}index.html` : path;
      const body = await readFile(join(ROOT, rel));
      res.writeHead(200, {
        "Content-Type": MIME[extname(rel)] ?? "application/octet-stream",
        "Cache-Control": "no-cache" // the service worker is the cache under test
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ---------------------------------------------------------- chrome + CDP */

function findBrowser() {
  const cli = arg("chrome");
  const candidates = [
    cli,
    process.env.CHROME_PATH,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LocalAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("no Chrome/Edge found — pass --chrome=<path> or set CHROME_PATH");
  return found;
}

async function launchBrowser(exe) {
  const profile = await mkdtemp(join(tmpdir(), "kg-perf-"));
  const proc = spawn(exe, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--window-size=412,915"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`browser did not expose DevTools:\n${buf}`)), 20000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(t); reject(new Error(`browser exited (${code}) before DevTools was up`)); });
  });
  return { proc, profile, wsUrl };
}

/** Minimal flat-session CDP client over the native WebSocket. */
class CDP {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP connect failed")); });
    return new CDP(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    };
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.on(method, (params, sid) => {
        if (sid === sessionId) { clearTimeout(t); resolve(params); }
      });
    });
  }
  close() { this.ws.close(); }
}

/* ----------------------------------------------------------- page driver */

class Page {
  constructor(cdp, sessionId, targetId) { this.cdp = cdp; this.sid = sessionId; this.tid = targetId; }

  static async open(cdp) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true
    });
    return page;
  }

  send(method, params) { return this.cdp.send(method, params, this.sid); }
  async throttle(rate) { await this.send("Emulation.setCPUThrottlingRate", { rate }); }

  async navigate(url) {
    const loaded = this.cdp.once("Page.loadEventFired", this.sid);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  async collectGarbage() {
    await this.send("HeapProfiler.enable");
    await this.send("HeapProfiler.collectGarbage");
  }
}

/* -------------------------------------------------------- in-page probes */

const PAINT_PROBE = `(async () => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
  const lcp = await new Promise((resolve) => {
    let last = null;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) last = e.startTime; })
        .observe({ type: "largest-contentful-paint", buffered: true });
    } catch { /* no LCP in this engine */ }
    setTimeout(() => resolve(last), 600);
  });
  return {
    fcp, lcp,
    domContentLoaded: nav.domContentLoadedEventEnd,
    load: nav.loadEventEnd,
    transferKB: Math.round(performance.getEntriesByType("resource")
      .reduce((a, r) => a + (r.transferSize || 0), nav.transferSize || 0) / 1024)
  };
})()`;

/** Sample the idle chamber for `seconds`: frame deltas + the governor's own
 * telemetry over time. The loop runs whenever the page is visible, so this
 * is the always-on cost a phone pays with the app open. */
const IDLE_PROBE = (seconds) => `(async () => {
  const frames = [];
  let raf = requestAnimationFrame(function pump(t) { frames.push(t); raf = requestAnimationFrame(pump); });
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ${seconds * 1000}) {
    await new Promise((r) => setTimeout(r, 1000));
    const p = window.__kenogoPerf;
    samples.push({ atS: Math.round((performance.now() - t0) / 1000),
                   emaMs: Math.round(p.emaMs * 10) / 10, cap: p.cap, balls: p.balls });
  }
  cancelAnimationFrame(raf);
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  deltas.sort((a, b) => a - b);
  const fps = deltas.length ? 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const p95 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] : null;
  return { fps: fps && Math.round(fps), frameP95ms: p95 && Math.round(p95 * 10) / 10, samples };
})()`;

/** One full 10-spot reveal: frame rate, long tasks, governor state after. */
const REVEAL_PROBE = `(async () => {
  const btn = document.getElementById("drawBtn");
  if (btn.disabled) throw new Error("draw already running");
  const longTasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver((l) => longTasks.push(...l.getEntries().map((e) => e.duration)));
    obs.observe({ type: "longtask" });
  } catch { /* longtask unsupported */ }
  const frames = [];
  let raf = requestAnimationFrame(function pump(t) { frames.push(t); raf = requestAnimationFrame(pump); });
  const t0 = performance.now();
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  while (btn.disabled) await new Promise((r) => setTimeout(r, 100));
  const total = performance.now() - t0;
  cancelAnimationFrame(raf);
  obs?.disconnect();
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  deltas.sort((a, b) => a - b);
  const fps = deltas.length ? 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const p95 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] : null;
  const g = window.__kenogoPerf;
  return {
    seconds: Math.round(total / 100) / 10,
    fps: fps && Math.round(fps),
    frameP95ms: p95 && Math.round(p95 * 10) / 10,
    longestTaskMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
    longTasks: longTasks.length,
    governorAfter: { emaMs: Math.round(g.emaMs * 10) / 10, cap: g.cap, balls: g.balls }
  };
})()`;

/** Exercise the REAL degrade ladder with synthetic frame intervals (this
 * desktop holds 60 fps at 4x, so the governor never fires naturally here).
 * Asserts: sustained slow frames step the cap down and shed balls LIVE; a
 * full reveal still completes at the degraded cap with every pill filled;
 * sustained healthy frames raise the cap back at the next pool reset. */
const GOVERNOR_PROBE = `(async () => {
  const g = window.__kenogoPerf;
  const out = { start: { cap: g.cap, balls: g.balls } };
  if (g.cap !== 80) throw new Error("expected the ladder at full 80 to begin");

  g.simulateFrames(40, 95); // ~25 fps sustained past DEGRADE_FRAMES
  out.afterSlow95 = { cap: g.cap, balls: g.balls };
  if (g.cap >= 80) throw new Error("governor failed to degrade under sustained 40 ms frames");
  if (g.balls > g.cap) throw new Error("cap applied but balls not shed live");

  g.simulateFrames(40, 95);
  out.afterSlow190 = { cap: g.cap, balls: g.balls };

  // A reveal at the degraded cap must complete with all 10 pills filled.
  const btn = document.getElementById("drawBtn");
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  while (btn.disabled) await new Promise((r) => setTimeout(r, 100));
  const pills = document.querySelectorAll('.line[data-idx="0"] .pill:not(.placeholder)').length;
  out.degradedReveal = { pillsFilled: pills, cap: g.cap, balls: g.balls };
  if (pills !== 10) throw new Error("degraded reveal must still fill every pill — got " + pills);

  // Recovery: healthy frames arm a raise, applied at the next pool reset.
  g.simulateFrames(12, 650);
  const armedCap = g.cap;
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  while (btn.disabled) await new Promise((r) => setTimeout(r, 100));
  out.afterRecovery = { capArmed: armedCap, cap: g.cap, balls: g.balls };
  if (g.balls <= out.afterSlow190.balls) throw new Error("recovery did not restore balls at the next pool");
  return out;
})()`;

/** Selection is the product; the chamber is decoration. Prove the product
 * costs nothing: 10 lines × 10 spots, medianed. */
const SELECTION_PROBE = (reps) => `(async () => {
  const { drawLine } = await import("./rng.js");
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const times = [];
  for (let i = 0; i < ${reps}; i++) {
    const t = performance.now();
    for (let l = 0; l < 10; l++) drawLine(80, 10);
    times.push(performance.now() - t);
  }
  return Math.round(med(times) * 100) / 100;
})()`;

const STATS_PROBE = (reps) => `(async () => {
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const fetchMs = [], parseMs = [];
  for (let i = 0; i < ${reps}; i++) {
    let t = performance.now();
    const res = await fetch("data/stats.json", { cache: "no-store" });
    const text = await res.text();
    fetchMs.push(performance.now() - t);
    t = performance.now();
    JSON.parse(text);
    parseMs.push(performance.now() - t);
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return { fetch: r1(med(fetchMs)), parse: r1(med(parseMs)) };
})()`;

const HEAP_PROBE = `(() => ({
  usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10,
  totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576 * 10) / 10
}))()`;

/* ------------------------------------------------------------- scenario */

async function coldWarm(cdp, origin, rate) {
  const page = await Page.open(cdp);
  await page.throttle(rate);
  const cold = await (async () => {
    await page.navigate(`${origin}/`);
    return page.eval(PAINT_PROBE);
  })();
  await page.eval(`navigator.serviceWorker.ready.then(() => true)`);
  await page.navigate(`${origin}/`);
  const warm = await page.eval(PAINT_PROBE);
  const controlled = await page.eval(`!!navigator.serviceWorker.controller`);
  if (!controlled) throw new Error("warm-start page is not service-worker-controlled — warm numbers would be a lie");
  await cdp.send("Target.closeTarget", { targetId: page.tid });
  return { cold, warm };
}

async function run() {
  if (argv.includes("--serve")) {
    const { origin } = await startServer();
    console.log(origin);
    return; // keeps serving until killed
  }
  const exe = findBrowser();
  const { server, origin } = await startServer();
  const { proc, profile, wsUrl } = await launchBrowser(exe);
  const out = {
    date: new Date().toISOString().slice(0, 10),
    browser: exe.replace(/.*\\/, ""),
    throttle: `${THROTTLE}x CPU, 412×915 mobile viewport`,
    node: process.version
  };
  try {
    const cdp = await CDP.connect(wsUrl);

    console.error("· cold/warm start (4x)…");
    out.startup4x = await coldWarm(cdp, origin, THROTTLE);
    console.error("· warm start (1x control)…");
    out.startup1xWarmOnly = (await coldWarm(cdp, origin, 1)).warm;

    const page = await Page.open(cdp);
    await page.throttle(THROTTLE);
    await page.navigate(`${origin}/`);
    await page.eval(`navigator.serviceWorker.ready.then(() => true)`);

    console.error("· idle 80-ball chamber, 12 s at 4x (governor watch)…");
    out.idleChamber4x = await page.eval(IDLE_PROBE(12));

    console.error("· one 10-spot reveal at 4x…");
    out.reveal4x = await page.eval(REVEAL_PROBE);

    console.error("· degrade ladder end-to-end (synthetic slow frames)…");
    out.governorLadder = await page.eval(GOVERNOR_PROBE);

    console.error("· selection microbench (10 lines × 10 spots) at 4x…");
    out.selection10x10Ms4x = await page.eval(SELECTION_PROBE(9));

    console.error("· stats.json fetch/parse at 4x…");
    out.statsPath4x = await page.eval(STATS_PROBE(7));

    console.error("· idle chamber, 6 s at 1x control…");
    await page.throttle(1);
    out.idleChamber1x = await page.eval(IDLE_PROBE(6));

    console.error("· JS heap (post-GC)…");
    await page.collectGarbage();
    out.heap = await page.eval(HEAP_PROBE);

    cdp.close();
  } finally {
    proc.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const j = JSON.stringify(out, null, 2);
  const outPath = arg("out");
  if (outPath) await writeFile(outPath, j);
  console.log(j);
}

await run();
