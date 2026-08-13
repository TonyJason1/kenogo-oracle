# Performance baseline — v0.1.0

Instrument: `npm run perf` (`scripts/perf-profile.mjs`) — zero-dep CDP harness,
headless Chrome (`--headless=new`), **4x CPU throttle, 412×915 mobile
viewport**, fresh profile, repo served locally with `Cache-Control: no-cache`
(the service worker is the cache under test). Same scaffold as quickpick-au's
harness, so numbers are comparable across the two apps on the same box.

Environment for this baseline: Windows 11, Chrome (system), Node v24.12.0,
2026-08-13. Absolute numbers are machine-specific; the deltas are what matter.
`FCP` reports null under `--headless=new` on this box — LCP stands in as the
paint metric (both apps, both runs; known headless quirk).

## Startup (4x)

| | LCP | DOMContentLoaded | load | transfer |
|---|---|---|---|---|
| cold (no SW) | 408 ms | 195 ms | 197 ms | 84 KB |
| warm (SW shell) | 60 ms | 52 ms | 53 ms | **0 KB** |
| warm, 1x control | 48 ms | 21 ms | 21 ms | 0 KB |

## The 80-ball chamber (the keno-specific question)

O(n²) collisions over 80 balls, two substeps per frame, loop running whenever
the page is visible.

- **Idle, 12 s at 4x:** 60 fps, frame p95 16.8 ms, governor EMA 16.7 ms —
  the cap NEVER degrades on this hardware even throttled. Same at 1x.
- **One 10-spot reveal at 4x:** 6.8 s end-to-end, 60 fps, frame p95 16.8 ms,
  **zero long tasks**.
- Extraction tuning, measured in this session: the quickpick steering gains
  (26 pull / 0.90 damping / 0.8·r² capture / 1300 ms bail) gave a **12.6 s**
  10-spot reveal — with 80 balls the radius is smaller, the crowd deeper, and
  travel time dominated the 400 ms release cadence. At 55 / 0.88 / 2.25·r² /
  900 ms the same reveal is **6.8 s** and the cadence sets the pace again.

## Degrade ladder (proven end-to-end, synthetic frames)

This desktop cannot trigger the governor honestly, so the harness drives the
REAL governor via `window.__kenogoPerf.simulateFrames` — the exact production
code path, synthetic timings only:

| step | cap | balls in chamber |
|---|---|---|
| start | 80 | 80 |
| 95 frames @ 40 ms (~25 fps sustained) | 64 | 64 — shed LIVE, mid-loop |
| +95 more | 48 | 48 |
| full reveal at cap 48 | 48 | **10/10 pills filled** |
| 650 frames @ 12 ms + one pool reset | 80 | 80 — recovery applies at setPool |

Doctrine holds by construction and now by measurement: degradation touches
the BALL COUNT only; selection (`rng.js`) is upstream of the chamber and its
cost is unmeasurable — **10 lines × 10 spots = 0.1 ms** at 4x.

## Data path (4x)

- `data/stats.json` fetch 3.5 ms / parse 0 ms (compact single-line JSON —
  the client never loads the CSV corpus).
- Live top-up correctly refused during catch-up (archive gap > 6 buckets →
  zero API requests from the page; verified incidentally by every harness run).

## Heap

0.8 MB used / 1.8 MB total after GC, all surfaces exercised.

## Re-run

```powershell
npm run perf                       # table to stdout
node scripts/perf-profile.mjs --out=perf.json
node scripts/perf-profile.mjs --serve   # for npx lighthouse against the same server
```
