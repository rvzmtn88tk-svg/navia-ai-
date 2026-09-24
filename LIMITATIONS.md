# NAVIA feature and data status

Updated 24 September 2026 (iteration 3). Status labels follow docs/NAVIA_TZ.md §4.

## In this build

| Area | Status | Notes |
|---|---|---|
| Design system, uk/en localization | RUNTIME-TESTED (simulator) | Tokens in `apps/mobile/src/theme/tokens.ts`, strings in `src/i18n/strings.ts`. Diagnostics and the error boundary still use the legacy `AppText`. |
| Map-first home (search, category chips, bottom sheet) | RUNTIME-TESTED (simulator) | GPS health, local alert + regional summary, co-pilot entry, saved/recent places. |
| Map layers | Standard, Terrain: RUNTIME-TESTED · Satellite: BLOCKED | Satellite needs `EXPO_PUBLIC_NAVIA_MAPTILER_KEY`; terrain uses open DEM hillshading without a key (MapTiler Outdoor when a key exists). |
| Branded position puck | RUNTIME-TESTED (simulator) | Interpolated between fixes, heading-aligned, accuracy halo, colour by GPS health. |
| Route overview → 3D navigation → arrival | RUNTIME-TESTED (demo route, simulator) | Real Valhalla routing checked in Kyiv by API call; a full real drive is not device-verified. |
| Maneuver card, trip bar, "Back to route" | RUNTIME-TESTED (demo) | |
| Voice prompts (iPhone system voice) | AUTOMATED-TESTED (phrasing, timing) | Audible quality and music ducking need a device check. Neural voice: see docs/VOICE_OPTIONS.md (decision pending). |
| Intro sequence, first-launch tour | RUNTIME-TESTED (simulator) | Native splash updated; needs a rebuild to show on the phone. |
| Co-pilot | On-device mode: RUNTIME-TESTED · Claude mode: IMPLEMENTED, BLOCKED | Server code in `functions/`; needs Firebase project, Blaze plan, Anthropic key, and sign-in. |
| Sign-in (Apple / Google) | IMPLEMENTED, BLOCKED | Firebase Auth via REST, refresh token in the Keychain, unlocks the Claude co-pilot. Needs `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, providers enabled in Firebase; Apple also needs a paid Apple Developer team and a build with `EXPO_PUBLIC_NAVIA_APPLE_SIGNIN=1`. Email sign-in removed from the UI. |
| "Nearest shelter" (during an active alert) | IMPLEMENTED | Appears only when the alert source reports an active alert; not observed live in this session. |
| Resilient navigation without GPS (route-constrained dead reckoning, "I'm here" start, start from last stable fix, "I've turned" confirmation, spoof rejection) | RUNTIME-TESTED (simulator, GPS switched off mid-route) · AUTOMATED-TESTED (core) | Simulator has no accelerometer, so DR used the last trusted GNSS speed. On the phone the accelerometer decides moving/stopped — needs a device drive. |
| Offline map along the route (auto-download at start) | RUNTIME-TESTED (simulator) | Zoom 11–16 corridor via MapLibre offline packs; routing itself still needs internet to build the route. |
| NAVIA map style (day/night palettes, flat buildings in navigation) | RUNTIME-TESTED (simulator) | Recolours the OpenFreeMap "liberty" style. |
| Alert detail: scope (district/city/oblast), level, reasons, other districts | IMPLEMENTED | Fields come from the NEPTUN feed when present; not observed during an active alert. |
| Safety panel (swipe left from the right map edge) | RUNTIME-TESTED (simulator) | Alert status, nearest shelters and resilience points, walking route, share location via the iOS share sheet. |
| GPS / alert beacons on the map | RUNTIME-TESTED (simulator) | Dim when fine, pulse yellow/red on trouble; details in the pulled-up sheet. |
| Navigation camera and speed | IMPLEMENTED | Camera follows the road ahead (route bearing), puck snapped to the route, speed badge (km/h from GNSS). Needs a device drive. |
| Spoken alert notice during a trip | AUTOMATED-TESTED (phrasing) | Alert re-checked every minute during navigation. |
| Startup chime | IMPLEMENTED | Original synthesis (`apps/mobile/scripts/make-intro-sound.mjs`), in the style of the owner's reference; respects the iPhone silent switch. |
| Male voice | Interim: lowered-pitch system voice · Neural male voice: BLOCKED | iOS has no male Ukrainian voice. Needs the NAVIA server and a TTS provider (e.g. Azure uk-UA-OstapNeural), see docs/VOICE_OPTIONS.md. |

## Limits to know before relying on the app

- Map, search, routing, places and alert status use public online services and need internet. Public endpoints can throttle or stop responding.
- No live traffic, road closures or speed cameras.
- Shelter and resilience-point data can be incomplete or outdated; access is not guaranteed. The app never calls a place "safe".
- Air-alert data is informational (Kyiv Digital, NEPTUN). NAVIA shows the local status and an attributed regional summary only — no target positions on the map. Keep official alerts enabled.
- Dead reckoning without GPS is an estimate along the planned route: it cannot detect a wrong turn, so NAVIA asks the driver to confirm turns and never auto-announces arrival.
- Offline map tiles are saved only along a route that was started online; offline routing (building a new route without internet) is not implemented.
- Nothing here is DEVICE-VERIFIED in this iteration; see the report for the on-phone checklist.

## Device installation

From `apps/mobile`, rebuild and install on the connected iPhone (runs without Metro afterwards):

```bash
npx expo run:ios --device --configuration Release --no-bundler
```
