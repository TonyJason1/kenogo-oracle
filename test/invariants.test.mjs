/* KenoGO Oracle — data-doctrine invariants, each one named.
 *
 * These pin the laws in CLAUDE.md against the exact code the pipeline runs
 * (scripts/lib.mjs): the chain-gap law per era, the era-crossing and
 * missed-slot ledger paths, the drawingDate dedup key, the externalId
 * wrap-collision survival, the side-bet cross-checks, and the CSV round
 * trip. Zero dependencies — the 6-hourly Action runs this suite.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CSV_HEADER, ERA_160_START_MS, GAP_160_MS, GAP_180_MS, MAX_MISSED_SLOTS,
  appendRecords, bucketOf, bucketUrl, bucketsBetween, headsTailsOf, judgeGap,
  monthOf, nextBucket, parseCsvLine, parseItem, readAllRecords, toCsvLine,
  toZ, validateChain
} from "../scripts/lib.mjs";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/bucket-sample.json", import.meta.url), "utf8"));

/** A synthetic valid record with a consistent headsTails. */
function makeRec(ms, externalId = "500", rotate = 0) {
  const numbers = Array.from({ length: 20 }, (_, i) => 1 + ((i * 4 + rotate) % 80));
  return {
    drawingDate: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ms,
    externalId,
    numbers,
    headsTails: headsTailsOf(numbers),
    jackpotLevel: "regular",
    bonusFactor: 1
  };
}

/* --------------------------------------------------- parseItem (payload) */

check("every item in a real captured bucket parses to a record", () => {
  let recs = 0;
  for (const raw of SAMPLE.items) {
    const p = parseItem(raw);
    ok(p.rec, `rejected real item: ${p.reason ?? "skipped"}`);
    recs++;
    ok(!("odds" in p.rec) && !("jackpots" in p.rec) && !("id" in p.rec),
      "record must carry no odds/jackpots/uuid — facts only");
    eq(p.rec.drawingDate.endsWith("Z"), true, "drawingDate normalised to Z");
  }
  eq(recs, SAMPLE.items.length, "all finished items parse");
});

check("numbers keep their DRAWING ORDER through parse and CSV", () => {
  const raw = SAMPLE.items[0];
  const { rec } = parseItem(raw);
  eq(rec.numbers.join(" "), raw.numbers.join(" "), "parse must not sort");
  const round = parseCsvLine(toCsvLine(rec));
  eq(round.numbers.join(" "), raw.numbers.join(" "), "CSV must not sort");
});

check("a scheduled/open draw is skipped, never archived", () => {
  const p = parseItem({ ...SAMPLE.items[0], state: "opened" });
  ok(p.skip && !p.rec, "non-finished must be a skip");
});

check("garbled numbers are rejected: wrong count, duplicate, out of range", () => {
  const base = SAMPLE.items[0];
  for (const numbers of [
    base.numbers.slice(0, 19),                    // 19 balls
    [...base.numbers.slice(0, 19), base.numbers[0]], // duplicate
    [...base.numbers.slice(0, 19), 81],           // out of pool
    [...base.numbers.slice(0, 19), 0]             // below pool
  ]) {
    const p = parseItem({ ...base, numbers });
    ok(p.err, `must reject numbers=${JSON.stringify(numbers).slice(0, 60)}...`);
  }
});

check("headsTails cross-check: payload disagreeing with its own numbers is rejected", () => {
  const base = SAMPLE.items.find((i) => i.sideBetResults.headsTails !== "evens");
  const flipped = base.sideBetResults.headsTails === "heads" ? "tails" : "heads";
  const p = parseItem({ ...base, sideBetResults: { ...base.sideBetResults, headsTails: flipped } });
  ok(p.err && /cross-check/.test(p.reason), "must reject a lying headsTails");
});

check("side-bet enums outside the pinned sets are rejected (verify-before-hardcode tripwire)", () => {
  const base = SAMPLE.items[0];
  ok(parseItem({ ...base, sideBetResults: { ...base.sideBetResults, jackpot: "mega" } }).err, "unknown jackpot level");
  ok(parseItem({ ...base, sideBetResults: { ...base.sideBetResults, bonus: 7 } }).err, "unknown bonus factor");
  ok(parseItem({ ...base, sideBetResults: null }).err, "missing sideBetResults");
});

check("externalId outside the pinned 1..999 counter is rejected", () => {
  const base = SAMPLE.items[0];
  for (const bad of ["0", "1000", "abc", ""]) {
    ok(parseItem({ ...base, externalId: bad }).err, `externalId "${bad}" must be rejected`);
  }
});

check("headsTailsOf: majority-low, majority-high, and the exact 10/10 split", () => {
  const low = Array.from({ length: 20 }, (_, i) => i + 1);          // all ≤ 40
  const high = Array.from({ length: 20 }, (_, i) => i + 61);        // all > 40
  const split = [...Array.from({ length: 10 }, (_, i) => i + 1),
                 ...Array.from({ length: 10 }, (_, i) => i + 41)];
  eq(headsTailsOf(low), "heads");
  eq(headsTailsOf(high), "tails");
  eq(headsTailsOf(split), "evens");
});

/* ------------------------------------------------ the chain-gap law */

const T160 = ERA_160_START_MS + 30 * 24 * 3600 * 1000; // deep in the 160s era
const T180 = ERA_160_START_MS - 30 * 24 * 3600 * 1000; // deep in the 180s era

check("gap-160s-post-2024-05-21: exactly 160 s is the only clean gap", () => {
  ok(judgeGap(T160, T160 + GAP_160_MS).ok, "exact 160 s must pass");
  ok(judgeGap(T160, T160 + GAP_180_MS).ledger?.type !== "era-crossing" &&
     !judgeGap(T160, T160 + GAP_180_MS).ok, "180 s in the 160 s era must not be clean");
  ok(judgeGap(T160, T160 + 161_000).fatal, "161 s must be fatal");
  ok(judgeGap(T160, T160 + 159_000).fatal, "159 s must be fatal");
});

check("gap-180s-pre-2024-05-21: exactly 180 s is the only clean gap", () => {
  ok(judgeGap(T180, T180 + GAP_180_MS).ok, "exact 180 s must pass");
  ok(judgeGap(T180, T180 + 160_000).fatal, "160 s in the 180 s era must be fatal");
  ok(judgeGap(T180, T180 + 181_000).fatal, "181 s must be fatal");
});

check("missed-slots: an exact cadence multiple is LEDGERED, never silent, never clean", () => {
  const j = judgeGap(T160, T160 + 3 * GAP_160_MS); // 2 skipped slots
  ok(!j.ok && !j.fatal && j.ledger?.type === "missed-slots", "must ledger");
  ok(/2 skipped slot/.test(j.ledger.detail), "must name the count");
  const beyond = judgeGap(T160, T160 + (MAX_MISSED_SLOTS + 2) * GAP_160_MS);
  ok(beyond.fatal, "beyond MAX_MISSED_SLOTS must be fatal (suspected API hole)");
});

check("era-crossing: the single boundary pair is ledgered with its measured gap", () => {
  const prev = ERA_160_START_MS - 100_000, later = ERA_160_START_MS + 70_000;
  const j = judgeGap(prev, later);
  ok(j.ledger?.type === "era-crossing", "must ledger the crossing");
  ok(/170s/.test(j.ledger.detail), "must record the measured gap");
  ok(judgeGap(prev, prev + 49 * 3600 * 1000).fatal, "a 49 h 'crossing' is a hole, not a boundary");
});

check("non-increasing drawingDate is fatal", () => {
  ok(judgeGap(T160, T160).fatal, "zero gap");
  ok(judgeGap(T160, T160 - 1).fatal, "negative gap");
});

check("validateChain aggregates ledgers and stops at the first fatal", () => {
  const a = makeRec(T160), b = makeRec(T160 + GAP_160_MS), c = makeRec(T160 + 4 * GAP_160_MS);
  const good = validateChain(null, [a, b, c]);
  ok(!good.fatal, "clean chain with one ledgered skip");
  eq(good.ledger.length, 1, "one ledger entry");
  const bad = validateChain(a.ms, [makeRec(T160 + 111_111)]);
  ok(bad.fatal, "off-cadence from the tail must be fatal");
});

/* ------------------------------------ dedup key + wrap-collision + CSV */

const tmp = mkdtempSync(join(tmpdir(), "kg-inv-"));

await checkAsync("externalId-wrap-collision: same externalId on different dates BOTH survive", async () => {
  const dir = join(tmp, "draws-wrap");
  const a = makeRec(T160, "5", 0);
  const b = makeRec(T160 + GAP_160_MS, "5", 3); // counter wrapped — same id, later draw
  await appendRecords(dir, [a, b]);
  const all = [...readAllRecords(dir)];
  eq(all.length, 2, "both records survive");
  eq(all[0].externalId, "5");
  eq(all[1].externalId, "5");
  ok(all[0].drawingDate !== all[1].drawingDate, "distinguished by drawingDate, the only key");
});

await checkAsync("CSV round-trip is lossless and the header is exactly the doctrine line", async () => {
  const dir = join(tmp, "draws-round");
  const rec = makeRec(T160, "999", 7);
  await appendRecords(dir, [rec]);
  const text = readFileSync(join(dir, `${monthOf(rec.drawingDate)}.csv`), "utf8");
  ok(text.startsWith(`${CSV_HEADER}\n`), "header line");
  const back = [...readAllRecords(dir)][0];
  eq(toCsvLine(back), toCsvLine(rec), "round-trip identity");
});

check("parseCsvLine rejects every tampered field", () => {
  const line = toCsvLine(makeRec(T160));
  const parts = line.split(",");
  const tampered = [
    line.replace("Z,", ","),                       // timestamp without Z
    [parts[0], parts[1], "1 2 3", ...parts.slice(3)].join(","),          // 3 numbers
    [parts[0], parts[1], parts[2], "sideways", parts[4], parts[5]].join(","), // bad ht
    [parts[0], parts[1], parts[2], parts[3], "colossal", parts[5]].join(","), // bad level
    [parts[0], parts[1], parts[2], parts[3], parts[4], "6"].join(","),   // bad bonus
    line + ",extra"                                                       // 7 fields
  ];
  for (const t of tampered) {
    let threw = false;
    try { parseCsvLine(t); } catch { threw = true; }
    ok(threw, `must reject: ${t.slice(0, 70)}`);
  }
});

/* ------------------------------------------------------- bucket algebra */

check("bucket algebra: hour buckets, month keys, URL format", () => {
  eq(bucketOf(Date.parse("2022-10-18T00:59:59Z")), "2022-10-18T00");
  eq(nextBucket("2022-10-31T23"), "2022-11-01T00", "month rollover");
  eq(monthOf("2022-10-18T23:57:00Z"), "2022-10");
  eq(bucketsBetween(Date.parse("2022-10-18T00:30:00Z"), Date.parse("2022-10-18T02:01:00Z")), 2);
  ok(bucketUrl("2022-10-18T00").includes("date=2022-10-18T00%3A00%3A00Z"), "the probed date format, URL-encoded");
  eq(toZ("2026-08-13T09:50:20+00:00"), "2026-08-13T09:50:20Z", "offset normalised");
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\nInvariants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
