/* KenoGO Oracle — release-hygiene guards.
 *
 * sw.js serves the shell cache-first, so a deploy that forgets to bump
 * VERSION ships nothing: clients keep the old app forever. That bump is the
 * one manual step in the release, pinned here as the version TRIPLE:
 * package.json = sw.js VERSION = index.html footer build line.
 *
 * Also pins the cache split — if the data cache ever picks up the app
 * version, every deploy would silently re-download the stats.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const sw = readFileSync(new URL("sw.js", root), "utf8");

const swVersion = sw.match(/const VERSION = "([^"]+)"/)?.[1];
const statsSchema = sw.match(/const STATS_SCHEMA = "([^"]+)"/)?.[1];

check("sw.js VERSION tracks package.json version", () => {
  ok(swVersion, "could not find VERSION in sw.js");
  eq(swVersion, `v${pkg.version}`,
    "the shell is served cache-first, so a stale VERSION means clients never receive this deploy");
});

check("versions are semver", () => {
  ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version "${pkg.version}"`);
  ok(/^v\d+\.\d+\.\d+$/.test(swVersion), `sw.js VERSION "${swVersion}"`);
});

check("the footer build line shows this exact version", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  const m = html.match(/<p class="build">v(\d+\.\d+\.\d+)<span id="dataThrough">/);
  ok(m, "index.html is missing the footer build line (v<semver> + #dataThrough span)");
  eq(m[1], pkg.version,
    "the footer names the build a device is running — a stale footer version misreports every deploy");
});

check("the data cache is NOT keyed by the app version", () => {
  ok(statsSchema, "could not find STATS_SCHEMA in sw.js");
  ok(!statsSchema.includes(pkg.version),
    `STATS_SCHEMA "${statsSchema}" embeds the app version — every deploy would evict the stats`);
  ok(/const DATA_CACHE = `[^`]*\$\{STATS_SCHEMA\}`/.test(sw),
    "the data cache name must derive from STATS_SCHEMA, not VERSION");
  ok(/const SHELL_CACHE = `[^`]*\$\{VERSION\}`/.test(sw),
    "the shell cache name must derive from VERSION");
});

check("every test file the npm scripts reference exists", () => {
  const scripts = Object.values(pkg.scripts).join(" ");
  const referenced = [...scripts.matchAll(/node (test\/[\w./-]+\.mjs)/g)].map((m) => m[1]);
  ok(referenced.length >= 9, `expected the full suite to be wired up, found ${referenced.length}`);
  for (const rel of referenced) {
    ok(existsSync(fileURLToPath(new URL(rel, root))), `npm script points at a missing file: ${rel}`);
  }
});

check("npm test runs both suites, and the core suite needs no dependencies", () => {
  ok(/test:core/.test(pkg.scripts.test) && /test:dom/.test(pkg.scripts.test),
    "npm test must cover both suites");
  ok(!/ui\.test/.test(pkg.scripts["test:core"]),
    "the jsdom tests must not be in the core suite — the 6-hourly data pipeline runs it without installing anything");
});

check("the shipped app still has zero production dependencies", () => {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const prod = Object.entries(lock.packages)
    .filter(([name, meta]) => name !== "" && !meta.dev)
    .map(([name]) => name);
  eq(prod.length, 0, `production dependencies found: ${prod.join(", ")}`);
  ok(!pkg.dependencies, "package.json must declare no runtime dependencies");
});

console.log(`\nRelease hygiene: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
