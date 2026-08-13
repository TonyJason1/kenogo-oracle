# KenoGO Oracle

Mobile-first PWA for KenoGO (kenogo.com.au): a cryptographically secure
quick-pick generator with an animated 80-ball chamber, on top of a complete
draw archive with live freshness. Vanilla HTML/CSS/JS — no frameworks, no
build step, **zero runtime dependencies**. Fully offline after first load.
Sibling project to [quickpick-au](https://github.com/TonyJason1/quickpick-au),
same doctrine.

**Selection is always `crypto.getRandomValues` with rejection sampling (no
modulo bias), sampling without replacement. The chamber is presentation only —
under frame pressure it degrades its ball count, never the selection.**

## The game

20 numbers from 1–80, drawn every **160 seconds, 24/7** (540 draws/day;
180 s per draw before the measured changeover at 2024-05-20T15:31:40Z).
Players pick 1–10 spots. Side bets: Heads/Tails/Evens (1–40 vs 41–80),
jackpot level, bonus multiplier.

The app: Spots 1–10 (default 10), Lines 1–10, DRAW → chamber reveal (tap
anywhere or Escape to skip; Fast-reveal toggle and reduced-motion get the
instant path), copy buttons, local history (100 entries, corrupt-blob-proof).
**For entertainment only — every combination of your spot count has identical
odds** (odds differ *between* spot counts; the fixed bar says the scoped
version verbatim).

## Data layer

`data/draws/YYYY-MM.csv` — monthly chunks, one draw per line:

    drawingDate,externalId,numbers,headsTails,jackpotLevel,bonusFactor

Facts only: 20 numbers **in drawn order**, UTC `Z` timestamps. Never stored:
odds/paytable blobs (7.7 KB per draw upstream), jackpot amounts, uuids.
`externalId` (the 1..999 wrapping game counter — not a key, not contiguous)
is kept for reconciliation only; the dedup/cursor key is `drawingDate`.

- **API** (probed 2026-08-13, no auth, CORS `*`):
  `GET https://api-kenogo.lttlapp.com/api/v1/draws?productId=kenoGo&currencyId=AUD&date=<UTC-hour>` —
  one hour bucket per request. Floor 2022-10-18T00Z (≈718k draws). All
  scripted fetchers use an honest UA at 1 request/second with retries.
- **The chain-gap law is the hole detector**: adjacent draws must gap exactly
  160 s (180 s pre-era). A gap that is a whole multiple of the cadence is
  recorded in `data/anomalies.json` (committed, loud) and accepted as a fact
  about the world; anything else refuses the write. The audit re-derives the
  whole chain and requires cadence math − ledgered slots = stored count,
  exactly.
- **`data/stats.json`** — the ONLY data file the client loads (per-ball freq,
  last-seen, recency-decayed freq at 540-draw half-life, n, data-through).
  Regenerated deterministically from the CSVs; drift is a hard audit failure.
- **Backfill** (`npm run backfill`) — one-off local walk from the floor, ~9 h
  at 1 req/s, interruptible + resumable at any point (the FILES are the
  resume truth; torn tails are repaired; its own bucket is refetched and
  deduped). Never runs in Actions.
- **6-hourly Action** (`.github/workflows/update-data.yml`) — cursor walk
  (≤10 buckets), validate-before-write, `--strict` audit, zero-dependency
  test suite, commit. While the archive is still catching up it exits 0
  without fetching — it must never race the local backfill — and takes over
  automatically once the gap is below 48 buckets. Failures open/comment a
  `pipeline-failure` issue. Actions are SHA-pinned; the data pipeline never
  runs `npm install`.
- **Footer** — "draws to \<stamp\> · N draws" from stats.json (rides the
  service worker's data cache; data commits need no version bump), tightened
  to "· live" client-side when the CORS-open API answers and the archive gap
  is ≤6 buckets. Any failure leaves the archive footer standing.

Terms note: kenogo.com.au T&C 7.6 (storage/republication) is the stated risk
of a public results archive; the stored draw numbers are facts. Same posture
as the sibling project's source.

## Audit

`npm run audit` reconciles offline: structure, the full chain-gap walk,
ledger math (slots − missed = stored, exactly), ball coverage, side-bet
histograms against the exact hypergeometric reference (report-only), stats
byte-drift, cursor sanity, and **freshness against the wall clock** with the
6-hourly budget — suspended honestly in catch-up mode, merciless under
`--strict` (which the Action runs after every walk). `--as-of=<UTC instant>`
makes the clock deterministic for tests.

## Tests

`npm test` = core (zero-dependency — what the data pipeline runs) + DOM
(jsdom). 111 checks: per-spot RNG χ² **with the without-replacement
correction ×(N−1)/(N−K)** (the fixture reproduces the probe week's real
3,780 draws: raw 48.14 → corrected 63.38 at 79 dof, p ≈ 0.90), the era
chain-gap laws, externalId wrap-collision survival, walk resumability /
refusal / torn-tail repair, audit gates, service-worker caching (shell
atomicity, data-cache survival across deploys), workflow supply-chain pins,
the version triple, and the reveal/history/live DOM contracts.

## Local dev

```powershell
npm run serve          # python http.server on :8080
npm test               # everything (core + DOM; DOM needs npm ci first)
npm run test:core      # zero-dependency suite — what the 6-hourly Action runs
npm run backfill       # one-off local archive walk (resumable; ~9 h full)
npm run update-data    # incremental walk + stats rebuild (catch-up-aware)
npm run stats          # rebuild data/stats.json from the CSVs
npm run audit          # offline reconciliation (--strict, --as-of=…)
npm run perf           # CDP perf harness — see docs/perf-baseline.md
npm run icons          # regenerate icons/ from SVG (sharp, canvas fallback)
```

**Dependencies:** the shipped app has **zero** runtime dependencies —
`package-lock.json` carries no production entries and CI fails if that ever
changes. `jsdom` and `sharp` are devDependencies only; the data pipeline
installs nothing.

## Deploy

Push to `main` → GitHub Pages serves the repo root at
`tonyjason1.github.io/kenogo-oracle`. Bump the version TRIPLE together for any
shipped-asset change — `package.json`, `sw.js` `VERSION`, and the footer
build line — pinned by `test/version.test.mjs`. Data commits (CSV / stats /
ledger) deliberately ship without a bump.

A release is DONE when `git rev-parse main origin/main` agree, the live
`sw.js` serves the new VERSION, and the served footer names it.
