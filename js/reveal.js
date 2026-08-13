/* KenoGO Oracle — result-line rendering and the chamber reveal.
 *
 * Inherited from quickpick-au with the extra-ball path removed (keno has no
 * secondary barrel). The load-bearing idea survives intact: slots are
 * addressed by VALUE — each pill is stamped with data-n at build time and a
 * released ball can only ever land in its own slot, so the digit and the
 * accessible name are correct at every instant of the reveal, not just at
 * rest. Split out of app.js so it can be tested against a real DOM.
 */

/** One pill. Placeholders carry their ball value (so the reveal can find
 * them) but no accessible name — announcing a ball before it is revealed
 * would spoil the reveal. They are aria-hidden until revealed. */
export function pillHTML(n, { placeholder = false } = {}) {
  if (!Number.isInteger(n)) throw new TypeError(`pillHTML: ball must be an integer, got ${n}`);
  const cls = `pill${placeholder ? " placeholder" : ""}`;
  const attrs = [`class="${cls}"`, `data-n="${n}"`];
  if (placeholder) attrs.push('aria-hidden="true"');
  return `<span ${attrs.join(" ")}>${placeholder ? "" : n}</span>`;
}

/** Pills for one line (line = { nums: [ints] }). */
export function pillsHTML(line, { placeholder = false } = {}) {
  return line.nums.map((n) => pillHTML(n, { placeholder })).join("");
}

/**
 * Reveal ball `n` in its OWN slot. Returns true when a slot was filled,
 * false when that ball has already been revealed (or is not in this line) —
 * the caller uses that to stay idempotent across the skip path.
 */
export function revealBall(row, n) {
  if (!row || !Number.isInteger(n)) return false;
  const slot = row.querySelector(`.pill.placeholder[data-n="${n}"]`);
  if (!slot) return false;
  slot.classList.remove("placeholder");
  slot.classList.add("pop");
  slot.textContent = String(n);
  slot.removeAttribute("aria-hidden");
  return true;
}

/** Reveal every ball still hidden in `line` (the tap-to-skip path). */
export function revealRemaining(row, line) {
  let filled = 0;
  for (const n of line.nums) {
    if (revealBall(row, n)) filled++;
  }
  return filled;
}

/** True once no placeholder remains in the row. */
export function isFullyRevealed(row) {
  return !!row && row.querySelector(".pill.placeholder") === null;
}
