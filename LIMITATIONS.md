# NAVIA feature and data status

Updated 24 September 2026 (iteration 2). Status labels follow docs/NAVIA_TZ.md §4.

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
| Sign-in (Apple / Google / email) | BLOCKED | Buttons shown disabled with an explanation. Needs Firebase project; Apple sign-in also needs Apple Developer. |
| "Nearest shelter" (during an active alert) | IMPLEMENTED | Appears only when the alert source reports an active alert; not observed live in this session. |

## Limits to know before relying on the app

- Map, search, routing, places and alert status use public online services and need internet. Public endpoints can throttle or stop responding.
- No live traffic, road closures or speed cameras.
- Shelter and resilience-point data can be incomplete or outdated; access is not guaranteed. The app never calls a place "safe".
- Air-alert data is informational (Kyiv Digital, NEPTUN). NAVIA shows the local status and an attributed regional summary only — no target positions on the map. Keep official alerts enabled.
- Live navigation does not yet integrate IMU motion into dead reckoning on the device; Demo Mode dead reckoning is simulation only.
- Offline maps and offline routing are not implemented (planned after design and navigation).
- Nothing here is DEVICE-VERIFIED in this iteration; see the report for the on-phone checklist.

## Device installation

From `apps/mobile`, rebuild and install on the connected iPhone (runs without Metro afterwards):

```bash
npx expo run:ios --device --configuration Release --no-bundler
```
