/* KenoGO Oracle — audit gates: freshness vs the wall clock, catch-up
 * honesty, stats drift, chain tamper.
 *
 * Spawns scripts/audit-data.mjs against synthetic archives (--data-dir) with
 * a deterministic clock (--as-of), pinning the quickpick-au H3 lesson in
 * this repo's terms: cadence math anchored to the file cannot see staleness,
 * so freshness anchors to the CLOCK — with a catch-up carve-out while the
 * one-off backfill legitimately owns a large gap, which --strict ignores.
 * Zero dependencies.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAP_160_MS, appendRecords, headsTailsOf, toCsvLine, writeJsonAtomic, writeStats
} from "../scripts/lib.mjs";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const AUDIT = fileURLToPath(new URL("../scripts/audit-data.mjs", import.meta.url));

function runAudit(dataDir, ...args) {
  const r = spawnSync(process.execPath, [AUDIT, `--data-dir=${dataDir}`, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/* Synthetic steady-state archive: 200 draws at 160 s, deep in the 160 s era. */
const T0 = Date.parse("2026-01-01T00:00:00Z");
const N = 200;
const TAIL_MS = T0 + (N - 1) * GAP_160_MS;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function makeRec(ms, i) {
  const numbers = Array.from({ length: 20 }, (_, k) => 1 + ((k * 4 + i) % 80));
  return {
    drawingDate: iso(ms), ms, externalId: String(1 + (i % 999)), numbers,
    headsTails: headsTailsOf(numbers), jackpotLevel: "regular", bonusFactor: 1
  };
}

async function makeArchive() {
  const dir = mkdtempSync(join(tmpdir(), "kg-fresh-"));
  const recs = Array.from({ length: N }, (_, i) => makeRec(T0 + i * GAP_160_MS, i));
  await appendRecords(join(dir, "draws"), recs);
  await writeStats(dir);
  await writeJsonAtomic(join(dir, "cursor.json"), {
    nextBucket: "2026-01-01T09", lastDrawingDate: iso(TAIL_MS), discoveredFloor: "2026-01-01T00"
  });
  return dir;
}

/* --------------------------------------------------------- the gates */

await check("current archive is CLEAN, both default and --strict", async () => {
  const dir = await makeArchive();
  const asOf = iso(TAIL_MS + 5 * 60_000); // 5 minutes on
  const lax = runAudit(dir, `--as-of=${asOf}`);
  eq(lax.code, 0, `default exit (out: ${lax.out.slice(-300)})`);
  ok(/AUDIT CLEAN/.test(lax.out), "default must report clean");
  const strict = runAudit(dir, "--strict", `--as-of=${asOf}`);
  eq(strict.code, 0, "strict exit");
  ok(/STRICT/.test(strict.out), "strict announces itself");
  rmSync(dir, { recursive: true, force: true });
});

await check("stale-but-not-catch-up HARD-FAILS freshness and names the Action", async () => {
  const dir = await makeArchive();
  const asOf = iso(TAIL_MS + 12 * 3600 * 1000); // 12 h behind: > one cycle, < catch-up
  const { code, out } = runAudit(dir, `--as-of=${asOf}`);
  eq(code, 1, "must exit 1");
  ok(/FAIL freshness/.test(out), "must name freshness");
  ok(/6-hourly update Action has not landed data/.test(out), "must point at the pipeline, not the data");
  ok(!/CATCH-UP/.test(out), "12 h is staleness, not catch-up");
  rmSync(dir, { recursive: true, force: true });
});

await check("catch-up gap is REPORTED clean by default — and still FAILS under --strict", async () => {
  const dir = await makeArchive();
  const asOf = iso(TAIL_MS + 72 * 3600 * 1000); // 3 days behind: backfill territory
  const lax = runAudit(dir, `--as-of=${asOf}`);
  eq(lax.code, 0, "catch-up must not fail the default audit");
  ok(/CATCH-UP MODE/.test(lax.out), "must say so in so many words");
  ok(/backfill owns this gap|local backfill owns/.test(lax.out), "must explain who owns the gap");
  const strict = runAudit(dir, "--strict", `--as-of=${asOf}`);
  eq(strict.code, 1, "--strict tolerates nothing");
  ok(/FAIL freshness/.test(strict.out), "strict names freshness");
  rmSync(dir, { recursive: true, force: true });
});

await check("freshness budget boundary: exactly at budget passes, one draw past fails", async () => {
  const dir = await makeArchive();
  const BUDGET = 164; // NORMAL_BUDGET_DRAWS in audit-data.mjs — ceil(7.25 h at 160 s)
  const onBudget = runAudit(dir, `--as-of=${iso(TAIL_MS + BUDGET * GAP_160_MS)}`);
  eq(onBudget.code, 0, "at the budget line");
  const over = runAudit(dir, `--as-of=${iso(TAIL_MS + (BUDGET + 1) * GAP_160_MS)}`);
  eq(over.code, 1, "one scheduled draw past the budget");
  rmSync(dir, { recursive: true, force: true });
});

await check("a drifted stats.json HARD-FAILS in steady state", async () => {
  const dir = await makeArchive();
  const tampered = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8"));
  tampered.n += 1;
  writeFileSync(join(dir, "stats.json"), JSON.stringify(tampered) + "\n");
  const { code, out } = runAudit(dir, `--as-of=${iso(TAIL_MS + 60_000)}`);
  eq(code, 1);
  ok(/FAIL stats/.test(out) && /lying footer/.test(out), "must call the drift what it is");
  rmSync(dir, { recursive: true, force: true });
});

await check("a missing stats.json HARD-FAILS in steady state", async () => {
  const dir = await makeArchive();
  rmSync(join(dir, "stats.json"));
  const { code, out } = runAudit(dir, `--as-of=${iso(TAIL_MS + 60_000)}`);
  eq(code, 1);
  ok(/FAIL stats/.test(out), "must name stats");
  rmSync(dir, { recursive: true, force: true });
});

await check("an off-cadence line HARD-FAILS the chain gate", async () => {
  const dir = await makeArchive();
  const rec = makeRec(TAIL_MS + 150_000, N); // 150 s gap — no era allows it
  appendFileSync(join(dir, "draws", "2026-01.csv"), toCsvLine(rec) + "\n");
  const { code, out } = runAudit(dir, `--as-of=${iso(TAIL_MS + 300_000)}`);
  eq(code, 1);
  ok(/FAIL chain/.test(out), "must name the chain");
  rmSync(dir, { recursive: true, force: true });
});

await check("an UNLEDGERED missed slot fails; the SAME gap ledgered reconciles", async () => {
  const dir = await makeArchive();
  // Append a record two slots on — a skipped slot that nobody ledgered.
  const rec = makeRec(TAIL_MS + 2 * GAP_160_MS, N);
  appendFileSync(join(dir, "draws", "2026-01.csv"), toCsvLine(rec) + "\n");
  const asOf = iso(TAIL_MS + 2 * GAP_160_MS + 60_000);
  const before = runAudit(dir, `--as-of=${asOf}`);
  eq(before.code, 1, "unledgered gap must fail");
  ok(/FAIL chain/.test(before.out) || /FAIL ledger/.test(before.out), "chain or ledger names it");
  // Now ledger exactly what the walk would have ledgered, and rebuild stats.
  await writeJsonAtomic(join(dir, "anomalies.json"), [{
    type: "missed-slots",
    detail: `1 skipped slot(s) before ${rec.drawingDate} (gap 320s at 160s cadence)`
  }]);
  await writeStats(dir);
  const after = runAudit(dir, `--as-of=${asOf}`);
  eq(after.code, 0, `ledgered gap must reconcile (out: ${after.out.slice(-400)})`);
  ok(/1 missed slot/.test(after.out) || /missed = /.test(after.out), "the ledger shows in the reconciliation");
  rmSync(dir, { recursive: true, force: true });
});

await check("--as-of rejects anything but a full UTC instant", async () => {
  const dir = await makeArchive();
  for (const bad of ["--as-of=2026-08-13", "--as-of=yesterday", "--as-of=2026-13-45T00:00:00Z", "--as-of="]) {
    const { code } = runAudit(dir, bad);
    eq(code, 2, `"${bad}" must exit 2`);
  }
  rmSync(dir, { recursive: true, force: true });
});

await check("an empty data dir reports empty and exits clean (pre-backfill state)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kg-fresh-empty-"));
  const { code, out } = runAudit(dir, `--as-of=${iso(TAIL_MS)}`);
  eq(code, 0);
  ok(/archive is EMPTY/.test(out), "must say why there is nothing to gate");
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nAudit gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
