# NAVIA feature and data status

Updated 25 September 2026 (iteration 4). Status labels follow docs/NAVIA_TZ.md §4.

## In this build

| Area | Status | Notes |
|---|---|---|
| Design system, uk/en localization | RUNTIME-TESTED (simulator) | Tokens in `apps/mobile/src/theme/tokens.ts`, strings in `src/i18n/strings.ts`. Diagnostics and the error boundary still use the legacy `AppText`. |
| Map-first home (search, category chips, bottom sheet) | RUNTIME-TESTED (simulator) | GPS health, local alert + regional summary, co-pilot entry, saved/recent places. |
| Map layers | Standard, Terrain: RUNTIME-TESTED · Satellite: BLOCKED | Satellite needs `EXPO_PUBLIC_NAVIA_MAPTILER_KEY`. Terrain uses the OpenTopoMap raster (contours + shading, dimmed at night) without a key; MapTiler Outdoor when a key exists. The old hillshade-only terrain was invisible on flat terrain. |
| Branded position puck | RUNTIME-TESTED (simulator) | Interpolated between fixes, heading-aligned, accuracy halo, colour by GPS health. |
| Route overview → 3D navigation → arrival | RUNTIME-TESTED (demo route, simulator) | Real Valhalla routing checked in Kyiv by API call; a full real drive is not device-verified. |
| Maneuver card, trip bar, "Back to route" | RUNTIME-TESTED (demo) | |
| Voice prompts (iPhone system voice) | AUTOMATED-TESTED (phrasing, timing) | Audible quality and music ducking need a device check. Neural voice: see docs/VOICE_OPTIONS.md (decision pending). |
| Intro sequence | RUNTIME-TESTED (simulator) | ~2.4 s: star field, the app-icon emblem draws itself (ring, ticks, split arrow), NAVIA wordmark with a light sweep. |
| First-launch story (greeting, slogan «Спокій у русі. Впевненість у меті.», Навіщо? / Як? / Куди? / Чому вірити? / Безпека) | RUNTIME-TESTED (simulator) | Six pages with animated scenes: GPS spoofing, guiding along the route without signal, landmarks at turns, honest colours, shelters + co-pilot. Replay from Settings. |
| Co-pilot (on device) | RUNTIME-TESTED (simulator) · AUTOMATED-TESTED (15 tests) | Understands Ukrainian/Russian/English: shelters and places with distance, direction and walking time; alert and GPS status; "where am I" (street, or between landmarks without GPS); what next / ETA; "I see …" matching against known landmarks; emergency 112/103. Action buttons: walk/drive there, call, "I've turned", "I'm here", Safety. Speaks the situation first when opened by voice. Proactive card on the map. |
| Co-pilot (Claude) and photo recognition | IMPLEMENTED (server prompt + richer state), BLOCKED | Needs a server with the Anthropic key (owner decision: Cloudflare Worker or Firebase). Photo → "where am I" needs the same server (Claude vision). |
| Sign-in (Apple / Google) | IMPLEMENTED, BLOCKED | Firebase Auth via REST, refresh token in the Keychain, unlocks the Claude co-pilot. Needs `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, providers enabled in Firebase; Apple also needs a paid Apple Developer team and a build with `EXPO_PUBLIC_NAVIA_APPLE_SIGNIN=1`. Email sign-in removed from the UI. |
| "Nearest shelter" (during an active alert) | IMPLEMENTED | Appears only when the alert source reports an active alert; not observed live in this session. |
| Resilient navigation without GPS (route-constrained dead reckoning, "I'm here" start, start from last stable fix, "I've turned" confirmation, spoof rejection) | RUNTIME-TESTED (simulator, GPS switched off mid-route) · AUTOMATED-TESTED (core) | Simulator has no accelerometer, so DR used the last trusted GNSS speed. On the phone the accelerometer decides moving/stopped — needs a device drive. |
| Offline map along the route (auto-download at start) | RUNTIME-TESTED (simulator) | Zoom 11–16 corridor via MapLibre offline packs; routing itself still needs internet to build the route. |
| NAVIA map style: "Deep Space" night, "Lunar" day | RUNTIME-TESTED (simulator) | Recolours the OpenFreeMap "liberty" style; teal is reserved for the route. Day mode now changes the whole interface (it only changed the map before). |
| Alert detail: scope (district/city/oblast), level, reasons, other districts | IMPLEMENTED | Fields come from the NEPTUN feed when present; not observed during an active alert. |
| Safety panel (swipe left from the right map edge) | RUNTIME-TESTED (simulator) | Alert status, nearest shelters and resilience points, walking route, share location via the iOS share sheet. |
| GPS / alert beacons on the map | RUNTIME-TESTED (simulator) | Always in the colour of the situation (green / yellow / red, pulsing on trouble); details in the pulled-up sheet. |
| Navigation camera, zoom and HUD | RUNTIME-TESTED (simulator) | Camera follows the road ahead; zoom by speed (16.8 on foot … 14.4 on the highway); a pinch keeps following at the chosen zoom (no more snapping back), a drag frees the camera. HUD: speed, co-pilot, GPS and alert beacons in the colour of the situation. Route drawn as a glowing teal→orange trail. |
| Landmarks along the route | RUNTIME-TESTED (simulator, real Kyiv/Fastiv routes) · AUTOMATED-TESTED | Collected when the route is built (map tiles + OpenStreetMap): traffic lights, fuel, shops, pharmacies, churches, rail crossings, bridges. One cue per turn on the card and in voice ("Через 300 метрів, після АЗС «ОККО», поверніть праворуч"); without GPS the prompts rely on them. |
| GNSS conflict decision | AUTOMATED-TESTED | While guiding without GPS, a steady GPS track far from the estimate is not followed silently: the driver is asked "Так, я тут" / "Ні, це підробка". |
| GPS status stability | RUNTIME-TESTED (simulator, 60 s standing still) · AUTOMATED-TESTED | Standing still no longer flips GPS to "lost": 30 s allowance while stationary plus an active position request when iOS goes quiet (home and navigation). |
| Nearby places (shelters, resilience points, fuel, pharmacies, shops, hospitals, ATMs) | RUNTIME-TESTED (live, Kyiv and Fastiv) | Map vector tiles first (fast CDN), OpenStreetMap Overpass with four mirrors (the main server often answers 504), Nominatim fallback, Kyiv official shelter/resilience layers by position; last results kept on the phone for use without network. Resilience points outside Kyiv are rarely in open data — the co-pilot points to the official "Незламність" bot. |
| Spoken alert notice during a trip | AUTOMATED-TESTED (phrasing) | Alert re-checked every minute during navigation. |
| Startup chime | IMPLEMENTED | Original synthesis (`apps/mobile/scripts/make-intro-sound.mjs`), in the style of the owner's reference; respects the iPhone silent switch. |
| Male voice | Interim: lowered-pitch system voice · Neural male voice: BLOCKED (owner decision) | iOS has no male Ukrainian voice. Options: on-device neural (Piper, works without internet, +70–80 MB) or cloud (Azure uk-UA-OstapNeural, needs server). See docs/VOICE_OPTIONS.md. |

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
