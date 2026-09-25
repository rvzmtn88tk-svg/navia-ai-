# NAVIA feature and data status

Updated 25 September 2026 (Stage 3: maps & navigation). Status labels follow docs/NAVIA_TZ.md §4.

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

## Stage 3 (maps & navigation)

| Area | Status | Notes |
|---|---|---|
| Turn direction (left/right) | FIXED · AUTOMATED-TESTED | Demo router used an unsigned angle, so every left turn came out "right" (reproduced: Kyiv→Boryspil demo route turn −24° was "right"). Now signed (clockwise = right). Real Valhalla mapping checked line by line against the official enum and on a recorded real Kyiv route (9 turns agree with Valhalla's own bearings). |
| Strict radius search (any category) | NEWLY IMPLEMENTED · REAL/TESTED | `searchByRadius(center, radiusM, category?)` in the core POI engine (boundary inclusive, tested). UI: radius chips (Найближчі / 500 м / 1 / 3 / 5 / 10 км) with the circle drawn on the map; every result inside the circle is returned (no top-N cap). |
| Shelters / resilience points | FIXED + extended · REAL/TESTED (live) | Kyiv official GIS (4 194 shelters, 1 210 heating/resilience points) was already used but only when the alert feed said "м. Київ"; now by position. Added OSM `emergency=shelter`, 373 shelters from official open data of 17 Kyiv-oblast communities (data.gov.ua, shipped with the app, offline). Outside Kyiv, resilience points are not in any open registry found — the co-pilot points to the official bot. Every result shows its source and online/offline. |
| Satellite layer | FIXED · RUNTIME-TESTED (simulator) | Cause: no MapTiler key → layer disabled by design. Now keyless Esri World Imagery + NAVIA roads/labels (hybrid). Esri terms require an ArcGIS/MapTiler key for production — test source only. |
| 3D navigation | NEWLY IMPLEMENTED · RUNTIME-TESTED (simulator) | 2D/3D button: 60° tilt, extruded buildings; the position arrow is the top layer and billboarded (faces the screen) so buildings never cover it. Measured (simulator, dev FPS meter): 2D 45 fps, 3D 31 fps, 3D + hillshade 15 fps → hillshade not added in 3D (use the "Рельєф" layer). Terrain elevation (DEM 3D) is not supported by the MapLibre iOS version in this app (6.17). |
| Heading of my marker ("me on the map") | FIXED · REAL/TESTED (unit + simulator synthetic) · NOT TESTED on device | Was: during navigation the arrow took the ROUTE bearing and the compass was off in car mode, so turning the phone changed nothing. Now: compass (CoreLocation heading) fused with the gyroscope (DeviceMotion, 60 Hz, rotation about the vertical in any phone orientation); GPS course only when there is no compass (labelled GPS_COURSE_FALLBACK in Diagnostics). Measured in the app (simulator, synthetic in-place rotation 60°/s, same fusion + marker path): sensor event → marker committed p50 5 ms, p95 7 ms, max 9 ms, marker error 0.0°; + ≤1 map frame (~16 ms). Real compass/gyro only on the phone. |
| Offline map Kyiv + oblast | NEWLY IMPLEMENTED (real download) | Real MapLibre packs (Kyiv z10–14, oblast z6–12) with real progress/size, plus places for offline search; "ready" only after verification. "Тест без інтернету" switch in Settings. Offline routing (new route without network) is still not available. |
| Early GNSS warning | NEWLY IMPLEMENTED · AUTOMATED-TESTED · RUNTIME-TESTED (demo) | Trend monitor: rising/poor accuracy, slower fixes, missed fix. Moving at 54 km/h: first warning +2.1 s (was +6.1 s), loss shown +3.1 s after the last fix (was +9 s). Demo "РЕБ ▸": warning 15 s before the loss. Satellite counts are not available on iOS. |
| Co-pilot speed | FIXED · MEASURED | On-device answers take 0.3–6 ms; the slowness was the screen waiting up to 9 s for place searches before showing anything. Now the answer shows at once and updates itself when data arrives. |

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
