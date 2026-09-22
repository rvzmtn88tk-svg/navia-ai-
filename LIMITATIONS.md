# Limitations of this build

`CLAUDE_CODE_MASTER_PROMPT.md` asks for a fully installed, real-GPS-tested
native app with a real Kyiv+Oblast offline map package. Stage 1's scope was
agreed with the user as **"Core + apps/mobile skeleton + scripts/data"**.
Stage 2 (this update) moved `apps/mobile` from a skeleton to a fully wired
app — real GPS, real geocoding, real Valhalla routing, a real driving UI —
but the sandbox's blockers (below) are unchanged, so `apps/mobile` is still
**not installed, not typechecked, not built, and not run on a device**.
This file is the single place that says exactly what is and isn't real.

## Why not the full native build

The sandbox this was built in:
- has **no Android SDK, Xcode, or physical device** — so `expo prebuild`,
  `eas build`, `expo run:android`/`run:ios`, and any real GNSS/IMU sensor
  reading are all impossible here.
- has **outbound network restricted to package registries** (npm, PyPI,
  crates.io, Go proxy, GitHub, a few Anthropic hosts) — confirmed directly:
  `npm install` itself returned `403 Forbidden` for every package tried
  (typescript, vitest, lodash), and OSM data providers (Geofabrik, Overpass,
  Nominatim) are unreachable the same way. This is a live policy state of
  this sandbox, not a permanent constraint of the approach. **Re-confirmed
  again in Stage 2:** `npm install` at the repo root and inside
  `apps/mobile` both still return `403 Forbidden - GET
  https://registry.npmjs.org/typescript` — identical failure to Stage 1,
  nothing has changed. Because `npm install` cannot complete,
  `npm run typecheck` in `apps/mobile` cannot run at all (no `node_modules`,
  no `tsc`, no `@types/react-native`) — this is a hard upstream block, not a
  step that was skipped.

Given that, the full 45-section spec cannot be honestly delivered end to
end here — no build output, no real sensor test, no real offline package
exists that could be produced and verified in this environment.

## What *is* real and verified here

- **`packages/core`** — every engine module (GNSSMonitor, dead reckoning,
  sensor fusion, map matching, RouteEngine + DemoRoutingProvider with a real
  Dijkstra search, LandmarkEngine, OffRouteDetector, NavigationStateMachine,
  AIEngine + DeterministicDemoAIProvider, AirAlertLayer, TelemetryLogger,
  DiagnosticsEngine, POIEngine, DemoVisionProvider, DemoEngine, and — new in
  Stage 2 — **`GeocoderProvider`/`DemoGeocoderProvider`** and
  **`NavigationEngine`**, the real-GPS counterpart to `DemoEngine`) is real
  TypeScript, typechecked with `tsc -b` (strict mode, `noUncheckedIndexedAccess`
  on), and covered by **67** passing tests (58 from Stage 1 + 3 for the new
  geocoder + 6 for `NavigationEngine`) run with Node 22's built-in `node:test`
  runner via the globally-preinstalled `tsx` loader — not vitest (see below),
  not a mock harness. `npm run typecheck && npm test` from the repo root
  reproduces this from a clean checkout; re-run in Stage 2 from a clean
  `dist`/`tsbuildinfo` state: both `tsc -b` and `tsc --noEmit` on the test
  project exit 0, and `tsx --test test/*.test.ts` reports `# tests 67 / #
  pass 67 / # fail 0`.
- The section-36 E2E simulation (`packages/core/src/e2e-simulation.ts`,
  exercised by `packages/core/test/e2e-simulation.test.ts`) drives a full
  synthetic drive — real Kyiv-center-to-Boryspil coordinates, a real routed
  path over a small hand-authored road graph, GNSS degrading, disappearing,
  dead reckoning taking over, a real on-route POI being confirmed, GNSS
  recovering with hysteresis, arrival — through the actual production
  engines, and writes a JSON report
  (`packages/core/test/e2e-report.json`) each run.

## What is authored but NOT verified here

- **`apps/mobile`** — as of Stage 2, this is no longer a skeleton: every
  screen (`HomeScreen`, `SearchScreen`, `NavigationScreen`,
  `DiagnosticsScreen`) is wired to real `@navia/core` engines through a
  single controller (`src/engine/naviaController.ts`), real GPS
  (`ExpoLocationPositionProvider`), real address search
  (`OnlineGeocoderProvider` against Nominatim), real routing
  (`OnlineValhallaProvider` against Valhalla's HTTP API), real sensor input
  (`ExpoSensorsMotionProvider`), and real TTS + honest not-implemented STT
  (`ExpoSpeechVoiceProvider`) — with a Demo Mode that runs the exact same
  production engines on synthetic samples, never a separate fake path. None
  of it has been typechecked, bundled, or run — no react-native/expo/
  MapLibre type definitions are available in this sandbox to even
  typecheck against (confirmed again in Stage 2: `npm install` still
  returns 403, so `npm run typecheck` cannot execute at all — see above),
  let alone a Metro bundler or a device. In lieu of a real typecheck, every
  new/edited Stage 2 file was manually cross-checked line-by-line against
  `packages/core`'s actual exported types (`NavigationState`, `Route`,
  `RouteStep`, `Position`, `GNSSRawSample`, `RoutingProvider`,
  `GeocoderProvider`, `DiagnosticsInput`, engine method signatures) to catch
  the kind of mismatch a typechecker would catch — this found and fixed two
  issues earlier in Stage 2 (a dead unused import/export in `VoicePanel.tsx`,
  a nonsensical always-`[]` placeholder expression in `NavigationScreen.tsx`)
  and found no remaining mismatches on this final pass. That is real
  evidence of self-consistency, but it is not the same as `tsc` actually
  running, and it cannot catch everything `tsc` would (e.g. React/JSX-level
  type errors, `react-native`'s own type surface). Treat every file under
  `apps/mobile/` as reviewed-but-unbuilt, not as tested code — the one
  genuinely executed piece of new mobile logic is `OnlineValhallaProvider`'s
  `decodePolyline6` polyline decoder, which was extracted into a standalone
  Node script and round-trip-tested against real Kyiv-area coordinates
  (encode → decode → exact match), independent of any RN/Expo tooling.
- **`scripts/data`** — the full OSM → Valhalla → package pipeline is
  written (see `scripts/data/README.md`), and its two pure-Node transform
  scripts (`build-poi-index.mjs`, `build-address-index.mjs`) were smoke-
  tested against hand-written sample GeoJSON in this sandbox and produce
  correct output. The shell steps that need `osmium-tool`/Valhalla/
  Planetiler and real OSM downloads have not been run — this sandbox has
  neither those binaries nor a reachable OSM data source.
- **`OnlineValhallaProvider`** is now implemented (Stage 2,
  `apps/mobile/src/providers/OnlineValhallaProvider.ts`) against Valhalla's
  documented `/route`, `/route` with `alternates`, and `/trace_attributes`
  HTTP API, including a verified polyline6 decoder and an Odin
  maneuver-type mapping — but it has never actually been called against a
  running Valhalla instance (this sandbox cannot reach one), so treat it as
  `REAL / NOT TESTED`, not `REAL / TESTED`. On failure it throws a
  descriptive error rather than silently falling back to
  `DemoRoutingProvider`, per the user's explicit instruction.
  **`OfflineValhallaProvider`** is still not implemented — only
  `DemoRoutingProvider` (real Dijkstra on a small typed graph) and now
  `OnlineValhallaProvider` exist. Both implement the same `RoutingProvider`
  interface the mobile screens depend on, so adding the offline provider
  later needs no UI changes.
- **`OnlineGeocoderProvider`** is now implemented (Stage 2,
  `apps/mobile/src/providers/OnlineGeocoderProvider.ts`) against Nominatim's
  documented `/search` endpoint, Kyiv+Oblast viewbox-biased, with a required
  `User-Agent` per Nominatim's usage policy — also never actually called
  (network unreachable here), so also `REAL / NOT TESTED`. An
  `OfflineGeocoder` counterpart is scaffolded in `packages/core` (returns
  `unavailable`) but not built.
- **`ExtendedKalmanFilterFusion`** (sensor-fusion v2) throws
  `not implemented` on purpose rather than faking a filter — see its doc
  comment in `packages/core/src/sensor-fusion.ts`. `SensorFusionEngine`
  (weighted fusion v1) is the real, tested, production path.
- **`RemoteLLMProvider`** likewise throws `not implemented` — it's a wiring
  point for a backend AI proxy that doesn't exist here (and per spec section
  39, never should hold a secret in mobile code anyway).
  `DeterministicDemoAIProvider` is the real, tested, API-key-free default.
- **Offline package status** honestly reports `state: "unavailable"`
  (`NotYetBuiltOfflineMapManager`) rather than a fake "100% ready" — see
  spec section 12's explicit requirement not to do that.
- **Speech-to-text** (`ExpoSpeechVoiceProvider.startListening`) throws a
  documented "not implemented" error on purpose — Expo's built-in APIs
  don't cover STT, and picking a concrete native module (e.g.
  `expo-speech-recognition`) needs validating on a real device, which this
  sandbox cannot do. `VoicePanel`'s mic button calls it and shows the real
  error via `Alert.alert` rather than faking recognition. Text-to-speech
  (`speak()`, via `expo-speech`) is implemented and wired end-to-end
  (maneuver announcements in `NavigationScreen`, answer playback in
  `VoicePanel`) but is `REAL / NOT TESTED` — no device/simulator here to
  actually hear it. The six Demo Mode voice-intent buttons
  (`VoicePanel`'s `DEMO_INTENTS`) call the real
  `DeterministicDemoAIProvider.answer()` + real `speak()` pipeline on a
  fixed phrase, and are rendered only when Demo Mode is on, so they can
  never be mistaken for real speech recognition.

## Why `node:test` instead of vitest

The original starter file (`tests/core.test.ts` in the uploaded spec) used
vitest. `npm install vitest` fails in this sandbox (see network note
above), so all tests here use Node 22's built-in `node:test` +
`node:assert/strict`, run through `tsx --test` (tsx is globally
preinstalled in this sandbox and needs no network). This is a real,
executing test runner — not a stub — and the test files themselves would
need only a mechanical `describe/it/expect` rewrite to run under vitest
once `npm install` can reach the registry again; nothing about the tests'
logic is runner-specific.

## What to do next on a real machine

1. `npm install` at the repo root (now that a normal registry connection
   exists) — this also picks up `@types/node` for `apps/mobile`'s
   typecheck, which currently falls back to this sandbox's
   `/opt/node-tools` global install (see `packages/core/tsconfig.test.json`
   and `apps/mobile/tsconfig.json`).
2. `cd apps/mobile && npm install && npm run typecheck` — fix whatever the
   real react-native/expo/MapLibre types surface. This is the single
   biggest unknown left: Stage 2's manual cross-check against
   `packages/core`'s types found no mismatches, but a real `tsc` run may
   still find JSX/React-level or `react-native`-specific issues a manual
   read can't catch.
3. Set `EXPO_PUBLIC_NAVIA_MAP_STYLE_URL`, `EXPO_PUBLIC_NAVIA_VALHALLA_URL`,
   and `EXPO_PUBLIC_NAVIA_GEOCODER_URL` (see `.env.example`) — without the
   first two, the map shows its "not configured" error state and routing
   throws immediately, by design.
4. Build a dev client (`eas build --profile development` or
   `expo run:android`/`run:ios`) and test real GNSS/IMU behavior, real
   address search, and real routing on a physical device per `BUILD.md` —
   this is the step that turns `REAL / NOT TESTED` into `REAL / TESTED`
   for `OnlineGeocoderProvider`, `OnlineValhallaProvider`,
   `ExpoLocationPositionProvider`, `ExpoSensorsMotionProvider`, and TTS.
5. Run `scripts/data/run-all.sh` on a machine with internet access to
   produce a real `offline/metadata.json` + package, then swap
   `NotYetBuiltOfflineMapManager` for a real `OfflineMapManager`
   implementation that reads it.
6. Implement `OfflineValhallaProvider` (the online one now exists) against
   a built offline routing package, satisfying the existing
   `RoutingProvider` interface — no UI changes needed.
7. Pick and wire a real STT module for `ExpoSpeechVoiceProvider.startListening`
   (currently an honest not-implemented stub) and validate it on-device.
