# CLAUDE.md — KenoGO Oracle

You are Claude Code working inside **kenogo-oracle**: an offline-capable PWA
stats archive + quick-pick generator for KenoGO (kenogo.com.au), deployed to
GitHub Pages at `tonyjason1.github.io/kenogo-oracle`. Vanilla HTML/CSS/JS —
**no frameworks, no build step, zero runtime dependencies**. Sibling project:
`quickpick-au` (same doctrine, five Lott games); this repo inherits its house
rules and its proven patterns (crypto RNG core, field-salvaged prefs,
shell/data cache split, version triple, zero-dep data pipeline).

## Game facts (pinned 2026-08-13, probe session)

- 20 numbers drawn from 1–80, every **160 seconds, 24/7** (540 draws/day).
- **Era pin (MEASURED 2026-08-14 from the archive walk):** 180 s (480/day)
  from the API floor through the last finished draw at
  **2024-05-20T15:00:00Z**; one suspended (never finished) draw at ~15:02:55;
  ~31.5 min changeover outage; **160 s from 2024-05-20T15:31:40Z** exactly
  (`ERA_160_START_MS` in scripts/lib.mjs). The crossing pair (gap 1900 s) is
  the single era-crossing entry in data/anomalies.json — flagged and logged,
  never silently accepted. The probe's date-level "since 2024-05-21" was
  8.5 h coarse; the walk's refusal at the boundary is what pinned the truth.
  Changeover-day quirk: the final 180 s hours carry a parallel GHOST series
  of `suspended` placeholder items ~175 s behind each real draw (bucket 14
  = 20 finished + 20 suspended). Finished-only ingestion makes them
  invisible to the archive; they only show up as the skip counter.
- API floor: **2022-10-18T00:00Z** (starts mid-cycle at game 129 — truncation
  point, possibly rolling retention). ≈718k draws retrievable at probe time.
- `externalId` cycles **1..999 then wraps (~44.4 h)** — it is NOT a daily
  counter and NEVER a key. Dedup/cursor key = `drawingDate`.
- Side bets: headsTails (heads/tails/evens over 1–40 vs 41–80 — derivable
  from the 20 numbers, used as a payload cross-check), jackpot level
  (regular/minor/major), bonus multiplier (1/2/3/4/5/10).
- Spots 1–10, $1 Classic base. No 15/20/40-spot variants.

## API (no auth, no key, CORS `*`)

`GET https://api-kenogo.lttlapp.com/api/v1/draws?productId=kenoGo&currencyId=AUD[&date=<ISO>]`

- `date` = UTC **hour bucket** (≤23 items). No other params work.
- No `date` → recent finished draws + ~60 scheduled future draws.
- Item: `id` (uuid), `externalId` (STRING), `state` (`finished` is the only
  state we ingest), `numbers[20]` (**drawing order** — preserve it),
  `drawingDate` (UTC, `+00:00` offset — normalise to `Z`), `closingDate`
  (−15 s), `jackpots[]` (CENTS), `odds` (~7.7 KB paytable — STRIP, never
  store), `sideBetResults {headsTails, jackpot, bonus}`.
- Scripted fetchers use the honest UA
  `kenogo-oracle data pipeline (github.com/TonyJason1/kenogo-oracle)`,
  1 request/second politeness, 3 retries with backoff.
- Terms posture: kenogo.com.au T&C 7.6 (no storage/republication in a
  retrieval system without consent) is the stated risk of a public results
  archive; raw draw numbers are facts. Same accepted posture as thelott
  scraping in quickpick-au. Tony holds this call — do not re-litigate it in
  code comments or the README.

## Data doctrine (facts only)

CSV archive `data/draws/YYYY-MM.csv` (UTC month of drawingDate), header:

    drawingDate,externalId,numbers,headsTails,jackpotLevel,bonusFactor

- `numbers` = 20 space-separated ints **in drawn order**.
- NEVER store: odds/paytable blobs, jackpot cent amounts, uuids, tickets.
- `externalId` is kept **for reconciliation only**.
- `data/cursor.json` = resumable walk position (`nextBucket` UTC hour). The
  FILES win over the cursor on disagreement — resume re-derives the true tail
  from the newest CSV before fetching anything.
- `data/stats.json` = the ONLY data file the client loads (per-ball freq,
  last-seen, recency-decayed freq, n, dataThrough). Regenerated from the CSVs
  on disk after every update; the audit re-derives it and hard-fails on drift.
- Validate-before-write, always: candidate rows are validated (chain-gap,
  uniqueness, ranges, side-bet cross-checks) BEFORE anything lands in
  data/draws/. Anomalies are fatal to the run, never silently accepted.
- The **chain-gap invariant is the hole detector**: adjacent draws must gap
  exactly 160 s (180 s pre-era-pin). A short bucket cannot pass it.

## Backfill vs updater (catch-up mode)

- `npm run backfill` — local, oldest-first from the floor, ~9 h at 1 req/s.
  Interruptible + resumable at any point. NEVER run it in Actions.
- `.github/workflows/update-data.yml` — 6-hourly cursor walk (~7 buckets).
  While the archive is still catching up (cursor gap > `CATCHUP_BUCKETS`),
  the Action **exits 0 without fetching or committing** — it must not fight
  the local backfill. It takes over automatically once the gap is small.
- Audit freshness anchors to the wall clock (Australia/Sydney display, UTC
  math). In catch-up it REPORTS the gap instead of failing; `--strict`
  (post-updater, steady state) always enforces.

## App doctrine (v0.1.x)

- Selection is ALWAYS the CSPRNG (`rng.js` — rejection sampling, partial
  Fisher–Yates). The 80-ball chamber is presentation only, and degrades its
  ball count under frame pressure without ever touching selection.
- Spots 1–10 (default 10), Lines 1–10 (default 1).
- Disclosure discipline: entertainment only; **every combination of your spot
  count has identical odds** (odds differ BETWEEN spot counts — never imply
  otherwise); no expected-value claims, ever. Gambling help link stays in the
  footer. The Oracle module (era-weighted picks) is a LATER session — do not
  scaffold it early.
- Prefs are salvaged field-by-field (one corrupt key must not discard the
  rest). localStorage reads never throw into module init.

## House rules (non-negotiable)

- **Verify before hardcode.** Any constant that encodes an external fact
  (cadence, era boundary, API shape, counts) is either measured from data in
  this repo, pinned to the probe report, or marked provisional with the check
  that will confirm it. No guessed constants.
- **Push + live-verify = definition of done.** A release is not "shipped"
  until shown: `git rev-parse main origin/main` parity, the LIVE sw.js
  VERSION on Pages, and the served footer version. No exceptions.
- **Version triple:** package.json = sw.js `VERSION` = index.html footer,
  pinned by test/version.test.mjs. Bump for ANY shipped-asset change; data
  commits (CSV/stats) need no bump — they ride the runtime data cache.
- **Report-only reconciliation:** the audit prints everything it measures,
  but only named hard-fail checks gate. New checks start report-only and are
  promoted deliberately.
- **Commits carry NO Co-Authored-By trailer.** Title + craft-voice body,
  present tense, like quickpick-au.
- Zero production dependencies; the data pipeline (Action) never runs
  `npm install`; Actions are pinned to immutable commit SHAs; jobs carry
  timeout-minutes and job-scoped permissions; failures open/comment a
  `pipeline-failure` issue.
- Windows dev box: paths via `node:path`/URL, LF endings in repo files,
  scripts must run under PowerShell-invoked node.

## Layout

    index.html styles.css app.js rng.js sw.js manifest.webmanifest
    js/live.js            client stats + live top-up (footer tightening)
    scripts/lib.mjs       shared data core: API client, parse/trim, validators,
                          CSV io, cursor io (pure functions, exported for tests)
    scripts/backfill.mjs  local archive walk (oldest-first, resumable)
    scripts/update-data.mjs  incremental walk + stats.json rebuild (Action)
    scripts/audit-data.mjs   offline reconciliation + freshness (--strict, --as-of)
    scripts/build-stats.mjs  stats.json from CSVs on disk (also inside updater)
    data/draws/*.csv data/cursor.json data/stats.json
    test/*.test.mjs       core suite = zero-dependency; dom suite = jsdom
    .github/workflows/    update-data.yml (6-hourly), ci.yml

## Current state

v0.1.0 (Session 1): repo + data layer + generator. Backfill runs locally and
resumes across sessions; archive completeness is a follow-up, not a blocker.
NO Oracle yet — Session 2.
