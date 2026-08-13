/* KenoGO Oracle — draw-history persistence (localStorage).
 *
 * Inherited doctrine from quickpick-au: a corrupt blob is DISCARDED, never
 * thrown — reading history must never be able to brick boot. A partially
 * corrupt list keeps its valid entries. Split out of app.js so the parse
 * path is testable without a DOM.
 */

export const HIST_KEY = "kg_history_v1";
export const HIST_MAX = 100;

const isIntArray = (a) => Array.isArray(a) && a.length > 0 && a.every((v) => Number.isInteger(v));

/** One history line: `{ n: [ints] }`. */
function validLine(l) {
  return !!l && typeof l === "object" && isIntArray(l.n);
}

/** One history entry as written by pushHistory. */
function validEntry(h) {
  return !!h && typeof h === "object" &&
    typeof h.name === "string" &&
    Number.isFinite(h.ts) &&
    Array.isArray(h.lines) && h.lines.length > 0 && h.lines.every(validLine);
}

/**
 * Parse + shape-check a raw localStorage value.
 * Always returns an array — never throws, for any input whatsoever.
 */
export function sanitizeHistory(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return []; // not JSON at all
  }
  if (!Array.isArray(parsed)) return []; // object, string, number, null
  return parsed.filter(validEntry).slice(0, HIST_MAX).map((h) => ({
    name: h.name,
    ts: h.ts,
    lines: h.lines.map((l) => ({ n: l.n.slice() }))
  }));
}

/** Read + sanitize from a Storage-like object. Never throws. */
export function loadHistory(storage) {
  try {
    return sanitizeHistory(storage.getItem(HIST_KEY));
  } catch {
    return []; // storage blocked (private mode, disabled cookies)
  }
}

/** Prepend an entry and persist, capped at HIST_MAX. Never throws. */
export function saveHistory(storage, entry) {
  const next = [entry, ...loadHistory(storage)].slice(0, HIST_MAX);
  try {
    storage.setItem(HIST_KEY, JSON.stringify(next));
  } catch { /* quota exceeded or blocked — non-fatal */ }
  return next;
}

/** Drop stored history. Never throws. */
export function clearHistory(storage) {
  try { storage.removeItem(HIST_KEY); } catch { /* ignore */ }
}
