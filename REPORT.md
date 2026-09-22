> **This is the Stage 1 report.** For Stage 2 ("mobile NAVIA first working
> build" — real GPS, real geocoding, real Valhalla routing, real driving UI,
> Demo Mode) see `STAGE2_REPORT.md`.

# NAVIA build report (Stage 1)

Written per master-spec section 44's required format, as a completion
report (the work below is already done — see `TESTING.md` for how to
reproduce the test results). Scope agreed with the user for this pass:
**"Core + apps/mobile skeleton + scripts/data"** — full engine
implementation and real tests in `packages/core`, an honestly-labeled
unbuilt `apps/mobile` scaffold, and an authored-but-unrun `scripts/data`
pipeline. See `LIMITATIONS.md` for exactly what was and wasn't verified,
and why.

## 1. Repository tree

```
navia/
  package.json  tsconfig.base.json  tsconfig.json
  BUILD.md  TESTING.md  LIMITATIONS.md  REPORT.md
  CLAUDE.md  CLAUDE_CODE_MASTER_PROMPT.md  DATA_PIPELINE.md  MANIFEST.json
  docs/ARCHITECTURE.md
  packages/core/
    package.json  tsconfig.json  tsconfig.test.json
    src/
      types.ts  geodesy.ts  gnss-monitor.ts  dead-reckoning.ts
      sensor-fusion.ts  map-matcher.ts  confidence.ts
      route-engine.ts  demo-routing-provider.ts
      landmark-engine.ts  off-route-detector.ts  recovery-engine.ts
      navigation-state-machine.ts
      ai-engine.ts  air-alert-layer.ts  telemetry-logger.ts
      diagnostics-engine.ts  poi-engine.ts  vision-provider.ts
      offline-manager.ts  demo-engine.ts  e2e-simulation.ts  index.ts
    test/  (11 files, 58 tests — see TESTING.md)
  apps/mobile/                         # scaffold, unbuilt (LIMITATIONS.md)
    app.json  eas.json  package.json  tsconfig.json  .env.example
    App.tsx  index.ts
    src/navigation/RootNavigator.tsx
    src/screens/{Search,Navigation,Diagnostics}Screen.tsx
    src/providers/{ExpoLocationPositionProvider,ExpoSensorsMotionProvider,
                    ExpoSpeechVoiceProvider,MapLibreRouteView}.*
  scripts/data/                        # authored, unrun (LIMITATIONS.md)
    README.md  run-all.sh  01..08-*.sh
    build-poi-index.mjs  build-address-index.mjs  kyiv-oblast.poly
```

## 2. Detected existing technologies

The uploaded spec bundle (`NAVIA_CLAUDE_CODE_MASTER_SPEC.zip`) shipped with
a starter kit already in place before any work here: `packages/core/src/
{geodesy,gnss-monitor,dead-reckoning,confidence,map-matcher}.ts` and a
vitest test file at `tests/core.test.ts`, plus doc files (`CLAUDE.md`,
`BUILD.md`, `DATA_PIPELINE.md`, `docs/ARCHITECTURE.md`, `MANIFEST.json`) and
the master prompt itself. No `package.json`, no workspace layout, no CI, no
`apps/mobile`, no `scripts/data` existed yet.

## 3. What was reused

All five provided `packages/core/src/*.ts` files' logic and formulas were
kept as-is (they're correct, tested implementations of the spec's own
formulas) and only reorganized into the workspace layout, with one real bug
fixed along the way (`map-matcher.ts`'s `chooseRoad` had a possibly-
undefined array access under strict `noUncheckedIndexedAccess`) and one
naming collision resolved (`gnss-monitor.ts`'s local flat `GNSSSample` type
renamed to `GNSSRawSample` to avoid clashing with the canonical nested
`GNSSSample` from spec section 5). The starter `tests/core.test.ts`'s three
assertions were kept, relocated to `packages/core/test/baseline.test.ts`,
translated from vitest's `describe/it/expect` to `node:test`'s
`test`/`node:assert` (see section 6 below and `LIMITATIONS.md` for why).

## 4. What had to be built from scratch

Everything else: the full workspace scaffold; `types.ts` (transcribed
verbatim from spec section 5, plus `NavigationEvent` from section 32);
`SensorFusionEngine` (v1 weighted fusion) and an honestly-stubbed
`ExtendedKalmanFilterFusion` (v2); `RouteEngine`/`RouteProgressEngine`/
`DemoRoutingProvider` (real Dijkstra); `LandmarkEngine`; `OffRouteDetector`;
`RecoveryEngine`; `NavigationStateMachine`; `AIEngine` + tool getters +
`DeterministicDemoAIProvider` + a stubbed `RemoteLLMProvider`;
`AirAlertLayer`; `TelemetryLogger`; `DiagnosticsEngine`; `POIEngine`;
`DemoVisionProvider`; offline-manager interfaces (honestly reporting no
package exists yet); `DemoEngine` (wires every module above into one real
simulation, per section 26's "don't build a separate fake UI engine" rule);
the section-36 E2E simulation + report; the entire `apps/mobile` scaffold;
the entire `scripts/data` pipeline; all test files; `LIMITATIONS.md`,
`TESTING.md`, this report.

## 5. Implementation plan (as executed)

1. Scaffold the npm workspace (root + `packages/core` configs), get the
   provided starter files building and testing for real before adding
   anything.
2. Domain types (`types.ts`), verbatim from the spec.
3. `SensorFusionEngine` with its four required test cases (stationary,
   constant velocity, turning, GPS outage).
4. `RouteEngine`/`DemoRoutingProvider`/`RouteProgressEngine` — real routing
   and progress, no canned distances.
5. `LandmarkEngine`, `OffRouteDetector`, `RecoveryEngine`,
   `NavigationStateMachine` — the full state diagram with hysteresis.
6. `AIEngine` + `DeterministicDemoAIProvider` — the "never invent" policy
   enforced by construction (getters only expose real context fields).
7. Remaining support modules (air alert, telemetry, diagnostics, POI index,
   vision, offline-manager interfaces).
8. `DemoEngine` wiring everything above into one simulation, plus the
   section-36 E2E test producing a JSON report.
9. Full clean-state test + typecheck run (`TESTING.md`).
10. `apps/mobile` skeleton.
11. `scripts/data` pipeline + `LIMITATIONS.md`/`TESTING.md` + this report.

Each stage's real test/typecheck results are in the session's `STAGE:`
reports (section 9 below has the final rollup); nothing was marked complete
before its tests passed.

## 6. Dependencies to install (once `npm install` can reach the registry)

`packages/core`: `typescript`, `@types/node` (dev only — the package itself
has zero runtime dependencies, by design, so it's usable from any JS
runtime). `apps/mobile`: `expo`, `expo-location`, `expo-sensors`,
`expo-speech`, `expo-sqlite`, `react`, `react-native`,
`@react-navigation/native` (+`native-stack`), `react-native-screens`,
`react-native-safe-area-context`, `@maplibre/maplibre-react-native`,
`zustand` — see `apps/mobile/package.json` for exact version ranges.
`scripts/data`: no npm packages (plain Node stdlib); needs system binaries
`osmium-tool`, Valhalla (`valhalla_build_tiles`/`valhalla_build_config`),
Planetiler — see `scripts/data/README.md`.

## 7. Data required for Kyiv/Kyiv Oblast

A current Ukraine OSM PBF extract (Geofabrik), clipped to the Kyiv city +
Kyiv Oblast bounding polygon (`scripts/data/kyiv-oblast.poly`,
approximately 49.9–51.6°N, 29.2–32.2°E). Not fetchable from this sandbox
(network restricted to package registries) — see `LIMITATIONS.md`.

## 8. Expected build commands

`packages/core`: `npm install && npm run typecheck && npm test` (works
today, in this sandbox, see `TESTING.md`). `apps/mobile`: `cd apps/mobile &&
npm install`, then `eas build --profile development` or `expo run:android`/
`run:ios` (needs a real machine — `BUILD.md`). `scripts/data`: `cd
scripts/data && ./run-all.sh` (needs a real machine with internet access —
`scripts/data/README.md`).

## 9. Risks / blockers

- This sandbox cannot install any npm package (`npm install` returns `403`
  for every package tried, confirmed directly) or reach OSM data providers
  — blocks `apps/mobile` and `scripts/data` from being verified here at
  all. Not a design risk, an environment one; resolved by running those
  parts on a normal machine (`BUILD.md`).
- `apps/mobile`'s TypeScript has never been typechecked against real
  react-native/expo types (none available in this sandbox) — expect some
  fixes needed on first real `npm run typecheck` there.
- The offline data pipeline's shell steps (osmium/Valhalla/Planetiler) are
  authored from documented tool behavior but not run — expect some flag/
  version drift to fix against whatever versions are actually installed.
- `RemoteLLMProvider` and the two Valhalla-backed `RoutingProvider`s are
  intentionally unimplemented stubs (throw, don't fake) — real
  implementations are a straightforward follow-up once a backend/Valhalla
  instance exists, since the interfaces they'd satisfy are already defined
  and already what the rest of the code depends on.

---

## Final stage report

```
STAGE: packages/core full implementation + apps/mobile skeleton + scripts/data
IMPLEMENTED: 23 core engine modules (see tree above); apps/mobile scaffold
             (9 source files); scripts/data pipeline (8 shell steps + 2
             Node transforms + docs)
TESTS: packages/core — 58/58 passing (node:test via tsx), 0 typecheck
       errors, verified from a clean checkout (see TESTING.md for the
       breakdown by file). apps/mobile — not tested (no react-native types
       available here; see LIMITATIONS.md). scripts/data — the two Node
       transform scripts smoke-tested against sample GeoJSON and correct;
       the shell/osmium/Valhalla steps not run (no data/tools reachable
       here).
BUILD: packages/core builds clean (`tsc -b`) from a fresh checkout with no
       node_modules/dist present. apps/mobile and scripts/data are not
       buildable in this sandbox — see LIMITATIONS.md for exactly why and
       what running them on a real machine needs.
REMAINING: implement OnlineValhallaProvider/OfflineValhallaProvider against
           a real Valhalla instance; implement RemoteLLMProvider behind a
           real backend; run scripts/data on a machine with internet access
           and wire a real OfflineMapManager to its output; npm install +
           typecheck + fix apps/mobile on a real machine; build a dev client
           and test real GNSS/IMU behavior on a physical device.
```
