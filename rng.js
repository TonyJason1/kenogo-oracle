/* KenoGO Oracle — cryptographically secure RNG core.
 * Shared by app.js (browser) and test/rng.test.mjs (Node >= 18).
 * crypto.getRandomValues only. Rejection sampling — zero modulo bias.
 * Sampling without replacement via partial Fisher–Yates.
 * Copied from quickpick-au (same doctrine, same tests).
 */

const cryptoObj =
  globalThis.crypto ?? (await import("node:crypto")).webcrypto;

// Buffered uint32 stream (getRandomValues per-call overhead amortised).
const BUF = new Uint32Array(4096);
let bufIdx = BUF.length;

function nextU32() {
  if (bufIdx >= BUF.length) {
    cryptoObj.getRandomValues(BUF);
    bufIdx = 0;
  }
  return BUF[bufIdx++];
}

const TWO_32 = 0x100000000; // 2^32

/**
 * Unbiased integer in [0, maxExclusive) via rejection sampling.
 */
export function secureInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > TWO_32) {
    throw new RangeError(`secureInt: maxExclusive out of range: ${maxExclusive}`);
  }
  const limit = TWO_32 - (TWO_32 % maxExclusive); // largest multiple of maxExclusive <= 2^32
  let x;
  do {
    x = nextU32();
  } while (x >= limit);
  return x % maxExclusive;
}

/**
 * Validate a game matrix. Throws on invalid.
 */
export function validateMatrix(pool, picks) {
  if (!Number.isInteger(pool) || pool < 2 || pool > 999) {
    throw new RangeError(`validateMatrix: pool out of range: ${pool}`);
  }
  if (!Number.isInteger(picks) || picks < 1 || picks > pool) {
    throw new RangeError(`validateMatrix: picks out of range: ${picks} (pool ${pool})`);
  }
}

/**
 * Draw `picks` distinct numbers from 1..pool, without replacement,
 * using a partial Fisher–Yates shuffle driven by secureInt.
 * Returns a sorted ascending array.
 */
export function drawLine(pool, picks) {
  validateMatrix(pool, picks);
  const arr = new Array(pool);
  for (let i = 0; i < pool; i++) arr[i] = i + 1;
  for (let i = 0; i < picks; i++) {
    const j = i + secureInt(pool - i);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr.slice(0, picks).sort((a, b) => a - b);
}

/**
 * Cosmetic shuffle of a copy (used only for ball-release order — presentation).
 */
export function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
