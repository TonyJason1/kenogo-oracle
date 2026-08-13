/* KenoGO Oracle — service worker caching (quickpick-au M11 doctrine).
 *
 * Runs sw.js for real against a mock Cache/fetch environment. Deliberately no
 * jsdom: a service worker has no DOM, and this test belongs in the
 * zero-dependency core suite that the 6-hourly data pipeline itself runs.
 *
 * Pins: the shell precaches atomically WITHOUT data; stats.json rides an
 * unversioned runtime cache that a VERSION bump must not evict; the SHELL
 * list covers the real import graph; cross-origin (the live API top-up)
 * passes through untouched.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const ORIGIN = "https://tonyjason1.github.io";
const BASE = `${ORIGIN}/kenogo-oracle/`;
const pathOf = (u) => new URL(typeof u === "string" ? u : u.url, BASE).pathname;

/* ------------------------------------------------------------- harness */

class MockCache {
  constructor() { this.entries = new Map(); }
  async put(req, res) { this.entries.set(pathOf(req), res); }
  async match(req) { return this.entries.get(pathOf(req)); }
  async delete(req) { return this.entries.delete(pathOf(req)); }
  /** Atomic, exactly like the real Cache API: any failure stores nothing. */
  async addAll(list) {
    const fetched = [];
    for (const u of list) {
      const res = await globalThis.fetch({ url: new URL(u, BASE).toString(), method: "GET" });
      if (!res.ok) throw new TypeError(`addAll: request failed for ${u}`);
      fetched.push([u, res]);
    }
    for (const [u, res] of fetched) await this.put(u, res);
  }
}

class MockCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
}

function makeNetwork({ offline = false, failing = new Set() } = {}) {
  const log = [];
  const fn = async (req) => {
    const p = pathOf(req);
    log.push(p);
    if (offline) throw new TypeError("Failed to fetch");
    if (failing.has(p)) throw new TypeError(`Failed to fetch ${p}`);
    if (/\/data\/stats\.json$/.test(p)) {
      return new Response(JSON.stringify({ schema: 1, n: 42, dataThrough: "2026-01-01T00:00:00Z", freq: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(`content:${p}`, { status: 200 });
  };
  fn.log = log;
  return fn;
}

let swInstance = 0;
/** Boot a fresh sw.js against a fresh mock environment. */
async function bootSW({ network = makeNetwork(), storage = new MockCacheStorage() } = {}) {
  const listeners = new Map();
  globalThis.self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => { globalThis.self._skipWaiting = true; },
    clients: { claim: async () => { globalThis.self._claimed = true; } }
  };
  globalThis.caches = storage;
  globalThis.fetch = network;
  await import(`../sw.js?instance=${++swInstance}`);
  return { listeners, storage, network };
}

const fireLifecycle = async (listeners, type) => {
  const waits = [];
  listeners.get(type)({ waitUntil: (p) => waits.push(p) });
  return Promise.all(waits);
};

async function fireFetch(listeners, url, { mode = "same-origin", method = "GET" } = {}) {
  const request = { url: new URL(url, BASE).toString(), method, mode };
  let responded;
  const waits = [];
  listeners.get("fetch")({ request, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
  if (responded === undefined) return { passthrough: true };
  const res = await responded;
  await Promise.allSettled(waits);
  return { res, passthrough: false };
}

/** The SHELL array as sw.js declares it. */
function shellList() {
  const src = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const block = src.match(/const SHELL = \[([\s\S]*?)\];/);
  ok(block, "could not locate SHELL in sw.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/* --------------------------------------------- 1. what gets precached */

await check("install precaches the shell and NO data", async () => {
  const { listeners, storage } = await bootSW();
  await fireLifecycle(listeners, "install");

  const shellCache = [...storage.caches.entries()].find(([k]) => k.includes("shell"))[1];
  const cached = [...shellCache.entries.keys()];
  ok(cached.length > 0, "shell cache is empty");
  const data = cached.filter((p) => /\/data\//.test(p));
  eq(data.length, 0, `data files must not be precached, found: ${data.join(", ")}`);

  for (const must of ["/kenogo-oracle/", "/kenogo-oracle/app.js", "/kenogo-oracle/index.html"]) {
    ok(cached.includes(must), `shell missing ${must}`);
  }
});

await check("SHELL covers every module the app actually imports", async () => {
  const shell = new Set(shellList());
  const root = new URL("../", import.meta.url);
  const seen = new Set();

  const walk = (relPath) => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    ok(shell.has(`./${relPath}`), `sw.js SHELL is missing ./${relPath} — the app would break offline`);
    const src = readFileSync(new URL(relPath, root), "utf8");
    for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s+["'](\.[^"']+)["']/g)) {
      const resolved = fileURLToPath(new URL(m[1], new URL(relPath, root)))
        .replace(fileURLToPath(root), "")
        .replace(/\\/g, "/");
      walk(resolved);
    }
  };
  walk("app.js");

  // static assets referenced by index.html
  const html = readFileSync(new URL("index.html", root), "utf8");
  for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref)) continue;
    ok(shell.has(`./${ref}`), `sw.js SHELL is missing ./${ref} (referenced by index.html)`);
  }
  ok(seen.has("js/reveal.js") && seen.has("js/history.js") && seen.has("js/live.js"),
    "expected the split modules in the import graph");
});

/* ------------------------------------------------ 2. install atomicity */

await check("a failing DATA file cannot break the install (it is not in the shell)", async () => {
  const network = makeNetwork({ failing: new Set(["/kenogo-oracle/data/stats.json"]) });
  const { listeners, storage } = await bootSW({ network });
  await fireLifecycle(listeners, "install"); // must not reject
  const shellCache = [...storage.caches.entries()].find(([k]) => k.includes("shell"))[1];
  ok(shellCache.entries.size > 0, "shell should still be cached");
});

await check("a failing SHELL asset still fails the install loudly", async () => {
  const network = makeNetwork({ failing: new Set(["/kenogo-oracle/app.js"]) });
  const { listeners } = await bootSW({ network });
  let threw = false;
  try { await fireLifecycle(listeners, "install"); } catch { threw = true; }
  ok(threw, "a missing core asset must not silently produce a half-working offline app");
});

/* --------------------------------- 3. THE E2E: offline with stats state */

await check("E2E: app works offline; cached stats served, uncached degrade to 504", async () => {
  const storage = new MockCacheStorage();

  // Visit once, online — stats fetched once.
  {
    const { listeners } = await bootSW({ network: makeNetwork(), storage });
    await fireLifecycle(listeners, "install");
    await fireLifecycle(listeners, "activate");
    const r = await fireFetch(listeners, "./data/stats.json");
    eq(r.res.status, 200, "stats fetched online");
  }

  // Now go offline.
  const { listeners } = await bootSW({ network: makeNetwork({ offline: true }), storage });

  const nav = await fireFetch(listeners, "./", { mode: "navigate" });
  eq(nav.res.status, 200, "navigation must be served from cache");
  const app = await fireFetch(listeners, "./app.js");
  eq(app.res.status, 200, "app.js must be served from cache");

  const cached = await fireFetch(listeners, "./data/stats.json");
  eq(cached.res.status, 200, "cached stats must be served offline");
  const parsed = JSON.parse(await cached.res.clone().text());
  eq(parsed.n, 42, "cached stats content intact");

  const deep = await fireFetch(listeners, "./some/deep/route", { mode: "navigate" });
  eq(deep.res.status, 200, "unknown route must fall back to the cached shell");
});

await check("stats never fetched + offline now → clean 504, nothing else poisoned", async () => {
  const storage = new MockCacheStorage();
  {
    const { listeners } = await bootSW({ storage });
    await fireLifecycle(listeners, "install");
  }
  const { listeners } = await bootSW({ network: makeNetwork({ offline: true }), storage });
  const missing = await fireFetch(listeners, "./data/stats.json");
  eq(missing.res.status, 504, "uncached stats must yield a clean 504");
  const stillFine = await fireFetch(listeners, "./js/live.js");
  eq(stillFine.res.status, 200, "the rest of the app must be unaffected");
});

/* ------------------------------------- 4. runtime caching + refreshing */

await check("stats cached on first use, then cache-first with background refresh", async () => {
  const network = makeNetwork();
  const { listeners, storage } = await bootSW({ network });
  await fireLifecycle(listeners, "install");

  const dataCache = () => [...storage.caches.entries()].find(([k]) => k.includes("data"));
  ok(!dataCache(), "no data cache should exist before any stats request");

  await fireFetch(listeners, "./data/stats.json");
  ok(dataCache(), "data cache created on first use");

  const before = network.log.length;
  const second = await fireFetch(listeners, "./data/stats.json");
  eq(second.res.status, 200, "served");
  ok(network.log.length > before, "a background refresh should still be issued (stale-while-revalidate)");
});

/* --------------------------------- 5. deploys must not evict the stats */

await check("a VERSION bump keeps the data cache and drops only old shells", async () => {
  const storage = new MockCacheStorage();
  const { listeners } = await bootSW({ storage });
  await fireLifecycle(listeners, "install");
  await fireFetch(listeners, "./data/stats.json");

  const dataKey = [...storage.caches.keys()].find((k) => k.includes("data"));
  ok(dataKey, "data cache exists");
  ok(!/v0\.\d+\.\d+/.test(dataKey), `data cache must not be version-scoped, got "${dataKey}"`);

  storage.caches.set("kenogo-oracle-shell-v0.0.1", new MockCache());
  storage.caches.set("kenogo-oracle-v0.0.0", new MockCache());

  await fireLifecycle(listeners, "activate");
  const keys = [...storage.caches.keys()];
  ok(!keys.includes("kenogo-oracle-shell-v0.0.1"), "stale shell cache must be deleted");
  ok(!keys.includes("kenogo-oracle-v0.0.0"), "pre-split cache must be deleted");
  ok(keys.includes(dataKey), "data cache must SURVIVE the version bump");
});

/* --------------------------------------------------- 6. passthroughs */

await check("cross-origin (the live API) and non-GET requests are not intercepted", async () => {
  const { listeners } = await bootSW();
  await fireLifecycle(listeners, "install");
  const cross = await fireFetch(listeners, "https://api-kenogo.lttlapp.com/api/v1/draws?productId=kenoGo");
  ok(cross.passthrough, "the live top-up must pass through untouched");
  const help = await fireFetch(listeners, "https://www.gamblinghelponline.org.au/");
  ok(help.passthrough, "external links must pass through untouched");
  const post = await fireFetch(listeners, "./app.js", { method: "POST" });
  ok(post.passthrough, "non-GET must pass through untouched");
});

/* ------------------------------------------------------------- report */

console.log(`\nService worker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
