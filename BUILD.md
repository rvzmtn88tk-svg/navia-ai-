# NAVIA iPhone build

The app currently running from Metro is a development build. It requires the
computer running `npm start`; it is not the version to keep on the phone.

## Install a version that runs without Metro

From the repository root, run:

```bash
cd apps/mobile
npx expo run:ios --device --configuration Release --no-bundler
```

Choose the iPhone in the device picker and let Xcode finish signing and
installing. The Release configuration embeds the JavaScript bundle in the
app, so the phone no longer needs Metro after installation. The iPhone must
be paired with this Mac, and Xcode must have access to the Apple development
team used to sign the app.

An EAS internal build can also be created with:
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

## iOS device build with the AI co-pilot

See `docs/HANDOFF_IOS.md` (merge steps, `.env`, backend, `expo prebuild`,
`expo run:ios --device`, required Info.plist keys).

## apps/ai-backend (AI co-pilot backend)

```bash
cp apps/ai-backend/.env.example .env   # or set the variables in your host's secret store
ANTHROPIC_API_KEY=... npm run ai:backend   # listens on :8787; GET /healthz
```

Deploy behind HTTPS and point the app's `EXPO_PUBLIC_NAVIA_AI_BACKEND_URL`
at it. The provider key lives only here. See `docs/AI_COPILOT.md`.

## scripts/data (needs a machine with normal internet access)

```bash
cd apps/mobile
eas build --platform ios --profile preview
```

The `preview` profile creates a standalone installable build. Internal iOS
distribution needs an Apple Developer team and a provisioning profile that
includes the iPhone. In this checkout, the EAS account is signed in but has
no Apple team/remote iOS credentials configured yet, so the cloud build stops
at signing setup. Configure the Apple team in EAS before using that route.

## Development build

```bash
cd apps/mobile
npm start
```

Use this only while developing with the phone connected to the same network
as Metro. The development build expects the server to be available.

## Current service setup

- Address search is online and limited to the Kyiv/Kyiv Oblast search area.
- Route calculations use the public FOSSGIS Valhalla demo service by default.
  It is suitable for individual testing under fair use, not for a public
  production launch. Configure `EXPO_PUBLIC_NAVIA_VALHALLA_URL` to use a
  dedicated instance.
- The map uses the public OpenFreeMap Liberty/Dark vector styles backed by
  OpenStreetMap unless a custom style URL is configured. Neither the map nor
  address search currently has offline data.
- Kyiv city alert status comes from the Kyiv Digital current-state endpoint.
  Other regions use NEPTUN's read-only regional alert data, with attribution.
  Both are informational feeds and can be delayed; keep official alerts on.
- Nearby infrastructure is requested from OpenStreetMap. Kyiv shelters and
  resilience points also use the municipal GIS endpoint when it responds.
  Coverage and access details are not guaranteed.
- See [LIMITATIONS.md](LIMITATIONS.md) for the current feature boundaries and
  the exact iPhone install command.
