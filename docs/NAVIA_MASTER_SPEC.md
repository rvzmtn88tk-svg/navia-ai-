# NAVIA — Master Product Specification for Claude Code

Product intent, AI navigator behavior, architecture, proof-driven development, full functional audit and definition of done.

- Project: NAVIA / NAVIA AI · Repository: rvzmtn88tk-svg/navia-ai- · Market: Ukraine · UI language: Ukrainian
- Product type: premium resilient navigation that stays useful when GNSS/GPS is degraded, unstable, suspicious or temporarily unavailable.
- **This file is authoritative** (owner, 30.09.2026; condensed faithfully from the owner's message — every requirement kept). Companion: `docs/NAVIA_PRODUCT_SPEC.md` (Russian backlog B0–B10 and acceptance), `docs/BASELINE.md` (living baseline/audit).

## 0. Why this document exists
The project consumed too much time and limits without enough verified product progress: the foundation felt unstable, functions behaved like placeholders, and the AI navigator behaved like a scripted template. From now on work is proof-driven, product-driven and stage-gated. The goal is a working NAVIA, not more code.

Every meaningful change answers: (1) what exact user-visible problem is solved, (2) root cause, (3) how the fix was verified, (4) what evidence proves it is better. File counts, edited lines and "architecture prepared" are not progress.

## 1. Owner's product vision
NAVIA is not "Google Maps with a chatbot". It keeps helping when ordinary GNSS navigation becomes unreliable: **"GPS failed, but NAVIA did not become useless."**

It combines GNSS; GNSS quality/anomaly detection; last trusted position; accelerometer, gyroscope, magnetometer; sensor fusion; dead reckoning; map matching; route context/progress; nearby POIs and landmarks; user observations; position confidence; an AI navigator reasoning over structured facts; Ukrainian voice/UI; offline maps/routing; diagnostics/telemetry. The user only needs to hear clearly: where NAVIA believes they are, how confident it is, what to do next, what NAVIA is doing when GPS is unreliable.

## 2. Core product promise
Always answer: where am I believed to be; how confident; where next; what evidence supports the instruction. High confidence → normal premium navigator. Falling confidence → more conversational and evidence-seeking. GNSS lost → combine last trusted position, elapsed time, speed, heading, sensor motion, dead reckoning, route geometry, road-graph constraints, map matching, landmarks, user observations. Too low → say so honestly and ask for evidence. **Truth is a product feature.**

## 3. Absolute rule — AI never invents navigation facts
Never invent coordinates, current road, route progress, POI existence, landmark identity, side of road, distance, GNSS health, shelter location, turn direction, arrival state. Every concrete claim comes from deterministic data or a clearly scored inference of the navigation/landmark engine. The AI may reason, compare candidates, ask, synthesize evidence, explain uncertainty, revise — never fabricate evidence.

## 4. "An AI navigator that can think"
Recognize degrading GNSS confidence; understand navigation help vs chat; ask useful localization questions; interpret messy descriptions of surroundings; search route-compatible POIs/landmarks; compare and eliminate candidates; detect contradictions; pick the observation that best separates two candidates; re-localize when evidence is strong; continue guidance on estimated progress; revise beliefs; admit uncertainty; recover smoothly when GNSS returns. This requires a Navigator Agent over structured tools, not scripted responses.

## 5–8. Target conversations
- **GPS disappears.** «Пропал навигатор, что делать?» → «GPS нестабільний, але я бачу останню надійну позицію і маршрут. Скажи, що бачиш попереду або поруч: магазин, заправку, міст, перехрестя, метро, світлофор чи помітну будівлю.» Generated from actual state; if GPS is healthy, never pretend it is lost.
- **User sees a landmark.** «Вижу Фору, а за ней перекрёсток.» Parse into entities → search Fora POIs near the estimated corridor → compare route geometry, distance travelled, intersection topology, heading, side of road → rank → decide. Strong: «Схоже, це Fora на твоєму маршруті біля наступного перехрестя… поверни праворуч…» (a confirming cue only if it exists in data). Weak: «Поруч із твоїм коридором маршруту є дві Fora… магазин праворуч чи ліворуч, і чи є світлофор?»
- **Estimated route progression** (the owner's «режим искусственного передвижения по маршруту») is not a fake dot at constant speed: last trusted position, route shape, previous speeds, motion sensors, acceleration, gyro/heading, elapsed time, map/route constraints, landmark and user confirmations. Confidence decays; without speed evidence the envelope widens; before a critical turn with low confidence, ask for a landmark.
- **Lost again.** «Что-то сбился опять, куда дальше?» → «Позиція зараз невпевнена. Скажи, що бачиш поруч…». «Вижу станцию метро, не знаю какую, а напротив магазин Днипро-М» → parse metro + Dnipro-M + "opposite" → route-compatible Dnipro-M POIs → metro stations near them → candidate pairs matching the relation → compare with last trusted position, heading, elapsed time, travelled distance, previous observations → name the station only if the match is sufficiently unique; two plausible → «Дніпро‑М праворуч чи ліворуч від напрямку руху?». Seek the minimum extra evidence.

## 9. Navigator Agent architecture
The AI sits on deterministic tools conceptually equivalent to: getNavigationState, getLastTrustedPosition, getEstimatedPosition, getPositionConfidence, getConfidenceBreakdown, getGNSSState, getGNSSAnomalyReasons, getCurrentRoute, getRouteProgress, getNextManeuver, getUpcomingManeuvers, getCurrentRoadCandidates, getMapMatchCandidates, searchNearbyPOI(query, radius, routeCorridor), searchNearbyLandmarks, findLandmarkPairs, findRouteCompatibleLandmarks, getPOIRelationToRoute, getHeading, getSpeedEstimate, getDeadReckoningState, getOffRouteStatus, requestReroute, confirmUserObservation, getShelterCandidates, getProviderAvailability. No unrestricted freedom to invent navigation data.

## 10. Short-term drive memory
Structured trip memory of observations (saw Fora; Fora on the right; intersection after; turned right; metro later; Dnipro-M opposite; GNSS lost at T; last trusted segment S; candidate A rejected; driver stationary):

```ts
type UserObservation = {
  timestamp: number;
  entities: Array<{ type: "poi" | "road_sign" | "intersection" | "metro" | "bridge" | "traffic_light" | "road_name" | "other"; name?: string; category?: string }>;
  relations?: Array<{ subject: string; relation: "left_of" | "right_of" | "opposite" | "ahead_of" | "behind" | "after" | "before" | "near"; object: string }>;
  confidence: number;
  rawText: string;
};
```

## 11. Observation interpretation
Understand «вижу фору», «какая-то азс справа», «мост и потом светофор», «метро напротив днепро-м», «большая церковь слева», «железка впереди», «вог сразу после перекрестка», «табличка Боярка», «дорога уходит под мост» → structured observations; never turn a vague observation into a precise landmark without map/POI data.

## 12–14. Landmark matching, constellations, clarification
Score candidates by distance from estimate, route-corridor distance, heading, side of road, expected sequence, neighbouring landmarks, intersection topology, described relations, time since last trusted fix, dead-reckoned distance, consistency with previous observations, minus contradictions — explainable, not a blind formula. Combinations (WOG + bridge, Fora + intersection, Dnipro-M opposite metro, pharmacy + church + lights, rail crossing + supermarket, fuel right after a roundabout) are much stronger than single POIs — a defining capability. When ambiguous, ask the question that best separates the top candidates (e.g. «Fora зараз праворуч чи ліворуч?», «Дніпро‑М прямо навпроти входу в метро чи трохи далі?»): maximum information gain, minimum driver burden.

## 15–17. Confidence-aware dialogue, human observation as a sensor, self-revision
Every answer knows position/route/landmark confidence, GNSS state, ambiguity. HIGH: concise guidance. MEDIUM: cautious wording, optional confirmation. LOW: no precise claims, ask for evidence. UNKNOWN: do not invent, say the position cannot be established. User observations are a sensor: timestamped, uncertain, with possible map matches; a unique confirmed landmark sharply improves confidence, a vague one slightly, a contradiction lowers it and forces re-evaluation. Revise when new evidence contradicts a prior inference («Схоже, попередня прив’язка була неточною… перераховую маршрут»).

## 18–19. Decision contract and tool-call proof
```ts
type NavigatorDecision = {
  action: "GUIDE" | "ASK_OBSERVATION" | "ASK_CLARIFY" | "RELOCALIZE" | "REROUTE" | "WAIT_FOR_CONFIDENCE" | "ARRIVED" | "UNAVAILABLE";
  confidence: number; evidence: string[]; contradictions: string[]; userMessage: string; nextExpectedEvidence?: string[];
};
```
Diagnostics show for important decisions: question, tools called, structured results, candidates, chosen candidate, confidence, rejection reasons, final response.

## 20–27. Behaviour requirements
- No canned intent bot as the final product; understand open questions («Я не понимаю где я», «Слева заправка, а впереди мост», «Я проехал поворот или нет?», «Почему ты думаешь что я тут?», «GPS вообще живой?», «Я вижу две аптеки подряд», «Магазин должен быть справа?», «Я точно на нужной дороге?», «Если сейчас поверну, смогу вернуться на маршрут?») and use tools.
- Explain enough to build trust (evidence, not bare "yes").
- No false precision: ±250 m → «приблизно через 200–300 метрів», never "37 m".
- Route-corridor search: current corridor, plausible parallel roads, reachable distance since last trusted fix — not the whole city.
- User corrections («не та заправка», «метро слева», «я уже повернул», «я стою», «еду быстрее», «это круг») are evidence.
- Stationary: never advance the estimate while stopped; distinguish stopped / moving / uncertain.
- Turns inferred from gyro/yaw, heading change, topology, acceleration, user confirmation — never only because the route expected one.
- GNSS recovery: assess, compare with estimate, require consistency, reconcile, restore smoothly; strong conflict → lower confidence and investigate.

## 28–34. GNSS, trusted position, dead reckoning, fusion, map matching, confidence
- GPS indicator = state, not update frequency; never blinks. GREEN «GPS стабільний», YELLOW «GPS нестабільний», RED «GPS втрачено»; separate position-confidence high/medium/low/uncertain; hysteresis (one bad fix ≠ red, one good fix ≠ green).
- Intended anomaly model `0.30 jump + 0.25 speed + 0.15 heading + 0.20 roadMismatch + 0.10 staleFix` — audit normalisation, thresholds, missing inputs, false positives, hysteresis; never label one fix as spoofing/jamming; neutral states.
- Trusted position only on fresh, accurate, low-anomaly, map/route-compatible, plausible fixes; DR starts from it.
- DR: speed, gyro, heading, acceleration, route geometry, map constraints, growing uncertainty; a 10 s and a 10 min outage never share confidence.
- Fusion: accel, gyro, magnetometer, GNSS speed/heading, future vehicle speed; long-term EKF `[x, y, vx, vy, heading, gyroBias]`; high-rate streams stay in engine/providers, UI gets throttled derived state.
- Map matching: not nearest-road snapping; distance, heading, continuity, speed, previous segment; mark ambiguity.
- Confidence `0.28 GNSS + 0.16 freshness + 0.18 sensor + 0.22 map + 0.16 route`; HIGH ≥ 0.75, MEDIUM ≥ 0.50, LOW ≥ 0.25, UNKNOWN < 0.25 — audit, do not assume.

## 35–40. Routing, offline, search, POI, shelters, air raid
- Valhalla behind provider abstraction (online, offline, demo). Audit destination → geocoding → origin → request → provider → response → geometry → maneuvers → progress → off-route → reroute → arrival; validate coordinate order, geometry, distance, ETA, maneuvers, road names, reroute, provider errors. Never show nonsense routes because an API returned success.
- Offline (Kyiv + oblast): OSM PBF → clip → routing graph → address index → POI index → landmark index → vector tiles → versioned package. Separate statuses for offline map / routing / geocoder / POI-landmark index; no single fake "offline ready".
- Search: Ukrainian addresses, Cyrillic, Kyiv/oblast, online geocoder, offline SQLite FTS, recents, duplicate streets, network failure, no-result; no demo addresses posing as production.
- POI categories at minimum: fuel, supermarket, pharmacy, hospital, bridge, railway crossing, major intersection, shopping centre, school, church, parking, government building, metro, recognisable landmarks, shelter — useful for re-localization, not only browsing.
- Shelter flow: Знайти укриття → known shelters → choose → route → distance → ETA → navigate. Never "safe", no tactical inference.
- Air raid: informational only; no "safe route" claims; alert data separate from navigation confidence.

## 41–51. UI and design
- Driving screen instantly shows position, route, next maneuver, distance to it, remaining distance, ETA, reliability. No tiny developer text, no overlaps.
- **Map interaction is a release blocker until verified:** pinch zoom, zoom buttons, pan, rotate, compass, recenter, follow mode, breaking follow by dragging, returning to follow. A rendered map is not proof. Audit touch-intercepting overlays and camera logic that overwrites user zoom on each position update.
- Compass never hidden by the maneuver card; dedicated zones for maneuver card, compass, GNSS indicator, recenter/zoom, AI control, bottom panel.
- Branded position marker: exact centre, heading, identity, optional accuracy halo, no raw-noise jitter.
- Home: primary «Куди їдемо?»; secondary recents, Знайти укриття, AI navigator, offline maps, settings; diagnostics developer-oriented.
- AI navigator UI is a core capability: NAVIA AI icon (satellite/orbital motif), listening/processing/speaking/unavailable states, contextual responses, minimal map obstruction.
- Voice: uk-UA TTS; commands for route, next turn, distance, correct road, GPS status, landmark confirmation, repeat, find shelter; never show a mic as working if STT is not implemented.
- All NAVIA-owned UI Ukrainian (system dialogs may follow iOS language).
- Premium bar (Apple Maps, Google Maps, Waze, HERE WeGo, OEM automotive) — principles only: map-first, readable, glanceable, strong primary controls, disciplined spacing, restrained overlays, consistent type.
- Central tokens for colours, type, spacing, radii, elevation, icon sizes, touch targets, semantic states; systematic per-screen visual QA (alignment, margins, rhythm, padding, hierarchy, icons, safe area, keyboard, home indicator, long Ukrainian strings, all states, small/large iPhone, collisions).

## 52–55. Performance, startup, crashes, error states
- Profile rerenders, Zustand subscriptions, map source updates, sensor rates, route geometry recreation, timers, repeated provider calls, logging, voice effects; measure before/after; never hide lag by removing functionality.
- Startup history (splash hangs, duplicate RNCSafeAreaProvider, inconsistent RN/safe-area versions, missing @react-native/js-polyfills, DerivedData corruption, local vs GitHub drift): before dependency changes inspect working tree, lockfile, `npm ls`, Podfile.lock, Expo Doctor, runtime logs. Never blindly reinstall.
- Every reproducible crash is a release blocker: repro, stack, root cause, fix, regression test, runtime verification. No global exception suppression.
- Explicit error behaviour for: no internet, geocoder/route failure, malformed route, map style/tiles unavailable, GPS permission denied/disabled, GNSS degraded/lost, sensors unavailable, offline graph/geocoder/POI missing, shelter source missing, AI backend missing, TTS/STT unavailable — each says what happened, what still works, what the user can do, whether to retry.

## 56–58. Inventories
Full feature inventory from source (screen/module, purpose, inputs, outputs, dependencies, user-visible result, success/loading/error/offline behaviour, automated tests, runtime verification, status). Statuses only: IMPLEMENTED, AUTOMATED-TESTED, RUNTIME-TESTED, DEVICE-VERIFIED, PARTIAL, BLOCKED, NOT IMPLEMENTED. Every-button audit (label, screen, target, handler, expected/actual effect, feedback, disabled, a11y label, result) — no dead or decorative controls. Every-screen audit (purpose, entry/exit, data, loading/empty/error/offline/permission states, visual, language, a11y, performance).

## 59–62. Proof-driven protocol, measurable progress, anti-loop, budget
1 define exact expected behaviour → 2 reproduce → 3 root cause → 4 smallest coherent fix → 5 automated checks → 6 run the app → 7 verify user-visible behaviour → 8 if still failing investigate immediately → 9 record proof. Not done before step 9. Stage reports: what was broken, root cause, what changed, user-visible difference, automated/runtime tests, device status, blockers. Two substantial attempts without verified improvement → stop, restate, collect evidence, isolate, minimal repro, new hypothesis. Before a large refactor explain the exact problem, why smaller is insufficient, what proof shows success. Priority: startup → crashes → map interaction → real route correctness → GNSS state → AI navigator architecture → UI structure → polish.

## 63–66. Phases, AI milestones, deterministic scenarios, AI acceptance failures
Phases: 0 baseline truth (no edits) · 1 reliable launch · 2 map + navigation loop · 3 GNSS/confidence/DR · 4 grounded AI Navigator v1 · 5 landmark/POI reasoning · 6 voice · 7 shelter routing · 8 offline package · 9 premium UX · 10 full regression + device verification.
AI milestones: AI-1 grounded Q&A (next turn, remaining distance, GPS, confidence, route status) · AI-2 free-form observation parsing · AI-3 candidate landmark matching · AI-4 clarification questions · AI-5 re-localization · AI-6 degraded-GNSS route continuation · AI-7 multi-turn recovery · AI-8 voice.
Scenarios: A ambiguous Fora (two Fora, only one followed by a signalised right turn → ask side/signal) · B metro + Dnipro-M (GNSS lost, 35 s moved, exactly one reachable pair → re-localize) · C contradiction (expected left, user says right → revise or lower confidence) · D no match (never invent) · E stationary (estimate stops advancing).
Acceptance fails if the AI outputs coordinates not from a tool, names a POI not in candidate data, gives exact distance at low confidence, confirms from one weak clue, ignores contradictions, treats stale position as exact, advances while stationary, answers with canned unrelated text, or answers navigation questions without querying state.

## 67–70. UX, performance, build policy, device verification
Visual acceptance fails on inconsistent fonts, tiny critical text, overlaps, unclear icon hierarchy, blocked map, random spacing, misaligned buttons, truncated Ukrainian, generic dot, hidden compass, GPS icon blinking without reason. Performance fails if gestures stutter under sensor updates, UI rerenders at sensor rate, routes recompute without events, AI/voice block navigation UI, timers/subscriptions leak. Build: no blind upgrades, no `npm audit fix --force`, no repeated native regeneration, no deleting lockfiles/Pods first; inspect mismatches, respect Expo SDK compatibility, targeted native changes, Expo Doctor, rebuild only when justified. Device claims require launching and interacting on the physical device; otherwise ask the owner for the smallest exact action. Never claim DEVICE-VERIFIED without device evidence.

## 71–73. Living audit, proof of claims, product over code
Maintain a living audit (foundation, map, routing, GNSS, dead reckoning, AI navigator, voice, offline, shelter, UI/UX, performance). "Fixed map zoom" needs root cause, changed logic, automated check, runtime and device result. "AI can identify a landmark" needs input, candidate set, tool outputs, confidence, final answer, no hallucinated entity. "GPS state is correct" needs deterministic sequences for green, yellow, red, recovery. Each stage ends with a demonstrable capability.

## 74–75. Definition of done
Feature: implementation, types compile, meaningful tests, runtime executed, loading/error states, correct Ukrainian, design-system visuals, honest failure, no regression, explicit device status (else "IMPLEMENTED, NOT DEVICE-VERIFIED"; never plain "DONE"). Foundation ready only when it demonstrates: installable app, stable startup, real location, real Kyiv address, real route, map gestures, branded marker, Ukrainian UI and TTS, GNSS healthy/degraded/lost, trusted position, DR, confidence, map matching, recovery, off-route/reroute, offline map status, honest offline routing status, POI/landmark context, shelter routing with real data, non-hallucinating AI, diagnostics, deterministic tests, iOS build, Android path when available.

## 76. Final experience
Healthy → premium navigator. Degrading → yellow, continues. Lost → red, explains estimation. Adequate confidence → continues on sensors/route/map. Dropping → asks for a landmark. Messy description → interpreted. Several matches → one precise question. One strong match → re-localizes. Driving on → estimated progression. GPS returns → validated, smooth recovery.

## 77–79. First action, next milestone, final message
First action after reading: a concise baseline report (launches? what is real? what is template/stub? what does the AI navigator do? what blocks the target conversation? single highest-impact root problem? next smallest verifiable milestone?), then proceed. Next milestone unless a worse blocker exists: **Stable NAVIA + grounded AI Navigator v1** — understands free-form navigation questions, queries structured tools, answers next-turn/GPS/confidence, asks for an observation at low confidence, parses a simple landmark description, queries nearby POI candidates, refuses to confirm when ambiguous, asks one targeted clarification, confirms only on strong evidence. Impress with evidence, not code volume.
