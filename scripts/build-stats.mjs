/* KenoGO Oracle — rebuild data/stats.json from the CSVs on disk.
 *
 *   npm run stats
 *
 * Deterministic: same archive bytes → same stats.json bytes (no wall-clock
 * field), which is what lets the audit re-derive and byte-compare it.
 * The updater calls the same writeStats after every walk; this CLI exists for
 * local runs (e.g. after a backfill session).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeStats } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stats = await writeStats(join(ROOT, "data"));

if (!stats) {
  console.log("build-stats: archive is empty — no stats.json written.");
  process.exit(0);
}
console.log(`build-stats: n=${stats.n.toLocaleString("en-AU")} draws, ` +
  `${stats.firstDraw} → ${stats.dataThrough}`);
const top = stats.freq
  .map((c, i) => [i + 1, c])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([b, c]) => `${b}×${c}`)
  .join(", ");
console.log(`build-stats: top balls ${top}`);
