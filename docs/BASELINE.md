# NAVIA baseline (Phase 0) — 30.09.2026

Answers to `docs/NAVIA_MASTER_SPEC.md` §77, from the code on `main` (44051c3) and today's runs. Statuses: IMPLEMENTED · AUTOMATED-TESTED · RUNTIME-TESTED · DEVICE-VERIFIED · PARTIAL · BLOCKED · NOT IMPLEMENTED.

## 1. Does the app reliably launch?
Yes, as far as measured. Release build installed and launched on the owner's iPhone 17 Pro today (`xcrun devicectl … launch` → "Launched application"); on the iPhone 16e simulator a fresh install was captured frame by frame: dark launch screen → intro → onboarding, no crash, no white/icon/map flash. RUNTIME-TESTED (simulator), device launch confirmed by devicectl; the owner uses it daily. Risk: free Apple profile expires 2026-10-07.

## 2. What is real
| Area | Status | Evidence |
|---|---|---|
| Real GPS, GNSS monitor, trend/early warning, trusted position | AUTOMATED-TESTED | `packages/core` tests (413 total pass, CI green) |
| Route dead reckoning when GPS is lost (app mode) | AUTOMATED-TESTED | engine tests; trip replay test (p50 error ≈ 40 m on the demo route) |
| Online routing (Valhalla), search (Photon/Nominatim), OSM places (Overpass) | RUNTIME-TESTED | used on device |
| Shelters (Kyiv open data, data.gov.ua), air alerts (Kyiv Digital, NEPTUN), targets map | RUNTIME-TESTED | providers + tests |
| Trip co-pilot: live Claude via Cloudflare proxy, 20 tools, confirmations, memory | AUTOMATED-TESTED + live eval | holdout 51/59 (86 %), p50 3.0 s |
| Voice: iPhone TTS uk-UA, speech recognition, hands-free | RUNTIME-TESTED | device |
| Background navigation, trip recording | IMPLEMENTED, NOT DEVICE-VERIFIED | added today |

## 3. Templates / stubs
- **Situation navigator** («де я», «пропав GPS», «що далі», «вижу …») = `apps/mobile/src/ai/navigator/intents.ts`: 26-intent classifier + template handlers (the proxy's `/v1/understand` only picks one of those intents and phrases a short answer). This is the "canned bot" the owner feels.
- Resilient particle filter: implemented and simulated, **off** in the app (`resilient: false`); road graph = route line only.
- Neural voice: wired, BLOCKED (Azure key). Traffic: NOT IMPLEMENTED (no source). Offline routing / POI index: NOT IMPLEMENTED. Camera vision: not in the app.

## 4. What the AI navigator does today
Two separate brains, split by regex in `apps/mobile/src/ai/tripCopilot.ts`:
1. Trip actions («заправка по дорозі», «додому», «додай зупинку») → the tool-calling LLM agent (grounded, confirmations, memory).
2. Everything else → the intent classifier. Probe on the spec's reference phrases (route active):

| Phrase | Goes to | Intent |
|---|---|---|
| Пропал навигатор, что делать? | local | signalLost |
| Вижу Фору, а за ней перекрёсток | local | **noData** |
| Что-то сбился опять, куда дальше? | local | reroute |
| Вижу станцию метро, хз какая, а напротив магазин Днипро-М | local | **shelter** |
| Я проехал поворот или нет? | local | reroute |
| Почему ты думаешь что я тут? | local | explain |

## 5. What prevents the target conversation
1. GPS-loss / observation / "where am I" conversations never reach the reasoning agent.
2. The agent has no hands for it: no `locate_by_description`, no `confirm_position`, no guidance-from-landmark; `check_landmark` only looks ahead on the route from the estimate.
3. No eyes: OSM categories cover fuel, food, parking, pharmacy, hospital, supermarket, mall, toilets, hotel, ATM, car wash/repair — no metro, stops, traffic signals, any-brand shops (Дніпро-М = `shop=doityourself`), banks, churches, bridges.
4. The engine has no public "place me here with σ" input from a confirmed landmark (only `setManualPosition` for a start point).

## 6. Single highest-impact root problem
The "GPS failed → describe → re-localize → continue" loop has neither a reasoning path nor data/engine support: phrases fall into a classifier that cannot reason, and even the agent could not search what the driver sees or move the position.

## 7. Next smallest verifiable milestone — Grounded AI Navigator v1
- Engine: accept a landmark fix (position + σ, source LANDMARK), undoable.
- Tools: `locate_by_description` (objects + relations → real OSM candidates in the uncertainty area + route corridor, uniqueness, best distinguishing question), `confirm_position` (safe action; refuses a non-unique candidate without driver confirmation).
- Data: metro stations/entrances, stops, traffic signals, any named/branded shop, banks, churches, bridges.
- Routing: localization / GPS-loss / observation conversations → the agent when the co-pilot is available; the classifier stays only as the offline fallback.
- Proof: deterministic tests on a **recorded real Overpass response** (Kyiv, dated, ODbL) for spec scenarios A–E (ambiguous Fora, metro + Дніпро-М, contradiction, no match, stationary); a live `gps_loss_dialog` eval through the proxy.
