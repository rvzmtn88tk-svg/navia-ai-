# Gap list: status (30.09.2026)

The 17-item gap list (owner, 30.09.2026) checked against the code. Statuses per `docs/NAVIA_TZ.md`.

| # | Item | Status | Where / what is left |
|---|---|---|---|
| 1 | Never built on an iPhone | FIXED (REAL/TESTED) | Release builds installed on the owner's iPhone 17 Pro. TestFlight: NOT STARTED — needs a paid Apple Developer account. Free profile expires 2026-10-07. |
| 2 | No real GNSS-denied trips | NEWLY IMPLEMENTED (REAL/NOT TESTED) | Settings → «Записувати поїздки»: GPS 1 Hz + IMU 10 Hz + route → `apps/mobile/src/trips/tripLog.ts`; `packages/core/src/trip-recording.ts` (`replayTrip`); `npm run replay:trips -- <dir> --write` → `docs/REAL_TRIPS_REPORT.md`. Waiting for 20–50 real drives. |
| 3 | No background navigation | NEWLY IMPLEMENTED (REAL/NOT TESTED) | `apps/mobile/src/background/backgroundLocation.ts` (expo-task-manager), UIBackgroundModes location + audio, audio session stays active. Needs "Always" location; a locked-screen drive is the acceptance test. |
| 4 | Route line only, no road graph | NOT STARTED | Resilient particle filter is off (`resilient: false`); corridor road network still to load (offline package / Overpass). |
| 5 | AI not measured on a real model | FIXED (measured) | Holdout 51/59 (86%, target ≥ 85% met); p50 3.0 s (target ≤ 2.5 s NOT met); ~$0.003 per answer. |
| 6 | No offline | PARTIAL | Region offline package exists (`apps/mobile/src/offline/regionPackage.ts`); offline rerouting and offline place index not done. |
| 7 | Air alerts are demo | OUTDATED — FIXED earlier | `KyivAirAlertProvider`, `GeolocatedAirAlertProvider`, NEPTUN targets map. |
| 8 | No traffic | UNAVAILABLE | Needs a paid source (TomTom/HERE). |
| 9 | Algorithm weak spots | NOT STARTED | Speed-vs-accelerometer check, barometer, landmark anchors. |
| 10 | Home/work/recents lost on restart | FIXED | Persisted in `store/placesStore.ts`; dead session-only state removed from `naviaController.ts`. |
| 11 | No CI | FIXED (REAL/TESTED) | `.github/workflows/ci.yml`: types, all tests, co-pilot replay eval, proxy types — green on GitHub. |
| 12 | No UI tests | PARTIAL | 413 logic tests; no screen tests / Maestro yet. |
| 13 | No crash reports | NOT STARTED | Needs a Sentry account (owner). |
| 14 | Not App Store ready | PARTIAL | `PrivacyInfo.xcprivacy` exists; privacy policy and paid account missing. |
| 15 | Backend not ready for load | MOSTLY FIXED | Cloudflare Worker (HTTPS, per-device rate limits, key server-side). App Attest and a spend limit in the Anthropic console are open. |
| 16 | Camera vision is a stub | N/A | Not exposed in the app. |
| 17 | Two codebases | FIXED | Cloud co-pilot branch merged into this repo. |

Also in this series: no icon/white flash before the intro (dark launch screen and root view), NEPTUN credit only at the bottom of Settings.
