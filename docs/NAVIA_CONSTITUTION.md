# NAVIA — CODEX PRODUCT CONSTITUTION, OWNER INTENT, FULL AUDIT MANDATE & DEFINITION OF DONE

**Status:** Master product/context file for Codex  
**Project:** NAVIA / NAVIA AI  
**Repository:** `rvzmtn88tk-svg/navia-ai-`  
**Primary language of the product UI:** Ukrainian  
**Product category:** Premium resilient navigation for Ukraine  
**Core principle:** Never fake navigation certainty. Never make the UI look “finished” when the underlying function is not real, tested, and honest.

---

## 0. HOW TO USE THIS FILE

This document is not a cosmetic redesign brief and not a request to patch a few bugs.

It is the product constitution for NAVIA.

Read this entire file before making changes. Then inspect the real working tree and compare the implementation against this specification. The codebase is the current implementation; this file describes the intended product, quality bar, behavior, architecture, UX philosophy, audit requirements, and definition of done.

Before beginning work, request whatever permissions the environment requires for:

- reading the full repository;
- editing, creating, moving, and deleting project files;
- running terminal commands;
- running TypeScript, test, lint, Expo, CocoaPods, Xcode, and build commands;
- inspecting Metro/Xcode/runtime logs;
- running the iOS development build;
- using connected GitHub access;
- installing or updating dependencies only when technically justified;
- researching public UX patterns when useful;
- creating screenshots, test evidence, and audit notes if the environment supports it.

The owner intends to grant the required permissions up front and then be unavailable for several hours.

After permissions are granted:

- do not repeatedly stop for routine confirmations;
- do not ask the owner to choose between obvious engineering fixes;
- do not stop after compilation;
- do not report “done” after only editing code;
- continue through audit → implementation → build → runtime test → bug discovery → fix → rebuild → retest;
- stop only for a genuine blocker requiring something only the owner can provide, such as an external credential, paid account, physical-device interaction, private API key, or irreversible action not covered by granted permissions.

If the platform does not support one blanket permission grant, minimize interruptions and batch permission requests wherever possible.

---

# 1. THE OWNER'S ACTUAL INTENT

NAVIA is not being created to demonstrate that a map can open, a route polyline can render, or a React Native application can compile.

The owner wants a serious navigation product foundation.

The desired emotional reaction is:

> “This feels deliberate, premium, stable, trustworthy, and built by people who understand navigation.”

The unacceptable reaction is:

> “This looks like an engineering prototype with random cards, tiny text, fake statuses, rough spacing, unstable functions, and a map embedded in an app.”

The owner is especially sensitive to one failure mode:

**a feature appears visually finished, but was not actually tested.**

That is worse than an explicit “not available yet” state.

Therefore, every implementation decision must prefer:

1. real functionality;
2. honest degraded/unavailable behavior;
3. clear confidence;
4. deterministic testability;
5. readable premium UX;
6. evidence that the feature was actually executed.

Do not optimize for speed of showing the owner another screenshot.

Optimize for product integrity.

---

# 2. PRODUCT DEFINITION

NAVIA is a resilient navigation application designed to remain useful when conventional GNSS/GPS quality becomes degraded, intermittent, suspicious, or temporarily unavailable.

Initial geographic focus:

**Kyiv and Kyiv Oblast, Ukraine.**

The product combines:

- GNSS/GPS;
- GNSS integrity monitoring;
- IMU/sensor fusion;
- dead reckoning;
- map matching;
- route progress;
- trusted-position logic;
- confidence calculation;
- offline maps;
- offline-capable routing architecture;
- POIs and recognizable landmarks;
- Ukrainian voice;
- AI co-pilot / AI navigator;
- diagnostics;
- honest recovery behavior after GNSS returns.

The primary product question is not only:

> “Where does GPS say I am?”

It is:

> “Given all available evidence, where does NAVIA believe I am, how certain is that estimate, and what should I do next?”

---

# 3. NON-NEGOTIABLE PRODUCT PROMISES

NAVIA must never:

- invent coordinates;
- invent roads;
- invent route progress;
- invent POIs;
- invent a shelter location;
- invent a landmark confirmation;
- invent GPS/GNSS health;
- claim a position is reliable when confidence is low;
- claim offline routing works if the offline graph is not present;
- claim the AI “sees” or “knows” navigation facts that were not supplied by deterministic navigation engines;
- pretend a route succeeded when the provider failed;
- replace real navigation logic with a hardcoded demo in production flow;
- treat one bad GPS fix as proof of spoofing or jamming;
- label an informational shelter as “safe” without a legitimate source and explicit product policy;
- provide tactical threat inference from air-raid information.

NAVIA must be comfortable saying:

- “GPS signal is unstable.”
- “Position confidence is low.”
- “I am estimating your position.”
- “I cannot confirm that landmark.”
- “Offline routing is not available for this region yet.”
- “Route calculation failed.”
- “I need a reliable position before confirming this turn.”

Truth is a product feature.

---

# 4. ARCHITECTURAL CONSTITUTION

The intended navigation pipeline is:

`GNSS → GNSS integrity/anomaly detection → sensor fusion → trusted position / dead reckoning → map matching → route engine → route progress → landmark/POI context → confidence → AI explanation → voice`

The AI is downstream of navigation truth.

The AI must never become the source of navigation truth.

Expected domain modules include or are conceptually equivalent to:

- `NavigationEngine`
- `PositionEngine`
- `GNSSMonitor`
- `SensorFusionEngine`
- `DeadReckoningEngine`
- `MapMatcher`
- `RouteEngine`
- `RouteProgressEngine`
- `LandmarkEngine`
- `ConfidenceEngine`
- `OffRouteDetector`
- `RecoveryEngine`
- `AIEngine`
- `VoiceEngine`
- `AirAlertLayer`
- `OfflineMapManager`
- `OfflineRoutingEngine`
- `OfflineGeocoder`
- `POIEngine`
- `CameraVisionEngine`
- `DemoEngine`
- `TelemetryLogger`
- `DiagnosticsEngine`

Audit whether current files preserve these responsibilities.

Screens must not duplicate navigation math.

UI components must consume state; they must not invent it.

Provider layers must abstract external systems.

Demo mode must feed the same production engines where possible rather than bypassing them with fake UI values.

---

# 5. NAVIGATION STATE MACHINE

The target navigation lifecycle includes:

`IDLE → ROUTING → ACTIVE → GNSS_DEGRADED → GNSS_LOST → POSITION_UNCERTAIN → GNSS_RECOVERED → ACTIVE`

Additional transitions:

`ACTIVE → OFF_ROUTE → ROUTING`

`ACTIVE → ARRIVED`

Transitions must use hysteresis.

The app must not rapidly bounce between states from a single noisy sample.

Audit:

- transition conditions;
- minimum dwell time;
- recovery conditions;
- state persistence;
- UI mapping;
- telemetry;
- voice announcements;
- route recalculation interactions;
- behavior when multiple bad conditions occur simultaneously.

The UI must reflect this state machine clearly and calmly.

---

# 6. GNSS INTEGRITY AND GPS STATUS — CRITICAL

The owner explicitly rejects a GPS icon that blinks on every position update.

The GPS/GNSS indicator represents **navigation integrity state**, not event frequency.

The existing intended anomaly model is:

`anomalyScore = 0.30*jumpScore + 0.25*speedScore + 0.15*headingScore + 0.20*roadMismatchScore + 0.10*staleFixScore`

Audit whether this is implemented, how each component is normalized, and whether the inputs are valid.

The displayed user-facing state must be driven by evidence including:

- fix freshness;
- horizontal accuracy;
- impossible or suspicious jumps;
- plausible speed;
- heading consistency;
- route compatibility;
- road/map match quality;
- stale timestamps;
- signal continuity;
- trusted-position continuity;
- overall position confidence.

Required visible semantics:

## GREEN — stable / healthy

Use when the navigation solution is healthy enough for ordinary guidance.

Characteristics may include:

- fresh fixes;
- reasonable accuracy;
- low anomaly score;
- position compatible with road/route;
- stable continuity;
- confidence sufficiently high.

## YELLOW — degraded / suspicious / unstable

Use when position is still usable but should not be presented as fully trusted.

Examples:

- accuracy worsening;
- intermittent fix quality;
- moderate anomaly score;
- unstable heading;
- suspicious jump corrected/rejected;
- road mismatch;
- stale-ish data;
- inconsistent fix sequence;
- map matching ambiguity;
- confidence dropping.

## RED — severely unreliable / effectively lost

Use when normal GNSS guidance should not be trusted.

Examples:

- no usable fresh fixes;
- prolonged GNSS loss;
- severe anomalies;
- position no longer supported strongly enough;
- confidence below an acceptable navigation threshold.

Red does not mean “panic.”

It means:

> NAVIA is no longer willing to pretend GPS is trustworthy.

When possible, NAVIA should continue with dead reckoning / sensor fusion / map matching, and expose the reduced confidence honestly.

## Hysteresis

Implement and test hysteresis.

The indicator must not oscillate:

`GREEN → YELLOW → GREEN → YELLOW`

from minor measurement noise.

Test minimum transition persistence, recovery requirements, and threshold separation.

## Audit evidence

For every state, produce test evidence showing:

- sample sequence;
- internal GNSS state;
- confidence value;
- visible indicator color/state;
- reason code or diagnostic explanation;
- recovery behavior.

---

# 7. TRUSTED POSITION

The trusted position is a critical concept.

It should only be advanced by sufficiently reliable evidence.

A fix should generally not become the trusted anchor merely because iOS emitted it.

Audit rules such as:

- acceptable accuracy;
- low anomaly score;
- route compatibility;
- map compatibility;
- timestamp freshness;
- plausible motion;
- confidence threshold.

When GNSS degrades, dead reckoning should evolve from the last trustworthy anchor rather than from a known-bad fix.

The UI must distinguish:

- current estimated position;
- raw GNSS position where useful for diagnostics;
- last trusted position;
- confidence.

Do not expose this complexity to the driver unless it helps.

Expose it fully in diagnostics.

---

# 8. DEAD RECKONING

Baseline:

`distance = speed * dt`

projected from the trusted position using heading.

Architecture should support:

- gyro yaw;
- accelerometer;
- magnetometer;
- GPS speed;
- GPS heading;
- vehicle speed if later available;
- bias estimation;
- uncertainty growth.

A future EKF design may use:

`[x, y, vx, vy, heading, gyroBias]`

Audit:

- units;
- timestamp monotonicity;
- integration interval;
- sensor frequency;
- device orientation assumptions;
- heading source switching;
- drift;
- stationary behavior;
- bias accumulation;
- uncertainty expansion over time;
- map-match correction;
- GNSS recovery correction.

Tests must cover:

- stationary device;
- constant velocity;
- turning;
- stop/start;
- GNSS outage;
- GNSS recovery;
- inconsistent sensor data.

Dead reckoning must never silently maintain “high confidence” forever during long GNSS loss.

Uncertainty must grow.

---

# 9. SENSOR FUSION

The product can begin with a quality-aware weighted fusion model, but the architecture must support a proper state estimator.

Audit all sensor sources and their update frequencies.

Specifically inspect performance impact: 10 Hz sensor streams can cause expensive React/store updates if the architecture pushes raw IMU data into UI state.

Sensor processing should remain in engine/native/provider layers.

The React UI should receive appropriately throttled derived state.

Test:

- sensor unavailable;
- magnetometer unreliable;
- heading unavailable;
- app background/foreground;
- permission differences;
- high-frequency input;
- battery/performance implications.

---

# 10. MAP MATCHING

Map matching must not simply snap every point to the nearest road.

Candidate scoring should consider:

- distance;
- heading compatibility;
- route continuity;
- speed/plausibility;
- previous candidate continuity.

Require a meaningful winner margin.

If candidates are ambiguous, return uncertainty rather than falsely snapping.

Audit:

- intersections;
- parallel roads;
- overpasses;
- service roads;
- parking areas;
- bridges;
- rail crossings;
- route deviation;
- noisy GPS;
- dead-reckoned positions.

Map matching must feed confidence and GNSS anomaly detection, not merely visual placement.

---

# 11. CONFIDENCE MODEL

The intended confidence dimensions include:

- GNSS quality;
- freshness;
- sensor support;
- map match;
- route compatibility.

One specified weighting is:

`0.28 GNSS + 0.16 freshness + 0.18 sensor + 0.22 map + 0.16 route`

Bands:

- `HIGH >= 0.75`
- `MEDIUM >= 0.50`
- `LOW >= 0.25`
- `UNKNOWN < 0.25`

Audit whether current implementation matches this intent.

Do not blindly preserve weights if current code demonstrates a better explicitly tested model, but any deviation must be justified and documented.

The UI should not overwhelm users with a numeric score during driving.

Driver-facing presentation should be simple.

Diagnostics may expose the numeric decomposition.

---

# 12. ROUTING

Valhalla is the intended main routing engine behind a provider abstraction.

Architecture should support:

- `OnlineValhallaProvider`
- `OfflineValhallaProvider`
- `DemoRoutingProvider`

The route engine must not care which provider produced the route.

Audit the complete chain:

`destination input → geocoding → origin → route request → provider → route response → geometry → maneuvers → progress → off-route → reroute → arrival`

Validate:

- coordinate order;
- lat/lon mistakes;
- geometry decoding;
- units;
- maneuver distances;
- ETA;
- route polyline;
- route bounds;
- route start/end;
- road names;
- reroute conditions;
- repeated reroute loops;
- API error behavior;
- timeout behavior.

A nonsense route is not acceptable merely because an API returned HTTP 200.

Use sanity checks.

---

# 13. OFFLINE MAPS AND ROUTING

Offline capability is essential to NAVIA.

Initial package target:

**Kyiv + Kyiv Oblast.**

Intended pipeline:

`OSM PBF → clip region → routing graph → address index → POI index → vector tiles → packaged region`

Metadata should include:

- version;
- region;
- generation date;
- checksums;
- compatibility version;
- package completeness.

Audit the current data scripts and runtime support.

The application must distinguish:

- map available offline;
- route graph available offline;
- geocoder available offline;
- POI index available offline.

Do not collapse these into one fake “offline ready” switch.

If only map tiles are cached but routing is not, say so.

---

# 14. GEOCODING AND SEARCH

Search must support real addresses.

Initial geography:

Kyiv and Kyiv Oblast.

Intended design:

- online geocoder provider;
- offline SQLite FTS address index;
- recent destinations;
- meaningful result ranking;
- clear locality labels;
- routeable coordinates.

Audit:

- Ukrainian address input;
- Cyrillic;
- abbreviations;
- duplicate street names;
- settlement disambiguation;
- partial query;
- no result;
- network failure;
- recent destinations;
- keyboard behavior;
- loading states;
- result tap target;
- cancellation.

No hardcoded “demo address” should masquerade as production search.

---

# 15. POIs AND LANDMARKS

Important POI categories include:

- fuel;
- supermarket;
- pharmacy;
- hospital;
- bridge;
- railway crossing;
- major intersection;
- shopping center;
- school;
- church;
- parking;
- government;
- recognizable landmarks;
- shelters as a separately handled informational category.

A key NAVIA behavior:

User:

> “I see a WOG gas station and a bridge. Is that the one?”

NAVIA should evaluate structured evidence:

- estimated position;
- route;
- POI distance;
- bearing;
- side of road;
- route continuity;
- next maneuver;
- landmark confidence.

It may answer “yes” only when supported.

Otherwise:

- “possibly”;
- “I cannot confirm”;
- “there are two matching stations nearby”;
- “the station on your route should be on the right in 300 m.”

Audit landmark confirmation logic for false confidence.

---

# 16. SHELTER ROUTING

The owner explicitly requires a route-to-shelter workflow.

Desired flow:

`Find shelter → show known shelter POIs → select shelter → route → distance → ETA if available → navigation`

Requirements:

- shelter source must be identifiable;
- display data freshness/source if practical;
- shelter marker must be distinct;
- shelter details must not imply verified safety unless such verification exists;
- route calculation uses the normal route engine;
- offline behavior must be honest;
- no tactical threat inference.

Required Ukrainian terminology should be consistent, for example:

- `Укриття`
- `Знайти укриття`
- `Маршрут до укриття`

Audit empty state:

> “Немає доступних даних про укриття для цієї області.”

is better than silently showing nothing.

---

# 17. AIR-RAID INFORMATION

Air-raid data is informational.

NAVIA may display status if a legitimate source/provider is configured.

NAVIA must not:

- infer that a route is safe;
- recommend tactical evasion;
- calculate a “safer” route based on unverified threat assumptions;
- imply official emergency authority unless explicitly integrated and authorized.

Keep routing and alert layers conceptually separate.

---

# 18. AI NAVIGATOR — NAVIA AI

The AI co-pilot is an interpreter and conversational layer over structured navigation state.

It must not invent navigation facts.

Intended tools/data include:

- `getNavigationState`
- `getPositionConfidence`
- `getGNSSState`
- `getNextTurn`
- `getRouteProgress`
- `getNearbyLandmarks`
- `searchNearbyPOI`
- `getCurrentRoad`
- `getDestination`
- `getOffRouteStatus`
- `getLastTrustedPosition`

AI responses must be grounded only in provided tool/state results.

If a tool is unavailable, the AI must say it cannot verify.

Examples:

Good:

> “GPS is unstable, but NAVIA is still tracking you using the last trusted position, motion sensors, and the road model. Confidence is medium.”

Bad:

> “You are definitely on Soborna Street.”

when the engine did not provide that fact.

Audit AI prompts, provider boundaries, error handling, tool schemas, and data minimization.

---

# 19. AI NAVIGATOR VISUAL IDENTITY

The owner likes the existing NAVIA visual/logo direction.

Do not throw it away.

Develop a dedicated NAVIA AI Navigator symbol based on the existing AI icon concept, with an additional satellite/orbital motif.

It should communicate:

- navigation intelligence;
- satellite/navigation context;
- NAVIA brand;
- motion/orientation;
- premium technology.

It must not resemble the ChatGPT logo or another well-known AI brand.

The mark should work at:

- app icon scale;
- 24–32 px UI icon scale;
- AI floating action button;
- splash/brand context;
- dark and light backgrounds if those themes exist.

Audit optical centering, stroke weight, small-size legibility, and contrast.

---

# 20. VOICE

Primary user-facing language:

**Ukrainian.**

TTS locale:

`uk-UA` where supported.

Voice commands should ultimately include concepts such as:

- route to Boyarka;
- next turn;
- distance remaining;
- am I on the correct road;
- GPS status;
- confirm WOG/landmark;
- show route;
- repeat instruction.

If STT is not implemented, do not create a microphone interaction that looks fully functional without a clear unavailable state.

Audit:

- TTS errors;
- overlapping speech;
- repeated maneuver announcements;
- mute state;
- voice volume interactions;
- backgrounding;
- pronunciation;
- Ukrainian road names;
- cancellation;
- repeated taps.

---

# 21. CAMERA VISION — LATER PHASE

Camera-based visual confirmation is a future feature.

Architecture should support a provider interface now, but do not pretend production computer vision exists if it does not.

Future use cases may include:

- landmark/POI recognition;
- road sign recognition;
- visual confirmation of navigation context.

Do not block current product quality on this feature.

---

# 22. PRIVACY

Default posture:

- navigation computation stays local where practical;
- location should not be sent to an AI backend by default;
- AI backend receives navigation context only when needed and permitted;
- raw microphone audio is not stored by default;
- telemetry should avoid unnecessary personal data.

Audit every network call.

Document what leaves the device.

---

# 23. DEMO MODE

Demo Mode is useful for deterministic testing.

It must be visibly labeled.

It must not fake the production UI by bypassing the real engine architecture.

Demo data should feed production engines/providers wherever possible.

A demo route should never be mistaken for real navigation.

Audit visual differentiation and provider boundaries.

---

# 24. CURRENT REPOSITORY / DEBUGGING CONTEXT

Important known history:

- A minimal `TEST SCREEN` successfully rendered on the physical iPhone.
- That proved that the native app, Xcode toolchain, Hermes, Metro connection, and basic React rendering could work.
- The full app/navigation tree later stayed on the splash screen or failed during startup.
- Previous runtime errors included duplicate `RNCSafeAreaProvider` registration.
- The project previously had React Native version inconsistency involving `0.76.5` and `0.76.9`.
- It also had `react-native-safe-area-context` duplication involving `4.12.0` and `5.10.0`.
- A missing `@react-native/js-polyfills` module was previously encountered.
- CocoaPods/React Native pods were regenerated during debugging.
- DerivedData corruption was also encountered and cleared.
- Local-machine dependency state may be newer than what is committed on GitHub `main`.

Therefore:

**Do not assume `main` package versions describe the current local working tree. Inspect the actual checkout first.**

Do not reintroduce duplicate React Native or safe-area versions.

Do not perform a blind full reinstall before understanding the dependency graph.

First inspect:

- `git status`;
- `git diff`;
- `package.json` files;
- lockfile;
- `npm ls`;
- Podfile.lock;
- Expo Doctor;
- runtime logs;
- top-level import tree.

The current GitHub `main` has historically contained an `apps/mobile/package.json` with older versions, so version reconciliation must be deliberate.

---

# 25. LANGUAGE CONSTITUTION

All NAVIA-owned user-facing UI must be Ukrainian.

Audit every visible string in:

- home;
- search;
- navigation;
- settings;
- diagnostics;
- map controls;
- permissions explanation;
- alerts;
- errors;
- buttons;
- AI;
- voice;
- route instructions;
- empty states;
- loading states;
- shelter flow;
- offline flow;
- onboarding.

English is allowed in developer-only diagnostics where technically useful, but the user experience should not randomly mix languages.

Russian NAVIA-owned UI is not acceptable.

System iOS permission dialogs may follow the iPhone system language; that is outside NAVIA’s direct UI control.

Create a centralized localization strategy rather than scattering strings permanently across components.

---

# 26. PREMIUM UX TARGET

Study premium navigation products for interaction principles, not for copying.

Useful references:

- Apple Maps;
- Google Maps;
- Waze;
- HERE WeGo;
- modern OEM automotive navigation.

Extract principles such as:

- information hierarchy;
- map-first composition;
- glanceability;
- large primary actions;
- clear maneuver guidance;
- restrained visual noise;
- spatial consistency;
- confidence through stability;
- meaningful motion;
- predictable controls;
- one-hand reachability;
- readable driving typography.

Do not copy proprietary icons, branding, layouts pixel-for-pixel, or assets.

NAVIA needs its own visual language.

---

# 27. DESIGN SYSTEM — REQUIRED

Do not continue with arbitrary inline styles spread across screens.

Create a coherent design system.

At minimum define semantic tokens for:

- background;
- surface;
- elevated surface;
- border;
- primary text;
- secondary text;
- muted text;
- accent;
- success/GNSS healthy;
- warning/GNSS degraded;
- critical/GNSS lost;
- route line;
- map halo;
- focus/pressed;
- disabled.

Define typography tokens for:

- hero/display;
- navigation maneuver;
- screen title;
- section title;
- primary body;
- secondary body;
- caption;
- button;
- status chip;
- numeric navigation data.

Define spacing tokens.

Prefer a consistent 4/8 pt rhythm.

Define radii.

Define elevation/shadow policy.

Define icon sizes.

Define touch-target minimums.

Avoid “magic numbers” unless they are justified by safe-area/map behavior.

---

# 28. PIXEL-LEVEL AUDIT STANDARD

The owner explicitly asked for an audit of “every pixel.”

Interpret that as a systematic visual-quality review, not literally checking individual raster pixels.

For every screen and overlay, inspect:

## Alignment

- left edges align;
- card internal padding is consistent;
- labels align with icons;
- numerical values align predictably;
- floating controls share a grid;
- no 1–4 px accidental visual drift.

## Spacing

- consistent horizontal margins;
- consistent vertical rhythm;
- no crowded icon/text pairs;
- no random dead space;
- safe-area respected;
- bottom controls avoid home indicator.

## Typography

- no tiny eye-straining primary text;
- consistent font families;
- deliberate font weights;
- line height suitable for Cyrillic/Ukrainian;
- numbers readable at a glance;
- no accidental mixed text sizes;
- no unnecessary all-caps;
- truncation is intentional.

## Iconography

- consistent stroke/fill language;
- consistent optical size;
- primary icons visually stronger;
- secondary icons quieter;
- no mismatched third-party icon styles;
- no icon touching labels;
- correct hit slop.

## Cards and surfaces

- consistent radii;
- consistent opacity;
- map remains visible;
- overlays do not cover important map data unnecessarily;
- contrast remains sufficient over light/dark map areas;
- no arbitrary translucent rectangles stacked on each other.

## States

Every control must be reviewed in:

- default;
- pressed;
- selected;
- disabled;
- loading;
- success;
- warning;
- error;
- offline;
- permission denied.

## Responsive layout

Check:

- small iPhone;
- larger iPhone;
- different safe areas;
- long Ukrainian strings;
- larger text/accessibility settings where feasible;
- portrait orientation;
- keyboard open/closed.

## Overlap

No overlap between:

- compass;
- maneuver instruction;
- GNSS state;
- AI button;
- voice controls;
- zoom;
- recenter;
- route info;
- system safe areas;
- keyboard;
- bottom sheet.

Capture evidence where the environment supports screenshots.

---

# 29. MAP SCREEN — TARGET COMPOSITION

The map is the primary navigation surface.

It must not feel like “MapLibre plus random absolute-positioned cards.”

Recommended hierarchy:

## Top navigation instruction area

Contains:

- next maneuver icon/direction;
- distance to maneuver;
- road/street name;
- concise text.

It owns a dedicated zone.

It must never overlap the compass.

## GNSS / position integrity indicator

Compact but unmistakable.

Green / yellow / red state.

Tap may open a concise explanation/diagnostic sheet.

It must not blink per update.

## Compass

Dedicated map control.

Visible only when useful.

Correct north/heading behavior.

Never hidden under maneuver UI.

## Right-side control rail

Potential controls:

- recenter;
- zoom in;
- zoom out;
- orientation/compass if separate.

Large enough to use reliably.

Consistent spacing.

## Current position marker

Not a generic dot.

Use a NAVIA branded marker that communicates heading.

Potential layers:

- central NAVIA glyph;
- directional arrow/cone;
- confidence halo/accuracy circle.

Keep it readable at multiple zoom levels.

## Route

Route should be visually dominant over ordinary roads but not obscure the map.

Audit:

- line width across zoom;
- turn visibility;
- selected/active route vs alternatives;
- remaining vs traveled segment if supported;
- z-index relative to POIs.

## Bottom navigation area

Contains critical trip state:

- remaining distance;
- ETA;
- destination;
- confidence/position status if not shown above;
- stop/cancel/end route;
- AI/voice access.

Use one coherent component/bottom sheet, not unrelated floating cards.

---

# 30. MAP INTERACTIONS — MUST REALLY WORK

Test physically:

- pinch to zoom;
- zoom in button;
- zoom out button;
- pan;
- rotate if enabled;
- compass reset;
- recenter;
- follow mode;
- north-up;
- user breaks follow mode by dragging;
- user returns to follow mode;
- route remains visible;
- current position remains correct;
- overlays do not intercept map gestures accidentally.

A rendered map is not evidence that map interaction works.

Inspect pointer/touch interception.

---

# 31. HOME SCREEN

The home screen must answer quickly:

> “What can I do?”

Primary action:

`Куди їдемо?`

Potential supporting actions:

- recent destinations;
- home/work if later supported;
- `Знайти укриття`;
- AI navigator;
- offline map status/download;
- settings;
- diagnostics only if appropriate for dev builds.

Audit:

- visual hierarchy;
- primary CTA;
- whitespace;
- brand placement;
- no clutter;
- no tiny developer text;
- recent destination persistence;
- empty state;
- keyboard transition into search.

If diagnostics is developer-only, do not make it look like a primary consumer feature.

---

# 32. SEARCH SCREEN

Target behavior:

- autofocus where appropriate;
- large readable input;
- clear cancel/back;
- loading state;
- result list;
- Ukrainian address labels;
- locality context;
- recent history;
- no-result state;
- offline indicator;
- error state;
- destination confirmation.

Test:

- short query;
- long query;
- fast typing;
- network loss mid-search;
- keyboard covering results;
- result double-tap;
- back gesture;
- stale request race;
- duplicate results.

---

# 33. ACTIVE NAVIGATION SCREEN

This is the most important screen in the product.

Audit every millimeter and every state.

Driver must instantly understand:

1. where am I;
2. where am I going;
3. what do I do next;
4. how far until the maneuver;
5. how far until destination;
6. when will I arrive;
7. can NAVIA trust the current position.

Do not use tiny text for driving-critical information.

Do not show raw engineering terms unless the driver needs them.

For example, “GNSS: NORMAL” is less user-friendly than a clear visual state plus optional details.

The navigation screen must remain coherent during:

- healthy GPS;
- degraded GPS;
- lost GPS;
- dead reckoning;
- low confidence;
- off-route;
- rerouting;
- route provider failure;
- arrival;
- map interaction;
- voice activity;
- AI interaction.

---

# 34. GPS/CONFIDENCE UX

The owner wants a clear traffic-light model.

Suggested visible behavior:

## Healthy

Green icon/chip.

Possible short label:

`GPS стабільний`

## Degraded

Yellow.

Possible label:

`GPS нестабільний`

Optional explanation:

`Точність знижена. NAVIA перевіряє положення за датчиками та картою.`

## Lost / severe

Red.

Possible label:

`GPS втрачено`

If dead reckoning remains valid:

`Оцінюю положення за датчиками`

If confidence becomes too low:

`Положення невпевнене`

Do not spam alerts every second.

Announce meaningful transitions.

---

# 35. OFF-ROUTE AND REROUTING UX

Do not let the app silently reroute in a loop.

Required states:

- suspected deviation;
- confirmed off-route;
- rerouting;
- reroute success;
- reroute failure.

Use hysteresis.

Avoid one bad point causing reroute.

Keep the old route visible until a valid replacement exists when practical.

Test repeated provider failures.

---

# 36. ARRIVAL UX

Arrival must be explicit.

Stop unnecessary sensors/timers where appropriate.

Show:

- destination name;
- arrival state;
- end navigation;
- possibly route summary later.

Do not leave “turn in 0 m” indefinitely.

---

# 37. AI / VOICE UX

AI access must be obvious but not distract from driving.

The AI navigator icon should be premium and branded.

Potential behavior:

- tap opens compact voice/AI panel;
- current navigation context supplied automatically;
- microphone state is visible;
- listening/processing/speaking states distinct;
- if STT unavailable, show a clear state instead of fake listening.

Do not let the AI panel cover turn instructions or critical map controls.

---

# 38. SETTINGS AUDIT

Every visible setting must be real.

For each setting verify:

- default value;
- persistence;
- effect;
- disabled state;
- error behavior;
- language;
- explanation;
- interaction;
- reset behavior.

Potential settings areas may include:

- voice;
- units;
- map orientation;
- map downloads;
- privacy;
- AI;
- diagnostics;
- demo mode;
- accessibility.

Do not add decorative switches.

If a setting is future work, either hide it from consumer UI or label it honestly in a dev context.

---

# 39. DIAGNOSTICS

Diagnostics are essential for developing resilient navigation.

Expose enough to debug:

- raw GNSS;
- GNSS state;
- anomaly score;
- accuracy;
- fix age;
- speed;
- heading;
- trusted position;
- estimated position;
- confidence score and components;
- map match;
- off-route state;
- route state;
- sensor availability;
- last errors;
- provider health;
- offline package availability.

Developer diagnostics can use more technical language.

Do not leak diagnostics clutter into the driver UI.

---

# 40. PERFORMANCE — CURRENT LAG IS UNACCEPTABLE

Profile rather than guess.

Investigate:

- React rerender frequency;
- Zustand subscriptions;
- object identity churn;
- 10 Hz IMU propagation;
- map source/shape updates;
- route geometry recreation;
- expensive coordinate conversion;
- timers;
- repeated route requests;
- repeated geocoder requests;
- console logging;
- animations;
- voice effects;
- state updates during every sensor sample.

Measure before/after.

Possible architecture principle:

**High-frequency sensor data stays out of React whenever possible.**

React should receive a stable, throttled navigation snapshot appropriate for UI refresh.

Do not reduce required navigation fidelity merely to hide UI lag.

---

# 41. STARTUP AND CRASH AUDIT

Startup must be deterministic.

Known fact:

A minimal test screen has rendered successfully before.

Therefore a failure with the full app should be treated as an import/dependency/runtime-tree issue until evidence shows otherwise.

Audit top-level imports from:

- App;
- NavigationContainer;
- RootNavigator;
- all screens imported by RootNavigator;
- NavigationScreen;
- MapLibre;
- sensors;
- location;
- safe area;
- native stack/screens;
- speech;
- speech recognition;
- SQLite;
- any module with side effects at import time.

Look for:

- duplicate native module registration;
- incompatible native versions;
- module initialization exceptions;
- circular imports;
- missing peer dependencies;
- old Pod references;
- stale generated native project;
- Expo SDK incompatibility.

Use binary isolation if needed:

minimal App → navigation container → stack → Home → Search → Diagnostics → Navigation → providers one by one.

Do not modify ten variables simultaneously.

---

# 42. ERROR AND UNAVAILABLE STATES

Every external dependency requires a designed failure state.

Audit:

- no internet;
- geocoder timeout;
- routing timeout;
- malformed route;
- map style unavailable;
- map tiles unavailable;
- GPS permission denied;
- GPS disabled;
- sensors unavailable;
- GNSS degraded;
- GNSS lost;
- offline graph missing;
- offline geocoder missing;
- POI database missing;
- shelter source missing;
- AI backend missing;
- speech unavailable;
- STT unavailable.

Failure state design must answer:

- what happened;
- what still works;
- what the user can do;
- whether retry is appropriate.

---

# 43. ACCESSIBILITY AND DRIVING USABILITY

Audit:

- minimum touch target;
- contrast;
- color is not the only signal where possible;
- dynamic text where feasible;
- VoiceOver labels;
- icon accessibility labels;
- landscape assumptions if unsupported;
- one-hand reach;
- driving glance time;
- motion reduction;
- low-light readability.

Red/yellow/green GNSS status should also have icon/label semantics so color-blind users are not dependent solely on hue.

---

# 44. UKRAINIAN COPY AUDIT

Do a full string inventory.

Fix:

- Russian;
- accidental English;
- inconsistent capitalization;
- machine-like wording;
- inconsistent GPS/GNSS terminology;
- inconsistent “маршрут/навігація” labels;
- awkward translations.

Prefer concise Ukrainian suitable for driving.

Do not make important instructions verbose.

---

# 45. FULL FUNCTIONAL AUDIT — BUTTON BY BUTTON

Create a real interaction inventory from the actual code.

For every button, chip, card, row, icon, gesture, menu item, switch, search result, map control, and CTA record:

- visible label/icon;
- screen;
- state prerequisites;
- handler;
- expected behavior;
- actual behavior;
- loading feedback;
- success feedback;
- failure feedback;
- disabled behavior;
- persistence if relevant;
- test result;
- device verification status.

No orphan controls.

No button should exist without a verified behavior.

---

# 46. FULL SCREEN INVENTORY

Do not assume only currently obvious screens matter.

Generate a complete screen/navigation inventory from source.

For every screen:

- purpose;
- entry path;
- exit path;
- required data;
- loading;
- empty;
- error;
- offline;
- permission state;
- visual audit;
- interaction audit;
- accessibility audit;
- localization audit;
- performance audit.

Remove accidental dead screens only after confirming they are not needed.

---

# 47. TEST MATRIX — MINIMUM

## Startup

- cold launch;
- warm launch;
- Metro reload;
- app background/foreground;
- device locked/unlocked;
- denied permissions;
- native module initialization.

## Home

- primary CTA;
- recent destinations;
- empty recent list;
- shelter CTA;
- AI entry;
- settings;
- diagnostics/dev entry.

## Search

- normal query;
- Ukrainian characters;
- no results;
- slow network;
- no network;
- repeated search;
- result selection;
- keyboard;
- back.

## Map

- pan;
- pinch zoom;
- zoom buttons;
- rotate;
- compass;
- recenter;
- follow mode;
- route bounds;
- marker heading;
- overlay conflicts.

## Routing

- current location to destination;
- route request;
- valid geometry;
- ETA;
- maneuver sequence;
- reroute;
- route failure;
- malformed response;
- arrival.

## GNSS

- healthy;
- degraded accuracy;
- jump anomaly;
- stale fix;
- heading anomaly;
- road mismatch;
- intermittent fix;
- complete loss;
- dead reckoning;
- long loss;
- recovery;
- hysteresis.

## Map matching

- normal road;
- intersection;
- parallel road;
- overpass;
- off-route;
- ambiguous candidates.

## Sensor fusion

- stationary;
- walking/vehicle-like motion;
- turning;
- no magnetometer;
- no gyro;
- high-frequency updates.

## Shelter

- list/source available;
- select;
- map marker;
- route;
- no shelter data;
- offline;
- source error.

## POI / landmarks

- nearby POI;
- multiple similar POIs;
- landmark confirmation;
- unconfirmed landmark;
- route-side reasoning.

## AI

- next turn;
- GPS status;
- confidence;
- POI confirmation;
- insufficient evidence;
- AI backend unavailable;
- no location leakage beyond policy.

## Voice

- TTS;
- repeated instruction suppression;
- voice failure;
- microphone unavailable;
- STT if implemented;
- Ukrainian language.

## Offline

- map available;
- map unavailable;
- route graph available;
- graph unavailable;
- geocoder available;
- geocoder unavailable;
- mixed availability.

## UI

- small iPhone;
- larger iPhone;
- safe areas;
- long Ukrainian strings;
- every control;
- every overlay;
- every modal;
- error banners;
- loading.

## Performance

- navigation running for extended period;
- map interaction during updates;
- sensor stream;
- rerender profile;
- memory;
- timer cleanup;
- leaving/re-entering navigation.

---

# 48. AUTOMATED TEST REQUIREMENTS

Maintain and expand deterministic core tests.

At minimum cover:

- GNSS anomaly scoring;
- GNSS hysteresis;
- trusted-position acceptance/rejection;
- dead reckoning;
- confidence bands;
- map-match ambiguity;
- off-route hysteresis;
- reroute state;
- recovery;
- route progress;
- arrival;
- AI non-hallucination contract;
- provider failures.

Tests must assert behavior, not implementation trivia.

Where practical, add component/integration tests for UI states.

Do not delete tests just to get green.

---

# 49. PHYSICAL DEVICE VERIFICATION

A simulator is insufficient for all navigation behaviors.

When a physical iPhone is available, verify at least:

- app launch;
- location permission;
- live location;
- map gesture behavior;
- sensor availability;
- current-position marker;
- route rendering;
- TTS;
- crash-free screen transitions;
- responsiveness.

If Codex cannot physically interact with the device, it must state exactly which steps require the owner.

Do not claim “verified on device” unless actual device evidence exists.

---

# 50. BUILD QUALITY GATES

Before declaring a milestone complete, run the relevant gates:

- install state/dependency audit;
- TypeScript;
- unit tests;
- lint if configured;
- Expo Doctor;
- iOS prebuild only when justified;
- CocoaPods only when native dependency state changes;
- Xcode/iOS build;
- Metro bundle;
- runtime launch;
- manual functional pass.

Do not regenerate the native project unnecessarily.

Do not run destructive package upgrades without understanding Expo compatibility.

Do not use `npm audit fix --force` blindly.

---

# 51. GIT DISCIPLINE

Before edits:

- inspect `git status`;
- preserve uncommitted work;
- understand local-vs-GitHub drift.

During work:

- make logical commits;
- keep commits focused;
- include tests with behavior changes;
- do not mix a huge dependency upgrade with unrelated UI work if avoidable.

Do not overwrite working fixes from the owner’s local environment.

---

# 52. VISUAL ACCEPTANCE CHECKLIST

For each major screen, perform a visual review at 100% scale.

Ask:

- Is there one obvious primary action?
- Can I identify the information hierarchy in two seconds?
- Are important items large enough?
- Are unrelated controls visually competing?
- Does anything look randomly positioned?
- Are edges aligned?
- Are margins consistent?
- Are cards overused?
- Are shadows/elevation consistent?
- Does the map remain the main surface?
- Is the route visually dominant enough?
- Is the current position marker recognizable?
- Are colors semantic rather than decorative?
- Does the screen feel calm while driving?
- Does it look like one product rather than components from different templates?
- Does the NAVIA brand show up in a restrained way?
- Is any text too small?
- Does any UI overlap at a realistic device size?
- Does every icon have a clear purpose?
- Does the UI still look good when GPS turns yellow/red?
- Does an error state still look deliberate?

If the answer to any is no, do not call the screen complete.

---

# 53. PREMIUM DOES NOT MEAN “MORE DECORATION”

Do not solve “premium” by adding gradients, glass everywhere, excessive blur, neon, animations, or more cards.

Premium here means:

- hierarchy;
- restraint;
- consistency;
- accuracy;
- responsiveness;
- clarity;
- confidence;
- coherent motion;
- strong typography;
- disciplined spacing;
- excellent failure states.

The map must remain usable.

---

# 54. CURRENT POSITION MARKER — BRAND REQUIREMENT

Replace the generic point with a NAVIA-specific location marker.

Requirements:

- recognizable at a glance;
- heading direction;
- centered precisely on map coordinate;
- optical size consistent across zoom;
- optional accuracy/confidence halo;
- does not obscure nearby roads;
- does not jitter visually with raw GNSS noise;
- reacts correctly to map bearing;
- smooth but not misleading animation.

Test:

- stationary;
- moving;
- turning;
- GNSS degraded;
- dead reckoning;
- recovery.

---

# 55. MAP ZOOM REQUIREMENT

The owner specifically complained that the map cannot be properly enlarged/reduced.

Therefore this is a release-blocking interaction bug until proven fixed.

Verify:

- pinch gesture;
- button zoom in;
- button zoom out;
- map min/max zoom;
- gesture enable flags;
- overlays not intercepting touches;
- camera state not immediately overriding user zoom;
- follow mode behavior after manual zoom.

A common failure is constantly resetting the camera from state updates.

Audit that carefully.

---

# 56. COMPASS VS MANEUVER OVERLAP — RELEASE BLOCKER

The owner explicitly observed the compass being covered by the “turn right” instruction.

Fix the layout architecture, not merely one top offset.

Account for:

- safe-area inset;
- dynamic maneuver card height;
- long road names;
- status banner;
- demo banner;
- different iPhone widths;
- dynamic text.

The compass must occupy a reserved control zone or use collision-aware layout.

---

# 57. ROUTE QUALITY — RELEASE BLOCKER

The owner reported routes that appear constructed “just somehow.”

Investigate whether the issue comes from:

- demo provider;
- wrong origin;
- wrong destination;
- coordinate order;
- route response decoding;
- hand-authored demo graph;
- provider config;
- line rendering;
- route snapping;
- map projection;
- stale route state.

Never visually beautify a wrong route.

Fix the route source/logic first.

---

# 58. CRASHES — RELEASE BLOCKER

Any reproducible crash in ordinary flows blocks release.

For each crash:

- reproduction steps;
- stack trace;
- root cause;
- fix;
- regression test;
- device/build verification.

Do not suppress exceptions globally.

Do not wrap everything in catch blocks that hide broken behavior.

---

# 59. OBSERVABILITY

Add development-only structured diagnostics where useful.

Events may include:

- GNSS state transition;
- trusted fix accepted/rejected;
- confidence band change;
- dead reckoning start/stop;
- map match change;
- off-route detected;
- reroute started/succeeded/failed;
- provider errors;
- route arrival.

Avoid sensitive data in production logs.

Make it possible to understand why NAVIA changed state.

---

# 60. PRODUCT COPY — CALM, NOT ALARMIST

Even when GPS is degraded, UI should be calm.

Avoid sensational copy.

Prefer:

`GPS нестабільний`

over dramatic language.

Prefer:

`Положення уточнюється`

when appropriate.

The app should increase trust through honesty, not fear.

---

# 61. NAVIA BRAND DIRECTION

Preserve the successful parts the owner already likes:

- logo direction;
- icon craftsmanship;
- dark technological identity.

Improve the rest of the application until the entire product reaches the same level.

Brand should feel:

- modern;
- precise;
- Ukrainian;
- technical but human;
- robust;
- premium.

Avoid:

- gamer aesthetic;
- military cosplay;
- cyberpunk clutter;
- generic dashboard UI;
- cheap neon;
- random gradients.

---

# 62. OWNER QUALITY STANDARD

The owner’s complaint should be translated into an engineering principle:

> “Do not hand me something that merely looks implemented. Verify it several times before showing it.”

Therefore, for significant features:

1. implement;
2. build;
3. run;
4. test;
5. observe defects;
6. fix;
7. rebuild;
8. retest;
9. record evidence.

One successful run is not enough for flaky behavior.

---

# 63. DEFINITION OF DONE — FEATURE LEVEL

A feature is only “done” when:

- implementation exists;
- types compile;
- tests cover meaningful behavior where feasible;
- runtime behavior was executed;
- loading/error states work;
- Ukrainian copy is correct;
- visual state is consistent with design system;
- accessibility basics are present;
- failure mode is honest;
- no obvious regression was introduced;
- device verification status is explicitly recorded.

If device verification was impossible, status is:

**Implemented, not device-verified.**

Not:

**Done.**

---

# 64. DEFINITION OF DONE — NAVIA MVP FOUNDATION

The product foundation should not be called ready until it can demonstrate, honestly:

- installable mobile app;
- stable startup;
- real location;
- real Kyiv/Kyiv Oblast destination;
- real route;
- route display;
- map gestures;
- current-position branded marker;
- Ukrainian UI;
- Ukrainian TTS;
- GNSS good/degraded/lost;
- trusted position;
- dead reckoning;
- confidence;
- map matching;
- recovery;
- off-route/reroute;
- offline map region;
- offline capability status that is truthful;
- saved/recent route behavior where intended;
- POI/landmark context;
- shelter routing if data/provider is available;
- AI that does not hallucinate navigation facts;
- diagnostics;
- deterministic core tests;
- iOS build;
- Android build path when environment becomes available.

---

# 65. CODEX EXECUTION PROTOCOL

## Phase 1 — Baseline and truth

Do not edit first.

Inspect:

- git status/diff;
- actual package versions;
- lockfile;
- Pods;
- Expo config;
- current native build state;
- tests;
- app navigation tree;
- all screens;
- providers;
- engine boundaries.

Produce an internal audit map.

## Phase 2 — Reproduce

Reproduce the highest-impact failures:

1. startup/crash;
2. map interaction;
3. route quality;
4. GNSS indicator;
5. overlap/layout;
6. lag.

Do not fix what cannot be reproduced without at least establishing a credible root cause.

## Phase 3 — Stabilize foundation

Fix:

- startup;
- dependency conflicts;
- runtime crashes;
- state cleanup;
- provider failures.

Do not redesign on top of a crashing app.

## Phase 4 — Navigation correctness

Fix:

- real route chain;
- position;
- GNSS integrity;
- confidence;
- map matching;
- off-route;
- recovery.

## Phase 5 — Map interaction

Fix:

- pinch/pan/zoom;
- camera behavior;
- current marker;
- compass;
- recenter;
- overlay collision.

## Phase 6 — UX/design system

Create a coherent design system and restructure screens.

Do not merely restyle existing absolute-position chaos.

## Phase 7 — Shelters / POI / AI / voice

Integrate honestly according to available real data/providers.

## Phase 8 — Performance

Profile and remove lag.

## Phase 9 — Full regression

Execute the full matrix.

## Phase 10 — Final evidence report

Report only what is true.

---

# 66. REQUIRED FINAL REPORT FORMAT

The final report must include:

## Executive summary

What materially improved.

## Bugs found

For each important bug:

- symptom;
- root cause;
- fix;
- verification.

## Architecture changes

Why they were needed.

## GNSS changes

- algorithm;
- hysteresis;
- UI mapping;
- test evidence.

## Routing changes

- provider;
- correctness;
- failure handling;
- rerouting.

## Map changes

- gestures;
- camera;
- marker;
- compass;
- overlays.

## UI/UX changes

- design system;
- typography;
- layout;
- icon hierarchy;
- language.

## Shelter flow

What is real, what source is used, what remains blocked.

## AI/voice

What is implemented vs stubbed.

## Performance

Measured issues and improvements.

## Test results

Clearly separate:

- automated;
- simulator;
- physical device;
- untested.

## Build results

Exact build status.

## Remaining blockers

No vague wording.

## Git summary

Commits/files changed.

---

# 67. STATUS LABELS — USE THESE PRECISELY

For all final reporting, classify features as:

- **IMPLEMENTED** — code exists.
- **AUTOMATED-TESTED** — deterministic automated test passed.
- **RUNTIME-TESTED** — executed in running app.
- **DEVICE-VERIFIED** — verified on physical device.
- **BLOCKED** — cannot proceed because of a real dependency.
- **NOT IMPLEMENTED** — absent.
- **PARTIAL** — some behavior exists but does not meet the product requirement.

Never use “done” to hide the distinction.

---

# 68. THINGS CODEX MUST NOT DO

Do not:

- rebuild the project from scratch unnecessarily;
- throw away the existing engine architecture;
- replace functionality with pretty mock UI;
- hardcode routes;
- hardcode fake Kyiv data as production behavior;
- fake GPS status;
- fake offline readiness;
- hide errors;
- claim tests that were not run;
- copy Apple/Google/Waze proprietary visuals;
- change product language to Russian;
- flood the UI with diagnostics;
- run destructive dependency upgrades without need;
- use forceful audit fixes blindly;
- remove tests to make CI pass;
- make navigation math live in React screens;
- send precise user location to AI by default;
- turn air-alert data into unsupported “safe route” claims.

---

# 69. THINGS CODEX SHOULD PROACTIVELY DO

Do:

- question weak assumptions;
- inspect the actual runtime;
- add missing tests;
- centralize design tokens;
- centralize localization;
- create reusable controls;
- document provider availability;
- add clear error states;
- add diagnostic reasons for GNSS transitions;
- keep high-frequency data out of React where possible;
- validate route responses;
- preserve stable code before refactoring;
- test every visible control;
- audit every string;
- audit every overlay;
- review every screen at pixel-level alignment.

---

# 70. FINAL OWNER MESSAGE

Treat NAVIA as something that may eventually be used by a real person in a stressful, imperfect navigation environment.

That person should not need to understand sensor fusion, anomaly scores, MapLibre, Valhalla, GNSS integrity, React Native, or providers.

They need the application to tell them, clearly and truthfully:

- where they are;
- where they are going;
- what to do next;
- whether the position can be trusted;
- what NAVIA is doing when GPS becomes unreliable.

Everything else — architecture, AI, sensor fusion, dead reckoning, offline data, diagnostics — exists to make those answers more reliable.

The product must feel premium not because it is decorative, but because it is disciplined.

Every function must be real or honestly unavailable.

Every important state must be tested.

Every button must have a purpose.

Every overlay must have a place.

Every font size must be deliberate.

Every icon must belong to the same system.

Every pixel must look intentional.

And NAVIA must never be more confident than the evidence allows.

---

# 71. STARTING COMMAND TO CODEX

After reading this file, begin with this exact intent:

> Request the permissions you genuinely need, inspect the current working tree without changing anything, build a complete product/technical/visual audit against this constitution, identify the highest-risk failures, and then execute the work autonomously in verified stages. Do not stop at compilation. Do not claim success without runtime evidence.
