/* KenoGO Oracle — incremental archive update (the 6-hourly Action entrypoint).
 *
 *   npm run update-data
 *
 * Walks at most RUN_BUCKETS hour buckets from the archive tail (its bucket is
 * re-fetched and deduped — the walk engine is the same code the backfill
 * runs), then rebuilds data/stats.json from the files on disk.
 *
 * CATCH-UP GUARD: while the tail is more than CATCHUP_BUCKETS behind the wall
 * clock — i.e. the local backfill has not finished its one-off walk — this
 * script exits 0 WITHOUT fetching or writing anything. The Action must never
 * crawl the gap seven buckets at a time, never race the local backfill for
 * the cursor, and never open failure issues about a state that is expected.
 * It takes over automatically on the first run after the backfill lands.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CATCHUP_BUCKETS, RUN_BUCKETS, bucketsBetween, lastRecordOnDisk,
  walkBuckets, writeStats
} from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");

/** Tell the Action which mode this run took, so its later steps (strict
 * audit, tests, commit) can skip in catch-up instead of failing on the
 * expected staleness. No-op outside Actions. */
function emitMode(mode) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
}

const tail = lastRecordOnDisk(join(DATA_DIR, "draws"));
if (!tail) {
  console.log("update-data: archive is EMPTY — the one-off local backfill has not landed yet.");
  console.log("update-data: catch-up mode, nothing fetched, exiting clean.");
  emitMode("catchup");
  process.exit(0);
}

const gap = bucketsBetween(tail.ms, Date.now());
if (gap > CATCHUP_BUCKETS) {
  console.log(`update-data: archive tail ${tail.drawingDate} is ~${gap} buckets behind the clock ` +
    `(catch-up threshold ${CATCHUP_BUCKETS}).`);
  console.log("update-data: the local backfill owns the walk until the gap closes — nothing fetched, exiting clean.");
  emitMode("catchup");
  process.exit(0);
}
emitMode("steady");

console.log(`update-data: incremental walk from ${tail.drawingDate} (gap ~${gap} buckets, cap ${RUN_BUCKETS})\n`);

const result = await walkBuckets({
  dataDir: DATA_DIR,
  maxBuckets: RUN_BUCKETS,
  delayMs: 1000,
  log: (line) => console.log(line)
});

console.log(`\nupdate-data: ${result.buckets} buckets fetched, ${result.draws} draws added, ` +
  `${result.skipped} non-finished skipped, ${result.ledgered} anomalies ledgered`);
console.log(`update-data: archive tail ${result.tail?.drawingDate ?? "EMPTY"} (${result.stopped})`);

const clean = result.stopped === "caught-up" || result.stopped === "max-buckets";
if (!clean) {
  console.error("\nupdate-data: REFUSED to store suspect data — see the stop reason above.");
  console.error("data/draws/ keeps its last good state; the next run retries from the same position.");
  process.exit(1);
}

const stats = await writeStats(DATA_DIR);
console.log(`update-data: stats.json rebuilt — n=${stats.n.toLocaleString("en-AU")}, data through ${stats.dataThrough}`);
