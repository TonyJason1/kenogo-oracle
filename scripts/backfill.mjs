/* KenoGO Oracle — local archive backfill.
 *
 *   npm run backfill                       # walk from the floor (or resume) to now
 *   node scripts/backfill.mjs --max-buckets 5 --verbose
 *
 * Oldest-first hour-bucket walk at 1 request/second with the honest UA —
 * ~33.5k buckets ≈ 9 h for the full archive. Interruptible at ANY point
 * (Ctrl-C, kill, power loss): resume truth is the files on disk — the tail
 * record decides the restart bucket, its bucket is re-fetched and deduped,
 * and a torn final CSV line is repaired before anything is appended.
 *
 * NEVER run this in GitHub Actions. The 6-hourly updater refuses to walk
 * while the archive is in catch-up (see update-data.mjs) precisely so the
 * two can never fight over the cursor.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FLOOR_BUCKET, bucketStartMs, lastRecordOnDisk, walkBuckets
} from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const maxIdx = args.indexOf("--max-buckets");
const maxBuckets = maxIdx !== -1 ? Number(args[maxIdx + 1]) : Infinity;
if (maxIdx !== -1 && (!Number.isInteger(maxBuckets) || maxBuckets < 1)) {
  console.error(`--max-buckets must be a positive integer, got "${args[maxIdx + 1]}"`);
  process.exit(2);
}

const HOUR_MS = 3_600_000;
const startTail = lastRecordOnDisk(join(DATA_DIR, "draws"));
const startMs = startTail ? startTail.ms : bucketStartMs(FLOOR_BUCKET);
const totalBuckets = Math.max(1, Math.ceil((Date.now() - startMs) / HOUR_MS));

console.log(`backfill: ${startTail ? `resuming after ${startTail.drawingDate}` : `starting at the floor (${FLOOR_BUCKET})`}`);
console.log(`backfill: ~${totalBuckets.toLocaleString("en-AU")} buckets to walk at 1 req/s (~${(totalBuckets / 3600).toFixed(1)} h)\n`);

let walked = 0;
const t0 = Date.now();
const heartbeat = (line) => {
  walked++;
  if (verbose) { console.log(line); return; }
  if (walked % 100 === 0) {
    const rate = walked / ((Date.now() - t0) / 1000);
    const etaH = (totalBuckets - walked) / rate / 3600;
    console.log(`  ${walked.toLocaleString("en-AU")}/${totalBuckets.toLocaleString("en-AU")} buckets ` +
      `(${(100 * walked / totalBuckets).toFixed(1)}%) — ETA ${etaH.toFixed(1)} h — ${line.trim()}`);
  }
};

const result = await walkBuckets({
  dataDir: DATA_DIR,
  maxBuckets,
  delayMs: 1000,
  log: heartbeat
});

console.log(`\nbackfill: ${result.buckets.toLocaleString("en-AU")} buckets fetched, ` +
  `${result.draws.toLocaleString("en-AU")} draws added, ${result.skipped} non-finished skipped, ` +
  `${result.ledgered} anomalies ledgered`);
console.log(`backfill: archive tail ${result.tail?.drawingDate ?? "EMPTY"}`);
console.log(`backfill: stopped — ${result.stopped}`);

const clean = result.stopped === "caught-up" || result.stopped === "max-buckets";
if (!clean) {
  console.error("\nThe stop reason above is a refusal, not an error in this script: the walk");
  console.error("halts rather than store suspect data. Re-run to retry from the same position.");
}
process.exit(clean ? 0 : 1);
