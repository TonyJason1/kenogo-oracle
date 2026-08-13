/* Regenerates week-freq.json + bucket-sample.json from the 2026-08-13 probe
 * session's raw capture (168 hourly buckets, 2026-08-06T00 .. 2026-08-12T23,
 * n = 3,780 draws — the week the feasibility report's chi-square preview was
 * computed on: raw 48.14, keno-corrected ×79/60 = 63.38, p ≈ 0.90).
 *
 *   node test/fixtures/make-week-freq.mjs <path-to-probe-bulk-dir>
 *
 * The capture directory was a session scratchpad and is not expected to
 * survive; the JSON artifacts these produce are the pinned fixtures. This
 * script is committed for provenance — it shows exactly how they were made.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const bulkDir = process.argv[2];
if (!bulkDir) {
  console.error("usage: node test/fixtures/make-week-freq.mjs <probe-bulk-dir>");
  process.exit(2);
}

const files = readdirSync(bulkDir).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.json$/.test(f)).sort();
const freq = new Array(80).fill(0);
let n = 0;
let firstDate = null, lastDate = null;
let sampleWritten = false;

for (const f of files) {
  const { items } = JSON.parse(readFileSync(join(bulkDir, f), "utf8"));
  for (const it of items) {
    if (it.state !== "finished") continue;
    for (const ball of it.numbers) freq[ball - 1]++;
    n++;
    if (!firstDate) firstDate = it.drawingDate;
    lastDate = it.drawingDate;
  }
  if (!sampleWritten) {
    // one real bucket, odds/tickets stripped — the parseItem test fixture
    const trimmed = items.map(({ odds, tickets, ticketDraw, ...rest }) => rest);
    writeFileSync(join(HERE, "bucket-sample.json"),
      JSON.stringify({ source: `probe capture ${f}`, items: trimmed }, null, 1) + "\n");
    sampleWritten = true;
  }
}

writeFileSync(join(HERE, "week-freq.json"), JSON.stringify({
  source: "kenogo probe 2026-08-13 — full week 2026-08-06T00Z..2026-08-12T23Z",
  n,
  firstDate,
  lastDate,
  freq
}, null, 1) + "\n");

console.log(`week-freq.json: n=${n} draws over ${files.length} buckets, ball total ${freq.reduce((a, b) => a + b, 0)}`);
