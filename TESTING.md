# Testing

## packages/core

```bash
npm install
npm run typecheck    # tsc -b tsconfig.json && tsc --noEmit -p packages/core/tsconfig.test.json
npm test             # tsx --test packages/core/test/**/*.test.ts
```

As of Stage 2: **67/67 tests pass**, both typecheck passes are clean,
re-verified from a clean checkout in Stage 2 (`rm -rf dist *.tsbuildinfo`,
then `tsc -b` exit 0, `tsc --noEmit -p tsconfig.test.json` exit 0,
`tsx --test test/*.test.ts` → `# tests 67 / # pass 67 / # fail 0`). Test
files, one per engine module plus the E2E scenario:

| File | Covers |
|---|---|
| `test/baseline.test.ts` | The original starter kit's geodesy/dead-reckoning/confidence tests, relocated |
| `test/types.test.ts` | Domain types, barrel-export sanity |
| `test/sensor-fusion.test.ts` | Stationary, constant velocity, turning, GPS outage (spec section 9's required cases) |
| `test/route-engine.test.ts` | Real Dijkstra routing, alternatives, progress/next-maneuver/arrival (sections 11, 23) |
| `test/landmark-engine.test.ts` | The "Я бачу WOG" worked example: confirmed/ambiguous/no-match (section 15) |
| `test/off-route-detector.test.ts` | Hysteresis — no false trigger on one bad sample (section 22) |
| `test/navigation-state-machine.test.ts` | Full state diagram incl. hysteresis and recovery relapse (section 21) |
| `test/ai-engine.test.ts` | "Never invent" policy, low-confidence caveats (sections 16, 39) |
| `test/support-modules.test.ts` | AirAlertLayer, TelemetryLogger, DiagnosticsEngine, POIEngine, DemoVisionProvider, offline-manager honesty |
| `test/demo-engine.test.ts` | DemoEngine controls not covered by the E2E test |
| `test/e2e-simulation.test.ts` | The full section-36 scenario; writes `test/e2e-report.json` |
| `test/geocoder.test.ts` *(new, Stage 2)* | `DemoGeocoderProvider`: substring match + source tag, empty query, `limit` respected (3 tests) |
| `test/navigation-engine.test.ts` *(new, Stage 2)* | `NavigationEngine`: no-GNSS→LOST+null position, trusted fix→NORMAL+ACTIVE, staleness→LOST+dead-reckoning position, off-route detection, routing-failure→honest rejection, arrival (6 tests) |

## apps/mobile

Not typechecked, not built, not run — see `LIMITATIONS.md` for exactly
why (network-blocked `npm install`, confirmed again in Stage 2) and what
was done instead (a full manual cross-check of every Stage 2 file against
`packages/core`'s real exported types, which found and fixed two issues
and found no remaining mismatches on the final pass). `npm run typecheck`
there currently can't even start — it depends on `node_modules` that
`npm install` cannot produce in this sandbox — so on a real machine this
is genuinely the first time any of it will be typechecked; budget time for
real react-native/expo/MapLibre type errors that a manual read can't catch
(JSX prop typing, `react-native`'s own type surface).

The one piece of new Stage 2 mobile code that *was* actually executed and
verified here, independent of any RN/Expo tooling: `OnlineValhallaProvider`'s
`decodePolyline6` polyline decoder, round-trip tested in a standalone Node
script against real Kyiv-area coordinates (hand-written reference encoder →
decode → exact match within 1e-6).

## scripts/data

`build-poi-index.mjs` and `build-address-index.mjs` were smoke-tested here
against hand-written sample GeoJSON (not real OSM data) and produce correct
output. The shell pipeline steps have not been run — see `LIMITATIONS.md`
and `scripts/data/README.md`.
