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

### AI co-pilot tests (added with the co-pilot upgrade)

`npm test` now runs **165** tests (root script also covers `apps/ai-backend/test`):

| File | Covers |
|---|---|
| `test/route-geometry.test.ts` | projection, side of road, ahead-only projection, time along route (timeline), detour estimate |
| `test/place-search.test.ts` | `opening_hours` evaluation, name normalisation, local corridor/radius search, Overpass query building/parsing/failure (mocked fetch) |
| `test/trip-planner.test.ts` | multi-stop demo routing through off-road stops, mid-edge origin, unsupported preferences, stop ordering, `DemoEngine.applyRoute` |
| `test/copilot-tools.test.ts` | every tool against the demo world: detour limits, time windows, range reserve, parking at destination, explicit errors, LOW-confidence withholding, confirmation gate, rollback on routing failure, no coordinates in `trip_state` |
| `test/copilot-agent.test.ts` | the agent loop with a scripted LLM: multi-step McDonald's flow over two turns, parallel tool results, tier cascade, outages, refusal, tool budget, memory, UI confirm/decline, DemoEngine integration |
| `test/eval-grader.test.ts` | unit-aware number-grounding grader, scenario worlds |
| `test/eval-transcripts.test.ts` | replays all 26 model-in-the-loop transcripts through the real co-pilot + grader; 5 negative controls (injected hallucinations must fail) |
| `test/usefulness.test.ts` | offline place-intent fallback; benchmark claims (never behind the car / over the detour limit, beats straight-line "nearby", legacy AI answers nothing) |
| `apps/ai-backend/test/backend.test.ts` | request validation (no proxy abuse), auth, error mapping, exact Claude API request per tier |

The scripted-LLM tests verify NAVIA's own code paths. The real model's
behaviour is measured by the live eval (needs a Claude API key):

```bash
ANTHROPIC_API_KEY=... npm run eval:ai    # 26 scenarios, pass/fail + latency + cost report
npm run eval:ai -- --dry-run             # no API calls
npm run eval:replay                      # recorded model-in-the-loop transcripts + estimated cost
npm run bench:ai                         # usefulness benchmark vs. baselines
npx tsx packages/core/eval/model-in-the-loop.ts <scenario-id>   # step a scenario as the model
```

### GNSS-denied navigation tests

| File | Covers |
|---|---|
| `test/resilient-navigation.test.ts` | `RoadNetwork` (directed edges, turn sign, route→graph mapping); `MotionPreprocessor` (vertical yaw for flat and upright phones, learning the platform's gravity sign from GPS turns); `NavigationEngine({ resilient })` on generated drives with 10 Hz raw IMU: GNSS jammed to the end → still guided to ARRIVED within 100 m, distance to the maneuver (not step length), far spoof rejected and flagged, route-only network through a jam, no-IMU never HIGH, classic path unchanged when off; state machine can arrive while GNSS is lost; the offline co-pilot answer to "Що робити без GPS?"; a 16-scenario closed-loop smoke test; world generator reproducibility |

Closed-loop Monte Carlo (not part of `npm test`; ~25 min for 100k):

```bash
npm run sim:gnss          # 2,000 scenarios → packages/core/sim/reports/mc-2k.json
npm run sim:gnss:100k     # 100,000 scenarios → packages/core/sim/reports/mc-100k.json
npm run sim:replay -- 160 # one scenario; SIM_TRACE=1 / SIM_TRACE_TURNS=1 for traces
npx tsx packages/core/sim/render-report.ts packages/core/sim/reports/mc-100k.json   # Markdown tables
```

### GNSS loss / offline and AI core (this round)

| File | Covers |
|---|---|
| `test/location-resilience.test.ts` | 18 GPS-loss / offline scenarios end to end (5 s / 30 s / 2 min loss, tunnel, long tunnel, underground parking, urban drift, weak GPS, jump, no internet, GPS+internet lost, recovery on/off route, app suspended while driving/parked), trip cache, voice-guidance policy, marker smoother |
| `test/copilot-memory.test.ts` | "second one → how much → add → remove it", informed-order vs. proposal, "not this one, the next", plans ("coffee first, then home") by voice and by tap, preferences, reminders → proactive events (model and offline), SKIP, read cache, driving context, voice loop |
| `test/eval-suites.test.ts` | suite structure (≥200 dev, ≥50 holdout, unique ids, categories, no holdout wording in dev) and replay of the recorded holdout transcripts |
| `apps/ai-backend/test/backend.test.ts` | + OpenAI-compatible gateway translation and provider selection |

```bash
npm run eval:ai -- --suite all --dry-run          # load all 352 scenarios, no API calls
npm run eval:ai -- --suite all --baseline-local   # grade the deterministic fallback alone
npx tsx packages/core/eval/model-in-the-loop.ts --holdout   # replay the holdout sample
```

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
