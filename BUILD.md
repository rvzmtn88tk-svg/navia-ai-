# Build

This repo is an npm workspace: `packages/core` (platform-independent engine,
built and tested), `apps/mobile` (Expo/React Native app — as of Stage 2,
fully wired to real GPS/geocoding/routing/voice, but still unbuilt and
untypechecked here, see below), `scripts/data` (offline data pipeline,
authored but unrun). See `LIMITATIONS.md` for exactly what has and hasn't
been verified, and where.

`npm install` was attempted again in Stage 2, at the repo root and inside
`apps/mobile`: both still return `403 Forbidden - GET
https://registry.npmjs.org/typescript`, identical to Stage 1. Nothing below
in the `apps/mobile` section has changed as a result — it is still exact
commands to run on a machine with normal internet access, not something
already done here.

## packages/core (build + test here, in any Node 20+ environment)

```bash
npm install
npm run typecheck   # tsc -b + a second pass that also typechecks tests
npm test            # tsx --test packages/core/test/**/*.test.ts
```

No native tooling needed — this is plain TypeScript over Node's built-in
`node:test` runner (see LIMITATIONS.md for why it's `node:test` rather than
vitest, which the original spec's starter file used).

## apps/mobile (needs a real machine — not buildable in this sandbox)

### Prerequisites
Node 20+, Git, Android Studio for Android, Xcode/macOS for local iOS builds,
and an Expo/EAS account if using cloud builds.

### Development
1. `cd apps/mobile && npm install`.
2. Copy `.env.example` to `.env` and fill in real endpoints — **must** use
   the `EXPO_PUBLIC_` prefix (Expo only inlines `EXPO_PUBLIC_*` vars into
   the bundle; `src/config.ts` reads exactly these names):
   `EXPO_PUBLIC_NAVIA_MAP_STYLE_URL` (map is a clear "not configured" error
   screen without it, not a blank map), `EXPO_PUBLIC_NAVIA_VALHALLA_URL`
   (routing throws immediately without it, never silently falls back to
   Demo Mode), `EXPO_PUBLIC_NAVIA_GEOCODER_URL` (defaults to the public
   Nominatim instance if unset), `EXPO_PUBLIC_NAVIA_AI_BACKEND_URL` — never
   a model API key, see `.env.example`'s comments and spec section 39.
3. `npm run typecheck` — this has never been run in any sandbox so far
   (see `LIMITATIONS.md`); fix whatever real react-native/expo/MapLibre
   type errors surface before trusting the build.
4. Build a native development client (`eas build --profile development` or
   `expo run:android` / `expo run:ios`); MapLibre Native is not supported by
   Expo Go.
5. Run Metro (`npm start`) and install the dev build on a physical phone.
6. Grant Location and Motion permissions.
7. Run the Stage 2 acceptance test: open NAVIA → "Куди їдемо?" → type a
   real address → pick a result → confirm a real route renders → "Почати
   навігацію" → confirm real GPS updates move the position/HUD → confirm
   off-route triggers a real reroute → try the Demo Mode voice buttons on
   the Diagnostics screen.

### Production
- Android: `eas build --profile production` or Gradle release.
- iOS: `eas build --profile production` or Xcode archive.

### Important
Real GNSS and motion testing must be done on a physical device, not a
simulator — `expo-location`/`expo-sensors` report fabricated values on
simulators/emulators.

## scripts/data (needs a machine with normal internet access)

```bash
cd scripts/data && ./run-all.sh
```

See `scripts/data/README.md` for prerequisites (osmium-tool, Valhalla,
Planetiler) and what each step produces. This sandbox's network cannot reach
OSM data providers, so this has been authored but not run here.
