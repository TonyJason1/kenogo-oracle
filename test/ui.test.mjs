/* KenoGO Oracle — DOM suite (jsdom; the one suite that needs npm ci).
 *
 * Tests the split browser modules against a real DOM and the static
 * index.html contract:
 *   - reveal: value-addressed slots, idempotence, skip completion
 *   - history: corrupt-blob salvage (a bad blob must never brick boot)
 *   - live: footer text, live top-up gap policy, failure → archive stands
 *   - index.html: control/ARIA wiring, the spot-count disclaimer, footer line
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pillsHTML, revealBall, revealRemaining, isFullyRevealed } from "../js/reveal.js";
import { HIST_KEY, HIST_MAX, loadHistory, sanitizeHistory, saveHistory } from "../js/history.js";
import { LIVE_MAX_BUCKETS, footerText, formatStamp, initFooter, liveTopUp } from "../js/live.js";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
function eq(a, b, what = "") { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const dom = new JSDOM("<!doctype html><body></body>");
const { document } = dom.window;

/* ------------------------------------------------------------- reveal */

function makeRow(line, placeholder = true) {
  const row = document.createElement("div");
  row.className = "line";
  row.innerHTML = `<span class="pills">${pillsHTML(line, { placeholder })}</span>`;
  return row;
}

await check("placeholders are aria-hidden and carry their value for addressing", () => {
  const row = makeRow({ nums: [3, 41, 80] });
  const slots = row.querySelectorAll(".pill.placeholder");
  eq(slots.length, 3);
  for (const s of slots) {
    eq(s.getAttribute("aria-hidden"), "true", "hidden until revealed");
    eq(s.textContent, "", "no digit spoiler");
    ok(s.dataset.n, "value stamp present");
  }
});

await check("a released ball lands in its OWN slot, whatever the release order", () => {
  const row = makeRow({ nums: [5, 17, 62] });
  ok(revealBall(row, 62), "62 first");
  const slot62 = row.querySelector('.pill[data-n="62"]');
  eq(slot62.textContent, "62", "digit in the right slot");
  ok(!slot62.classList.contains("placeholder"), "revealed");
  eq(row.querySelector('.pill[data-n="5"]').classList.contains("placeholder"), true,
    "other slots untouched");
});

await check("reveal is idempotent and rejects balls not in the line", () => {
  const row = makeRow({ nums: [1, 2] });
  ok(revealBall(row, 1), "first reveal fills");
  ok(!revealBall(row, 1), "second reveal is a no-op");
  ok(!revealBall(row, 79), "not in this line");
});

await check("revealRemaining completes a skipped line exactly", () => {
  const line = { nums: [7, 8, 9, 10] };
  const row = makeRow(line);
  revealBall(row, 8);
  const filled = revealRemaining(row, line);
  eq(filled, 3, "the three still hidden");
  ok(isFullyRevealed(row), "nothing left hidden");
});

/* ------------------------------------------------------------ history */

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

await check("corrupt blobs are DISCARDED, never thrown (boot can't brick)", () => {
  for (const raw of ["not json{", '"a string"', "42", "{}", "null", '[{"lines":[]}]']) {
    const out = sanitizeHistory(raw);
    ok(Array.isArray(out) && out.length === 0, `must salvage [] from ${raw}`);
  }
});

await check("a partially corrupt list keeps its valid entries", () => {
  const good = { name: "10-spot KenoGO", ts: 1, lines: [{ n: [1, 2, 3] }] };
  const out = sanitizeHistory(JSON.stringify([good, { junk: true }, { name: 5, ts: 2, lines: [] }]));
  eq(out.length, 1, "one survivor");
  eq(out[0].name, "10-spot KenoGO");
});

await check("saveHistory prepends and caps at HIST_MAX", () => {
  const storage = new MemStorage();
  for (let i = 0; i < HIST_MAX + 10; i++) {
    saveHistory(storage, { name: `e${i}`, ts: i, lines: [{ n: [i + 1] }] });
  }
  const out = loadHistory(storage);
  eq(out.length, HIST_MAX, "capped");
  eq(out[0].name, `e${HIST_MAX + 9}`, "newest first");
  ok(storage.getItem(HIST_KEY), "persisted under the pinned key");
});

/* --------------------------------------------------------------- live */

const STATS = { schema: 1, n: 1000, dataThrough: "2026-08-13T09:50:20Z" };
const jsonRes = (value) => ({ ok: true, status: 200, json: async () => value });

await check("footer text carries stamp + count, and the live variant says so", () => {
  eq(footerText(STATS), " · draws to 13 Aug 2026 09:50 UTC · 1,000 draws");
  const live = footerText(STATS, { newDraws: 25, dataThrough: "2026-08-13T11:00:00Z" });
  ok(/1,025 draws · live$/.test(live), `live count + marker (got "${live}")`);
  eq(formatStamp("2026-01-02T03:04:00Z"), "02 Jan 2026 03:04 UTC");
});

await check("liveTopUp tightens when the gap is small, counting only newer finished draws", async () => {
  const throughMs = Date.parse(STATS.dataThrough);
  const mkItem = (ms, state = "finished") =>
    ({ state, drawingDate: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00") });
  const fetchImpl = async (url) => {
    if (!/date=/.test(url)) {
      // no-date window: recent finished + scheduled future + one already-archived
      return jsonRes({ items: [mkItem(throughMs), mkItem(throughMs + 160_000),
        mkItem(throughMs + 320_000), mkItem(throughMs + 480_000, "opened")] });
    }
    return jsonRes({ items: [mkItem(throughMs + 160_000)] }); // bucket overlap — must dedupe
  };
  const live = await liveTopUp(STATS, { fetchImpl, now: () => throughMs + 30 * 60_000 });
  ok(live, "top-up must succeed");
  eq(live.newDraws, 2, "two NEW finished draws (archived + scheduled excluded, overlap deduped)");
  eq(live.dataThrough, "2026-08-13T09:55:40Z", "tightened to the newest live draw");
});

await check(`liveTopUp refuses a gap wider than ${LIVE_MAX_BUCKETS} buckets (backfill territory)`, async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return jsonRes({ items: [] }); };
  const wide = await liveTopUp(STATS, {
    fetchImpl, now: () => Date.parse(STATS.dataThrough) + (LIVE_MAX_BUCKETS + 2) * 3_600_000
  });
  eq(wide, null, "must refuse");
  eq(called, 0, "must not fetch at all");
});

await check("liveTopUp failure leaves the archive footer standing (returns null)", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  const live = await liveTopUp(STATS, { fetchImpl, now: () => Date.parse(STATS.dataThrough) + 60_000 });
  eq(live, null);
});

await check("initFooter renders the archive stamp, then tightens to live", async () => {
  const el = document.createElement("span");
  const throughMs = Date.parse(STATS.dataThrough);
  const fetchImpl = async (url) => {
    if (/stats\.json$/.test(url)) return jsonRes(STATS);
    if (!/date=/.test(url)) {
      return jsonRes({ items: [{ state: "finished",
        drawingDate: new Date(throughMs + 160_000).toISOString().replace(/\.\d{3}Z$/, "+00:00") }] });
    }
    return jsonRes({ items: [] });
  };
  await initFooter(el, { fetchImpl, now: () => throughMs + 10 * 60_000 });
  ok(/1,001 draws · live$/.test(el.textContent), `tightened footer (got "${el.textContent}")`);
});

await check("initFooter with stats unreachable leaves the footer version-only", async () => {
  const el = document.createElement("span");
  el.textContent = "";
  await initFooter(el, { fetchImpl: async () => { throw new Error("offline"); } });
  eq(el.textContent, "", "untouched");
});

/* --------------------------------------------------- index.html contract */

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const page = new JSDOM(html).window.document;

await check("controls: spots and lines spinbuttons with sane defaults and bounds", () => {
  const spots = page.getElementById("spotsVal");
  eq(spots.getAttribute("role"), "spinbutton");
  eq(spots.getAttribute("aria-valuenow"), "10", "spots default 10");
  eq(spots.getAttribute("aria-valuemin"), "1");
  eq(spots.getAttribute("aria-valuemax"), "10");
  const lines = page.getElementById("linesVal");
  eq(lines.getAttribute("role"), "spinbutton");
  eq(lines.getAttribute("aria-valuenow"), "1", "lines default 1");
  eq(lines.getAttribute("aria-valuemax"), "10");
  eq(page.querySelectorAll("#pickControls .step-btn").length, 4, "two steppers");
});

await check("the disclaimer is reworded FOR SPOTS, verbatim", () => {
  const note = page.getElementById("barNote");
  eq(note.textContent.trim(),
    "For entertainment only — every combination of your spot count has identical odds.",
    "identical-odds claim must be scoped to a spot count — odds DIFFER between spot counts");
  ok(page.querySelector('a[href*="gamblinghelponline.org.au"]'), "gambling help link present");
});

await check("footer build line + dataThrough span + draw button are wired", () => {
  ok(page.getElementById("dataThrough"), "dataThrough span");
  ok(/v\d+\.\d+\.\d+/.test(page.querySelector(".build").textContent), "static version text");
  eq(page.getElementById("drawBtn").textContent, "DRAW");
  ok(page.getElementById("chamber"), "chamber canvas");
  ok(page.getElementById("revealStatus").getAttribute("aria-live"), "coalesced announcer");
});

console.log(`\nDOM suite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
