# NAVIA Stage 2 report — Mobile NAVIA first working build

Written in the exact format requested for Stage 2. See `LIMITATIONS.md`,
`TESTING.md`, and `BUILD.md` for full detail behind every line here.

```
STAGE:
Mobile NAVIA first working build

IMPLEMENTED:
- packages/core: GeocoderProvider interface + DemoGeocoderProvider (new).
- packages/core: NavigationEngine — the real-GPS counterpart to DemoEngine,
  driven by pushGnssSample()/pushImuSample()/tick(nowMs), detecting GNSS
  loss by fix staleness (default 6000ms), running the same production
  pipeline (GNSSMonitor -> SensorFusionEngine -> RouteProgressEngine ->
  OffRouteDetector -> NavigationStateMachine) as DemoEngine.
- packages/core: demo-data.ts ships the real Kyiv-center -> Boryspil demo
  graph/origin/destination/POIs as part of the published package.
- apps/mobile: src/config.ts — single read-point for EXPO_PUBLIC_* env vars
  (fixed a real Stage-1 bug: .env.example used a plain NAVIA_* prefix,
  which Expo does not inline into the bundle).
- apps/mobile: src/engine/naviaController.ts — the single place
  NavigationEngine/DemoEngine are constructed; a Zustand store makes their
  state reactive for screens. No screen touches the core engines directly.
- apps/mobile: OnlineGeocoderProvider — real Nominatim-compatible /search
  call, Kyiv+Oblast viewbox bias, required User-Agent, debounced search in
  SearchScreen, no hardcoded result arrays.
- apps/mobile: OnlineValhallaProvider — real Valhalla /route,
  /route+alternates, /trace_attributes calls implementing RoutingProvider;
  verified polyline6 decoder; maneuver-type mapping; throws on failure,
  never silently falls back to DemoRoutingProvider.
- apps/mobile: MapLibreRouteView — styleUrl is now string | null; renders a
  clear "Карту не налаштовано" error state instead of a blank map when
  EXPO_PUBLIC_NAVIA_MAP_STYLE_URL is unset.
- apps/mobile: NavigationScreen rewritten — real GPS/IMU pipeline into
  NavigationEngine, route-on-first-fix, 1s tick loop, off-route ->
  automatic reroute via OnlineValhallaProvider, real HUD (next maneuver,
  distance, ETA, GNSS status text, confidence band), Demo Mode banner,
  permission-denied and route-error dedicated screens, TTS maneuver
  announcements.
- apps/mobile: DiagnosticsScreen rewritten — Demo Mode ON/OFF Switch, demo
  controls (GNSS degrade/loss/restore, GPS jump, wrong heading,
  off-route/clear) driving the real production engines (never a separate
  fake engine), full real-field diagnostics snapshot every 1s (GPS/GNSS/
  Position/Sensors/Map/Routing/Network/App), with anomalyScore and
  mapMatchScore left honestly null (not fabricated — see inline comments).
- apps/mobile: HomeScreen (new) — minimalist driver-oriented home per spec:
  "Куди їдемо?", recent destinations, Diagnostics, Demo Mode.
- apps/mobile: SearchScreen rewritten — real debounced geocoder search,
  loading/error/empty states, min 3 chars.
- apps/mobile: VoicePanel (new) — real mic button calling the real (honest
  not-implemented) STT stub via Alert; six Demo-Mode-only intent buttons
  driving the real DeterministicDemoAIProvider + real TTS pipeline.
- apps/mobile: RootNavigator updated to Home -> Search -> Navigation ->
  Diagnostics.

TESTED:
- packages/core: 67/67 tests pass (58 from Stage 1 + 3 new geocoder tests +
  6 new NavigationEngine tests), run via `tsx --test test/*.test.ts` from a
  clean `dist`/`tsbuildinfo` state, re-verified in this session.
- OnlineValhallaProvider's decodePolyline6: verified standalone (Node
  script, real Kyiv-area coordinates, encode->decode round-trip exact
  match) — the one piece of new apps/mobile logic actually executed in
  this sandbox.
- apps/mobile as a whole: NOT executed, NOT run on a simulator or device —
  no RN/Expo runtime is reachable in this sandbox. In its place: every new/
  edited Stage 2 file was manually cross-checked against packages/core's
  actual exported types and method signatures (NavigationState, Route,
  RouteStep, Position, GNSSRawSample, RoutingProvider, GeocoderProvider,
  DiagnosticsInput, and every engine method called from a screen) — this
  caught and fixed two real issues during writing (a dead unused
  import/export in VoicePanel.tsx, a nonsensical placeholder expression in
  NavigationScreen.tsx) and found zero remaining mismatches on this final
  pass. This is evidence of self-consistency, not a substitute for a real
  typecheck or test run.

TYPECHECK:
- packages/core: clean. `tsc -b tsconfig.json` exit 0;
  `tsc --noEmit -p packages/core/tsconfig.test.json` exit 0. Re-run in this
  session from a clean state (rm -rf dist *.tsbuildinfo) to confirm.
- apps/mobile: NOT RUN. `npm install` was attempted again in this session,
  at the repo root and inside apps/mobile: both returned
  `403 Forbidden - GET https://registry.npmjs.org/typescript`, identical to
  every previous attempt. Without node_modules there is no tsc, no
  @types/react-native, and `npm run typecheck` cannot execute at all — this
  is a hard upstream network block in this sandbox, not a step that was
  skipped or a result being hidden.

BUILD:
NOT BUILT. No Android SDK, no Xcode, no `eas` CLI, and no network path to
npm/Expo/EAS exist in this sandbox (all reconfirmed this session — `which
adb/emulator/xcodebuild/eas` return nothing; `npm install` returns 403).
Nothing beyond source code has been produced for apps/mobile. Exact
commands to build for real are in BUILD.md (npm install -> set
EXPO_PUBLIC_* env vars -> npm run typecheck -> eas build --profile
development, or expo run:android/run:ios).

REAL DEVICE:
NO

APK:
None. Not created — this sandbox cannot run `eas build` or any native
Android toolchain. BUILD.md has the exact command to produce one on a
machine with EAS credentials: `cd apps/mobile && eas build --profile
development --platform android`.

iOS BUILD:
NO

REMAINING:
- Run `npm install` (root + apps/mobile) on a machine with normal internet,
  then `npm run typecheck` in apps/mobile and fix whatever real
  react-native/expo/MapLibre type errors surface — this has never happened
  in any sandbox so far.
- Set EXPO_PUBLIC_NAVIA_MAP_STYLE_URL and EXPO_PUBLIC_NAVIA_VALHALLA_URL to
  real endpoints (a MapLibre style URL and a running Valhalla instance) —
  without them the app correctly shows its honest error states rather than
  fake data, but nothing renders on a map or routes until they're set.
- Build a development client (eas build --profile development or expo
  run:android/run:ios) and install it on a physical phone; Expo Go cannot
  run MapLibre Native.
- Run the acceptance scenario on the device: Open NAVIA -> Search -> real
  address -> real results -> pick -> real GPS fix -> real route requested
  and shown -> Start Navigation -> real GPS updates -> route progress/next
  maneuver update -> voice announces the maneuver -> drift off the route ->
  confirm automatic reroute -> try Demo Mode's GNSS-loss/off-route buttons
  on Diagnostics and confirm the same HUD reacts correctly.
- Pick and wire a real STT module for
  ExpoSpeechVoiceProvider.startListening (currently an honest
  not-implemented stub) and validate on-device.
- Implement OfflineValhallaProvider and an OfflineGeocoder once
  scripts/data's pipeline has actually produced a package on a machine with
  internet access (still authored-but-unrun, see LIMITATIONS.md).
- Wire AsyncStorage (or similar) so recentDestinations in naviaController
  survives an app restart — currently session-only by design, not yet
  persisted.

BLOCKERS:
- This sandbox's network allows only package-registry/GitHub/Anthropic
  hosts; `npm install` returns 403 for every package (reconfirmed this
  session), and Nominatim/Valhalla/OSM endpoints are unreachable the same
  way. This blocks: installing apps/mobile's dependencies, typechecking it,
  bundling it, and actually calling OnlineGeocoderProvider/
  OnlineValhallaProvider even once.
- No Android SDK, Xcode, physical device, or `eas` CLI exists in this
  sandbox — blocks any native build, emulation, or on-device test.
These are environment blockers of this sandbox, not defects in the
approach or the code as written — see LIMITATIONS.md for the exact
commands that were run and their exact output.
```

## Status per feature (exact taxonomy)

| Feature | Status |
|---|---|
| `packages/core` engines (all, incl. new GeocoderProvider/NavigationEngine) | REAL / TESTED |
| `OnlineGeocoderProvider` | REAL / NOT TESTED |
| `OnlineValhallaProvider` (routing) | REAL / NOT TESTED |
| `OnlineValhallaProvider.decodePolyline6` | REAL / TESTED (standalone Node verification) |
| `ExpoLocationPositionProvider` (real GPS) | REAL / NOT TESTED |
| `ExpoSensorsMotionProvider` (real IMU) | REAL / NOT TESTED |
| `ExpoSpeechVoiceProvider.speak` (TTS) | REAL / NOT TESTED |
| `ExpoSpeechVoiceProvider.startListening` (STT) | UNAVAILABLE (documented not-implemented) |
| `MapLibreRouteView` (real map) | REAL / NOT TESTED |
| `NavigationScreen`, `DiagnosticsScreen`, `HomeScreen`, `SearchScreen` | REAL / NOT TESTED |
| Demo Mode (GNSS degrade/loss/jump/heading/off-route via production engines) | DEMO ONLY (by design) |
| `DemoRoutingProvider` / `DemoGeocoderProvider` | DEMO ONLY |
| `OfflineValhallaProvider`, `OfflineGeocoder` (real implementation) | SCAFFOLD |
| `ExtendedKalmanFilterFusion` | UNAVAILABLE (documented TODO) |
| Native build / APK / IPA | UNAVAILABLE (no toolchain in this sandbox) |
