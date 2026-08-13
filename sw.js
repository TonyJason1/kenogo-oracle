/* KenoGO Oracle service worker.
 *
 * Two caches, on purpose (quickpick-au M11 doctrine, measured there):
 *
 * SHELL — versioned, precached atomically at install. Everything needed to
 * boot and draw a quick pick offline. BUMP `VERSION` on every deploy so
 * clients pick up new assets; test/version.test.mjs pins it to package.json
 * and the footer.
 *
 * DATA — unversioned, populated at RUNTIME, cache-first with a background
 * refresh. Exactly one file rides it: data/stats.json (the CSV corpus is
 * never fetched by the client). The split means a deploy does not evict the
 * stats, and a data commit reaches clients without a VERSION bump.
 * STATS_SCHEMA is what invalidates it, and only changes if the stats.json
 * record shape changes.
 *
 * Cross-origin requests (the live KenoGO API top-up) pass straight through,
 * uncached and unintercepted.
 */
const VERSION = "v0.2.0";
const STATS_SCHEMA = "v2"; // bump ONLY when data/stats.json shape changes

const SHELL_CACHE = `kenogo-oracle-shell-${VERSION}`;
const DATA_CACHE = `kenogo-oracle-data-${STATS_SCHEMA}`;

/* Must cover every asset the app needs to boot offline. test/sw.test.mjs
 * walks the real import graph from index.html and fails if anything is
 * missing. */
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./rng.js",
  "./js/live.js",
  "./js/oracle.js",
  "./js/reveal.js",
  "./js/history.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon-180.png"
];

const DATA_RE = /\/data\/stats\.json$/;
const KEEP = new Set([SHELL_CACHE, DATA_CACHE]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Cross-origin requests pass straight through, uncached and unintercepted.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    DATA_RE.test(url.pathname) ? statsData(event, req) : shellAsset(event, req)
  );
});

/**
 * stats.json: serve the cached copy instantly (offline included) and refresh
 * in the background, so a data commit lands without a VERSION bump. Never
 * fetched and unfetchable now → clean 504; the footer simply stays version-
 * only until a connection succeeds once.
 */
async function statsData(event, req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });

  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) return cache.put(req, res.clone()).then(() => res);
      return res;
    })
    .catch(() => null);

  if (hit) {
    event.waitUntil(refresh); // keep the SW alive for the background update
    return hit;
  }
  const fresh = await refresh;
  return fresh || new Response(
    JSON.stringify({ error: "stats not cached — connect once to fetch them" }),
    { status: 504, headers: { "Content-Type": "application/json" } }
  );
}

/** Everything else: cache-first, with a navigation fallback to the shell. */
async function shellAsset(event, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) event.waitUntil(cache.put(req, res.clone()));
    return res;
  } catch {
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return Response.error();
  }
}
