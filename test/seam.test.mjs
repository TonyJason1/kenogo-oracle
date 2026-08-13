/* KenoGO Oracle — the era seam, end to end through the audit.
 *
 * Spawns scripts/audit-data.mjs (--data-dir, --as-of, --strict) against
 * synthetic archives that CROSS the 180s→160s changeover. What is pinned:
 * the measured seam reconciles under --strict with per-era slot math
 * (slots − ledgered missed = stored count, across the boundary); any other
 * straddling pair is refused even when a ledger entry blesses it — the law,
 * not the ledger, decides crossings; and a ledgered missed slot on the far
 * side of the seam still reconciles exactly. Zero dependencies.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERA_160_START_MS, ERA_180_END_MS, GAP_160_MS, GAP_180_MS,
  appendRecords, headsTailsOf, judgeGap, writeJsonAtomic, writeStats
} from "../scripts/lib.mjs";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const AUDIT = fileURLToPath(new URL("../scripts/audit-data.mjs", import.meta.url));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function runAudit(dataDir, ...args) {
  const r = spawnSync(process.execPath, [AUDIT, `--data-dir=${dataDir}`, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/* The committed ledger entry, hand-pinned: if judgeGap's detail format ever
 * drifts, this fixture fails before the real data/anomalies.json is orphaned. */
const SEAM_ENTRY = {
  type: "era-crossing",
  detail: "180s→160s era boundary: 2024-05-20T15:00:00Z → 2024-05-20T15:31:40Z (gap 1900s)"
};

function makeRec(ms, i) {
  const numbers = Array.from({ length: 20 }, (_, k) => 1 + ((k * 4 + i) % 80));
  return {
    drawingDate: iso(ms), ms, externalId: String(1 + (i % 999)), numbers,
    headsTails: headsTailsOf(numbers), jackpotLevel: "regular", bonusFactor: 1
  };
}

/** 60 draws at 180 s ending exactly on the seam, then 60 at 160 s from the
 * far side — optionally with the 160 s era shifted or holed. */
async function makeSeamArchive({ seamShiftMs = 0, drop160Index = null, ledger = [SEAM_ENTRY] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kg-seam-"));
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(makeRec(ERA_180_END_MS - (59 - i) * GAP_180_MS, i));
  for (let j = 0; j < 60; j++) {
    if (j === drop160Index) continue;
    recs.push(makeRec(ERA_160_START_MS + seamShiftMs + j * GAP_160_MS, 60 + j));
  }
  await appendRecords(join(dir, "draws"), recs);
  await writeJsonAtomic(join(dir, "anomalies.json"), ledger);
  await writeStats(dir);
  const tailMs = recs[recs.length - 1].ms;
  await writeJsonAtomic(join(dir, "cursor.json"), {
    nextBucket: iso(tailMs).slice(0, 13), lastDrawingDate: iso(tailMs), discoveredFloor: "2024-05-20T12"
  });
  return { dir, tailMs };
}

/* -------------------------------------------------------------- checks */

await check("the measured seam reconciles under --strict: per-era slots − ledger == count", async () => {
  const { dir, tailMs } = await makeSeamArchive();
  const { code, out } = runAudit(dir, "--strict", `--as-of=${iso(tailMs + GAP_160_MS)}`);
  eq(code, 0, `strict exit (out: ${out.slice(-400)})`);
  ok(/AUDIT CLEAN/.test(out), "must be clean");
  ok(/1 era crossing/.test(out), "the chain walk must see exactly one era crossing");
  ok(/cadence math reconciles exactly — 120 slots − 0 missed = 120 draws/.test(out),
    `slot math must split 60 × 180 s + 60 × 160 s at the seam with the 1900 s pause contributing nothing (out: ${out.slice(-400)})`);
  rmSync(dir, { recursive: true, force: true });
});

await check("a 1920 s seam FAILS even with a matching ledger entry — no wildcard", async () => {
  const shifted = {
    type: "era-crossing",
    detail: "180s→160s era boundary: 2024-05-20T15:00:00Z → 2024-05-20T15:32:00Z (gap 1920s)"
  };
  const { dir, tailMs } = await makeSeamArchive({ seamShiftMs: 20_000, ledger: [shifted] });
  const { code, out } = runAudit(dir, "--strict", `--as-of=${iso(tailMs + GAP_160_MS)}`);
  eq(code, 1, "must exit 1");
  ok(/FAIL chain/.test(out), "the chain gate must name it");
  ok(/off-seam era crossing/.test(out), "must say the law it broke");
  rmSync(dir, { recursive: true, force: true });
});

await check("a hole ON the seam (first 160 s draw missing) is refused, never absorbed", async () => {
  const { dir, tailMs } = await makeSeamArchive({ drop160Index: 0 });
  const { code, out } = runAudit(dir, "--strict", `--as-of=${iso(tailMs + GAP_160_MS)}`);
  eq(code, 1, "must exit 1");
  ok(/FAIL chain/.test(out) && /off-seam era crossing/.test(out),
    "a 2060 s straddle is off-seam corruption, not a bigger changeover");
  rmSync(dir, { recursive: true, force: true });
});

await check("a ledgered missed slot BEYOND the seam still reconciles across the boundary", async () => {
  const dropped = 30; // slot 30 of the 160 s era never draws
  const before = ERA_160_START_MS + (dropped + 1) * GAP_160_MS;
  const missedEntry = judgeGap(before - 2 * GAP_160_MS, before).ledger;
  ok(missedEntry?.type === "missed-slots", "fixture sanity: the gap must judge as missed-slots");
  const { dir, tailMs } = await makeSeamArchive({ drop160Index: dropped, ledger: [SEAM_ENTRY, missedEntry] });
  const { code, out } = runAudit(dir, "--strict", `--as-of=${iso(tailMs + GAP_160_MS)}`);
  eq(code, 0, `strict exit (out: ${out.slice(-400)})`);
  ok(/cadence math reconciles exactly — 120 slots − 1 missed = 119 draws/.test(out),
    `the equation must hold across the seam with a ledgered pause AND a ledgered miss (out: ${out.slice(-400)})`);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nEra seam: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
