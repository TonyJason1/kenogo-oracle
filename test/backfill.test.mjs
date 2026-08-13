/* KenoGO Oracle — bucket-walk engine: resumability, refusal, repair.
 *
 * Runs walkBuckets (the EXACT code both the backfill and the 6-hourly
 * updater execute) against a synthetic in-memory API — no network. The
 * doctrine under test: files are the resume truth, interrupted walks resume
 * without duplication, torn tails are repaired, and every anomaly class
 * either ledgers loudly or refuses to write. Zero dependencies.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CSV_HEADER, GAP_160_MS, headsTailsOf, listMonthFiles, readAllRecords,
  readJson, repairMonthFile, validateChain, walkBuckets, writeJsonAtomic
} from "../scripts/lib.mjs";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/* ------------------------------------------------- synthetic universe */

const HOUR_MS = 3_600_000;
const BASE_MS = Date.parse("2026-01-01T00:00:00Z"); // deep in the 160 s era
const UNIVERSE_HOURS = 6;
const NOW_MS = BASE_MS + UNIVERSE_HOURS * HOUR_MS + 30 * 60_000;

/** Draw instants: BASE + i·160 s, for every slot inside the universe. */
function slotsInBucket(bucketMs) {
  const out = [];
  const end = Math.min(bucketMs + HOUR_MS, BASE_MS + UNIVERSE_HOURS * HOUR_MS);
  for (let t = Math.ceil(Math.max(0, bucketMs - BASE_MS) / GAP_160_MS) * GAP_160_MS + BASE_MS;
       t < end; t += GAP_160_MS) {
    if (t >= bucketMs) out.push(t);
  }
  return out;
}

function makeItem(ms) {
  const i = (ms - BASE_MS) / GAP_160_MS;
  const numbers = Array.from({ length: 20 }, (_, k) => 1 + ((k * 4 + i) % 80));
  return {
    id: `uuid-${i}`,
    externalId: String(1 + (i % 999)),
    productId: "kenoGo",
    state: "finished",
    numbers,
    odds: "x".repeat(50), // present in the wild, must be stripped
    drawingDate: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    sideBetResults: { headsTails: headsTailsOf(numbers), jackpot: "regular", bonus: 1 }
  };
}

/** Mock fetch with per-bucket overrides: { "<bucket>": fn(items)→items | "http500" | "empty" }. */
function makeFetch(overrides = {}, log = []) {
  return async (url) => {
    const m = url.match(/date=([^&]+)/);
    const bucket = decodeURIComponent(m[1]).slice(0, 13);
    log.push(bucket);
    const rule = overrides[bucket];
    if (rule === "http500") return { ok: false, status: 500, json: async () => ({}) };
    let items = slotsInBucket(Date.parse(`${bucket}:00:00Z`)).map(makeItem);
    if (rule === "empty") items = [];
    else if (typeof rule === "function") items = rule(items);
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
}

const walk = (dataDir, { overrides, fetchLog, ...rest } = {}) => walkBuckets({
  dataDir, delayMs: 0, holeRecheckMs: 0, now: () => NOW_MS,
  fetchImpl: makeFetch(overrides, fetchLog), ...rest
});

/* A fresh dir gets a cursor pointing the walk at the synthetic universe —
 * without it, walkBuckets correctly starts at the REAL 2022 floor and spends
 * its whole budget floor-scanning empty mock buckets. */
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "kg-walk-"));
  writeFileSync(join(dir, "cursor.json"), JSON.stringify({
    nextBucket: "2026-01-01T00", lastDrawingDate: null, discoveredFloor: "2026-01-01T00"
  }));
  return dir;
}
function allRecords(dataDir) {
  return [...readAllRecords(join(dataDir, "draws"))];
}
function assertNoDupsAndClean(dataDir) {
  const recs = allRecords(dataDir);
  const dates = new Set(recs.map((r) => r.drawingDate));
  eq(dates.size, recs.length, "duplicate drawingDate in archive");
  const { fatal } = validateChain(null, recs);
  ok(!fatal, `chain must be clean: ${fatal}`);
  return recs;
}

/* -------------------------------------------------------------- tests */

await check("fresh walk archives whole buckets and stops at max-buckets", async () => {
  const dir = freshDir();
  const r = await walk(dir, { maxBuckets: 3 });
  eq(r.stopped, "max-buckets");
  eq(r.buckets, 3);
  const recs = assertNoDupsAndClean(dir);
  const expected = [0, 1, 2].reduce((a, h) => a + slotsInBucket(BASE_MS + h * HOUR_MS).length, 0);
  eq(recs.length, expected, "every slot in the walked buckets archived");
  const cursor = readJson(join(dir, "cursor.json"));
  eq(cursor.nextBucket, "2026-01-01T03");
  eq(cursor.lastDrawingDate, recs[recs.length - 1].drawingDate);
  rmSync(dir, { recursive: true, force: true });
});

await check("interrupted walk RESUMES from the files without duplication", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  const afterFirst = allRecords(dir).length;
  const fetchLog = [];
  const r2 = await walk(dir, { maxBuckets: 2, fetchLog });
  eq(fetchLog[0], "2026-01-01T01", "resume must re-fetch the tail's own bucket");
  const recs = assertNoDupsAndClean(dir);
  ok(recs.length > afterFirst, "resume must add the next bucket's draws");
  eq(r2.stopped, "max-buckets");
  rmSync(dir, { recursive: true, force: true });
});

await check("walk to caught-up leaves the not-yet-complete hour for next time", async () => {
  const dir = freshDir();
  const r = await walk(dir, {});
  eq(r.stopped, "caught-up");
  const recs = assertNoDupsAndClean(dir);
  // Universe ends exactly at the T06 boundary; NOW is T06:30, so bucket T06
  // (empty in-universe) is never fetched — the newest fetched bucket is T05.
  const lastArchivable = BASE_MS + UNIVERSE_HOURS * HOUR_MS - GAP_160_MS + (BASE_MS % GAP_160_MS);
  ok(recs[recs.length - 1].ms <= lastArchivable, "nothing from the incomplete hour");
  const cursor = readJson(join(dir, "cursor.json"));
  eq(cursor.nextBucket, "2026-01-01T06", "cursor parked at the first not-yet-complete bucket");
  rmSync(dir, { recursive: true, force: true });
});

await check("a TORN final line is repaired before the walk appends", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  const file = join(dir, "draws", listMonthFiles(join(dir, "draws"))[0]);
  const before = allRecords(dir).length;
  appendFileSync(file, "2026-01-01T01:5"); // kill mid-append
  const cut = repairMonthFile(file);
  ok(cut > 0, "repair must cut the torn bytes");
  const r = await walk(dir, { maxBuckets: 2 }); // bucket 1 re-fetch dedupes; bucket 2 adds
  ok(r.draws > 0, "walk continues after repair");
  const recs = assertNoDupsAndClean(dir);
  ok(recs.length > before, "archive grew past the repair");
  rmSync(dir, { recursive: true, force: true });
});

await check("torn tail is ALSO repaired implicitly when the walk starts", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  const file = join(dir, "draws", listMonthFiles(join(dir, "draws"))[0]);
  appendFileSync(file, "2026-01-01T01:59:59Z,9"); // torn, no trailing newline
  const r = await walk(dir, { maxBuckets: 2 }); // lastRecordOnDisk repairs; bucket 2 adds
  ok(r.draws > 0, "walk continued");
  assertNoDupsAndClean(dir);
  rmSync(dir, { recursive: true, force: true });
});

await check("files WIN over a deleted cursor", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  unlinkSync(join(dir, "cursor.json"));
  const r = await walk(dir, { maxBuckets: 1 });
  ok(r.draws >= 0, "walk proceeds");
  assertNoDupsAndClean(dir);
  rmSync(dir, { recursive: true, force: true });
});

await check("files WIN over a lying cursor (pointing far ahead)", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  await writeJsonAtomic(join(dir, "cursor.json"), {
    nextBucket: "2026-01-01T05", lastDrawingDate: "2026-01-01T04:59:59Z", discoveredFloor: "2026-01-01T00"
  });
  const fetchLog = [];
  await walk(dir, { maxBuckets: 1, fetchLog });
  eq(fetchLog[0], "2026-01-01T01", "walk must restart at the FILE tail's bucket, not the cursor's claim");
  assertNoDupsAndClean(dir);
  rmSync(dir, { recursive: true, force: true });
});

await check("a refetched draw that DIFFERS from the stored record refuses to write", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  const before = allRecords(dir).length;
  const r = await walk(dir, {
    maxBuckets: 2,
    overrides: {
      // same balls, reversed DRAWN ORDER — a valid record that differs from
      // the stored fact, which is exactly what the conflict gate is for
      "2026-01-01T01": (items) => items.map((it) => ({ ...it, numbers: [...it.numbers].reverse() }))
    }
  });
  eq(r.stopped.startsWith("conflict"), true, `must refuse as a conflict (got "${r.stopped}")`);
  eq(allRecords(dir).length, before, "nothing appended on refusal");
  rmSync(dir, { recursive: true, force: true });
});

await check("an EMPTY past bucket is a suspected hole: refuse, don't advance", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 2 });
  const before = readJson(join(dir, "cursor.json"));
  const r = await walk(dir, { maxBuckets: 3, overrides: { "2026-01-01T02": "empty" } });
  ok(r.stopped.startsWith("empty-past-bucket"), `got "${r.stopped}"`);
  const after = readJson(join(dir, "cursor.json"));
  eq(after.nextBucket, before.nextBucket, "cursor must not advance past a hole");
  rmSync(dir, { recursive: true, force: true });
});

await check("a garbled payload (duplicate ball) stops the walk before any write", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 1 });
  const before = allRecords(dir).length;
  const r = await walk(dir, {
    maxBuckets: 2,
    overrides: { "2026-01-01T01": (items) => items.map((it, i) => i === 3 ? { ...it, numbers: [...it.numbers.slice(0, 19), it.numbers[0]] } : it) }
  });
  ok(r.stopped.startsWith("reject"), `got "${r.stopped}"`);
  eq(allRecords(dir).length, before, "nothing appended");
  rmSync(dir, { recursive: true, force: true });
});

await check("an off-cadence timestamp stops the walk (chain refusal)", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 1 });
  const before = allRecords(dir).length;
  const r = await walk(dir, {
    maxBuckets: 2,
    overrides: {
      "2026-01-01T01": (items) => items.map((it, i) => i === 5
        ? { ...it, drawingDate: new Date(Date.parse(it.drawingDate) + 30_000).toISOString().replace(/\.\d{3}Z$/, "+00:00") }
        : it)
    }
  });
  eq(r.stopped.startsWith("chain"), true, `got "${r.stopped}"`);
  eq(allRecords(dir).length, before, "nothing appended");
  rmSync(dir, { recursive: true, force: true });
});

await check("a skipped slot LEDGERS and the walk continues (facts, loudly)", async () => {
  const dir = freshDir();
  const r = await walk(dir, {
    maxBuckets: 2,
    overrides: { "2026-01-01T01": (items) => items.filter((_, i) => i !== 4) }
  });
  ok(r.stopped === "max-buckets", `walk must continue (got "${r.stopped}")`);
  eq(r.ledgered, 1, "one ledger entry");
  const ledger = readJson(join(dir, "anomalies.json"));
  eq(ledger.length, 1);
  eq(ledger[0].type, "missed-slots");
  const recs = allRecords(dir);
  const { fatal, ledger: rejudged } = validateChain(null, recs);
  ok(!fatal, "stored chain judges clean-with-ledger");
  eq(rejudged.length, 1, "the gap re-judges as the same single anomaly");
  rmSync(dir, { recursive: true, force: true });
});

await check("non-finished items are skipped and counted, never archived", async () => {
  const dir = freshDir();
  const r = await walk(dir, {
    maxBuckets: 1,
    overrides: { "2026-01-01T00": (items) => [...items, { ...makeItem(BASE_MS + 50 * GAP_160_MS), state: "opened" }] }
  });
  eq(r.skipped, 1, "one skip counted");
  assertNoDupsAndClean(dir);
  rmSync(dir, { recursive: true, force: true });
});

await check("floor-scan advances over pre-floor emptiness and records the discovered floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kg-walk-")); // NO seeded floor here — the scan is the test
  await writeJsonAtomic(join(dir, "cursor.json"), { nextBucket: null, lastDrawingDate: null, discoveredFloor: "2025-12-31T22" });
  const r = await walk(dir, {
    maxBuckets: 4,
    overrides: { "2025-12-31T22": "empty", "2025-12-31T23": "empty" }
  });
  ok(r.draws > 0, "data found after the scan");
  const cursor = readJson(join(dir, "cursor.json"));
  eq(cursor.discoveredFloor, "2026-01-01T00", "first bucket with data recorded as the floor");
  assertNoDupsAndClean(dir);
  rmSync(dir, { recursive: true, force: true });
});

await check("single-writer lock: a held lock REFUSES a second walker, archive untouched", async () => {
  // Born from the 2026-08-14 incident: an orphaned first walker + a resumed
  // second interleaved 242,620 duplicate rows. Never again.
  const dir = freshDir();
  await walk(dir, { maxBuckets: 1 });
  const before = allRecords(dir).length;
  writeFileSync(join(dir, "walk.lock"), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z" }));
  let threw = null;
  try { await walk(dir, { maxBuckets: 1 }); } catch (err) { threw = err; }
  ok(threw && /another walker/.test(threw.message), `must refuse loudly (got ${threw?.message})`);
  eq(allRecords(dir).length, before, "nothing appended under a held lock");
  rmSync(dir, { recursive: true, force: true });
});

await check("single-writer lock: a STALE lock (dead pid) is broken and the walk proceeds", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "walk.lock"), JSON.stringify({ pid: 999983, startedAt: "2026-01-01T00:00:00Z" }));
  const r = await walk(dir, { maxBuckets: 1 });
  ok(r.draws > 0, "walk proceeds past a dead holder");
  ok(!readJson(join(dir, "walk.lock")), "lock released after the walk");
  rmSync(dir, { recursive: true, force: true });
});

await check("a CRLF checkout parses cleanly and repair never eats good lines", async () => {
  // .gitattributes pins LF, but a stray CRLF working copy must degrade to
  // TOLERATED, never to "torn": before this guard, repairMonthFile would
  // truncate a CRLF file line by line back to the header.
  const dir = freshDir();
  await walk(dir, { maxBuckets: 1 });
  const file = join(dir, "draws", listMonthFiles(join(dir, "draws"))[0]);
  const lf = readFileSync(file, "utf8");
  writeFileSync(file, lf.replace(/\n/g, "\r\n"));
  eq(repairMonthFile(file), 0, "repair must cut NOTHING from a CRLF file");
  const recs = allRecords(dir);
  ok(recs.length > 0, "records parse through CRLF");
  const { fatal } = validateChain(null, recs);
  ok(!fatal, "chain clean through CRLF");
  rmSync(dir, { recursive: true, force: true });
});

await check("HTTP failure surfaces as fetch-failed and leaves the archive untouched", async () => {
  const dir = freshDir();
  await walk(dir, { maxBuckets: 1 });
  const before = allRecords(dir).length;
  const r = await walk(dir, { maxBuckets: 2, overrides: { "2026-01-01T01": "http500" } });
  ok(r.stopped.startsWith("fetch-failed"), `got "${r.stopped}"`);
  eq(allRecords(dir).length, before, "nothing appended");
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nBucket walk: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
