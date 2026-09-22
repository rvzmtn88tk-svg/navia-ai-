# NAVIA — MASTER BUILD INSTRUCTION FOR CLAUDE CODE

## Роль

Ты — lead engineer, systems architect, mobile/navigation engineer и QA-инженер проекта NAVIA.

Не создавай концепт, презентацию, красивый mockup или «симулятор интерфейса».
Создай РАБОТАЮЩЕЕ мобильное приложение, которое можно собрать и установить на реальный iPhone/Android и проверить в автомобиле.

Главная цель первой версии:
**реальная навигация + реальная геолокация + карта Киева и Киевской области + голосовой штурман + обнаружение деградации GNSS + продолжение навигации при потере GNSS + map matching + landmarks + offline package + AI context.**

Принцип:
> AI не заменяет navigation engine. AI объясняет фактическое состояние navigation engine человеку.

---

# 0. ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА РАБОТЫ

1. Не переписывай проект в виде статического UI.
2. Не используй fake `97% confidence`, если это не рассчитано реальными входными данными.
3. Не называй mock-функцию «real».
4. Не используй hardcoded Kyiv route вместо реальной маршрутизации, кроме Demo Mode.
5. Все основные функции должны иметь:
   - production implementation;
   - demo fallback;
   - unit tests;
   - явное состояние unavailable/error.
6. Если функция невозможна на web, реализуй её в native mobile layer.
7. Не хранить API keys в мобильном клиенте.
8. AI никогда не имеет права самостоятельно придумывать координаты, дороги, POI, повороты или состояние GNSS.
9. При низкой confidence NAVIA обязана говорить об неопределённости.
10. Не считать один плохой GPS fix доказательством spoofing/jamming. Использовать термин `GNSS_DEGRADED`, `GNSS_LOST` или `POSITION_UNCERTAIN`.
11. Не утверждать, что маршрут безопасен во время воздушной тревоги. Air-raid layer только информирует о полученном статусе/времени/источнике.
12. Код должен быть типизирован TypeScript.
13. После каждой значимой стадии запускать lint, typecheck, tests и build.
14. Если сборка сломана — сначала исправить, потом переходить дальше.
15. Не останавливаться после создания UI. Работа считается законченной только после прохождения acceptance tests.

---

# 1. ПРОДУКТОВАЯ СУТЬ

NAVIA — не «ещё один Google Maps».

NAVIA — resilient navigation / AI co-pilot.

Проблема:
обычная навигация сильно зависит от корректного GNSS и сети. При деградации GNSS пользователь может увидеть неправильное положение, неправильный съезд или потерять навигационный контекст.

NAVIA должна:

A. Понимать качество позиционирования.
B. Сохранять последнюю доверенную позицию.
C. Продолжать оценивать движение при потере GNSS.
D. Сопоставлять оценённую позицию с дорожным графом.
E. Не давать ложную уверенность.
F. Объяснять пользователю ситуацию голосом.
G. Использовать ориентиры.
H. Работать с offline map package.
I. Иметь реальный адресный поиск.
J. Позволять пользователю спросить:
   - «Я на правильной дороге?»
   - «Где следующий поворот?»
   - «Я вижу WOG — это та заправка?»
   - «Что с GPS?»
   - «Сколько до поворота?»
   - «Я уже съехал с маршрута?»
K. В будущем использовать камеру для распознавания ориентиров.

---

# 2. TARGET PLATFORM

Сделать production-oriented mobile app:

- React Native + TypeScript
- Expo Development Build / EAS Build, НЕ Expo Go
- MapLibre React Native для карты
- expo-location для GPS
- expo-sensors для accelerometer/gyroscope/magnetometer
- SQLite для локальных данных
- Zustand или Redux Toolkit для state
- React Navigation
- native speech / TTS abstraction
- background location architecture
- secure storage

MapLibre требует native build; приложение должно быть настроено именно как native development build.

Создать:
- Android APK/AAB build configuration
- iOS build configuration
- README с точными командами сборки
- `.env.example`
- `eas.json`
- `app.json`/`app.config.ts`

---

# 3. РЕПОЗИТОРИЙ

Создай структуру:

apps/
  mobile/
packages/
  core/
  navigation/
  maps/
  voice/
  ai/
  storage/
  sensors/
  alerts/
  landmarks/
scripts/
  data/
  build/
tests/
docs/

Core должен быть максимально platform-independent.

---

# 4. ОСНОВНЫЕ МОДУЛИ

Обязательно создать:

NavigationEngine
PositionEngine
GNSSMonitor
SensorFusionEngine
DeadReckoningEngine
MapMatcher
RouteEngine
RouteProgressEngine
LandmarkEngine
ConfidenceEngine
OffRouteDetector
RecoveryEngine
AIEngine
VoiceEngine
AirAlertLayer
OfflineMapManager
OfflineRoutingEngine
OfflineGeocoder
POIEngine
CameraVisionEngine
DemoEngine
TelemetryLogger
DiagnosticsEngine

---

# 5. TYPESCRIPT DOMAIN TYPES

Создать отдельные типы:

```ts
export type LatLon = {
  lat: number;
  lon: number;
};

export type TimestampMs = number;

export type Position = LatLon & {
  timestamp: TimestampMs;
  accuracyM: number | null;
  altitudeM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  source: "GNSS" | "DEAD_RECKONING" | "MAP_MATCH" | "FUSED";
};

export type GNSSSample = {
  position: LatLon;
  timestamp: TimestampMs;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
};

export type IMUSample = {
  timestamp: TimestampMs;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  magneticX?: number;
  magneticY?: number;
  magneticZ?: number;
};

export type GNSSIntegrityState =
  | "NORMAL"
  | "DEGRADED"
  | "LOST";

export type NavigationMode =
  | "IDLE"
  | "ROUTING"
  | "ACTIVE"
  | "GNSS_DEGRADED"
  | "GNSS_LOST"
  | "POSITION_UNCERTAIN"
  | "OFFLINE"
  | "OFF_ROUTE"
  | "RECOVERING"
  | "ARRIVED";

export type ConfidenceBand =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export type PositionEstimate = {
  position: Position;
  covariance?: number[][];
  confidence: number; // 0..1
  band: ConfidenceBand;
  source: Position["source"];
};

export type RoadSegment = {
  id: string;
  geometry: LatLon[];
  name?: string;
  ref?: string;
  roadClass?: string;
  speedLimitKph?: number;
  oneWay?: boolean;
};

export type RouteStep = {
  id: string;
  roadName: string;
  maneuver:
    | "depart"
    | "straight"
    | "left"
    | "right"
    | "uturn"
    | "roundabout"
    | "arrive";
  distanceM: number;
  durationS: number;
  location: LatLon;
  bearingBefore?: number;
  bearingAfter?: number;
  roadSegmentId?: string;
};

export type Landmark = {
  id: string;
  name: string;
  type: string;
  location: LatLon;
  sideOfRoad?: "left" | "right" | "ahead";
  distanceM: number;
  routeRelevance: number;
  brand?: string;
};

export type NavigationState = {
  mode: NavigationMode;
  position: PositionEstimate | null;
  trustedPosition: PositionEstimate | null;
  gnss: GNSSIntegrityState;
  confidence: number;
  confidenceBand: ConfidenceBand;
  speedMps: number | null;
  headingDeg: number | null;
  routeProgressM: number;
  routeRemainingM: number;
  nextStep: RouteStep | null;
  nearbyLandmarks: Landmark[];
  offRoute: boolean;
  networkAvailable: boolean;
  offlineMapAvailable: boolean;
  lastTrustedFixAt: TimestampMs | null;
  updatedAt: TimestampMs;
};
```

---

# 6. GNSS MONITOR

Не просто читать GPS.

Создать `GNSSMonitor`.

Проверять:

1. accuracy;
2. timestamp freshness;
3. jump distance;
4. implied speed;
5. heading discontinuity;
6. consistency with current speed;
7. consistency with road graph;
8. consistency with fused position;
9. consistency with previous trusted position.

Формула implied speed:

```ts
impliedSpeed = distanceMeters(previous, current) / deltaTimeSeconds;
```

Пример anomaly features:

```ts
jumpScore
speedScore
headingScore
roadMismatchScore
staleFixScore
```

И:

```ts
anomalyScore =
  0.30 * jumpScore +
  0.25 * speedScore +
  0.15 * headingScore +
  0.20 * roadMismatchScore +
  0.10 * staleFixScore;
```

Не использовать один threshold как абсолютную истину.
Thresholds вынести в config.

---

# 7. TRUSTED POSITION

Хранить последнюю позицию:

`trustedPosition`.

Обновлять её только когда:

- accuracy достаточно хорошая;
- anomalyScore ниже threshold;
- position compatible with route;
- timestamp актуален.

При плохом fix НЕ заменять trustedPosition плохой координатой.

---

# 8. DEAD RECKONING

Минимальная модель:

```text
distance = speed * dt
```

Проецировать позицию:

```ts
next = destinationPoint(
  trustedPosition,
  heading,
  distance
);
```

Но production architecture должна поддерживать:

- gyro yaw rate;
- accelerometer;
- magnetometer;
- GPS speed;
- GPS heading;
- vehicle speed provider;
- bias estimation.

Создать интерфейс:

```ts
interface MotionProvider {
  getLatestMotion(): IMUSample | null;
}
```

и:

```ts
interface SpeedProvider {
  getSpeedMps(): number | null;
}
```

---

# 9. SENSOR FUSION

Не делать «магический AI».

Создать SensorFusionEngine.

Первая версия:
- weighted fusion;
- quality-aware weighting.

Следующая версия:
- Extended Kalman Filter.

State vector:

```text
[x, y, vx, vy, heading, gyroBias]
```

Measurement:
- GNSS position;
- GNSS velocity;
- IMU acceleration;
- gyro heading/rate.

Вынести EKF в отдельный класс.

Нужны unit tests на:
- stationary;
- constant velocity;
- turning;
- GPS outage.

---

# 10. MAP MATCHING

Это критически важный модуль.

Для estimated position найти несколько ближайших road candidates.

Для каждого:

```text
distanceToRoad
headingDifference
routeContinuity
speedCompatibility
```

Score:

```ts
score =
  wDistance * normalizedDistance +
  wHeading * normalizedHeadingDifference +
  wContinuity * continuityPenalty +
  wSpeed * speedPenalty;
```

Выбирать лучший candidate только если:

```text
bestScore + margin < secondBestScore
```

Иначе:

`POSITION_UNCERTAIN`.

Map matcher не должен «притягивать» пользователя к дороге только потому, что дорога ближайшая.

---

# 11. ROUTING

Использовать Valhalla как основной routing engine.

Почему:
- OSM;
- open source;
- map matching;
- manoeuvres;
- tiled graph;
- offline-oriented architecture.

Создать abstraction:

```ts
interface RoutingProvider {
  route(request: RouteRequest): Promise<Route>;
  match(points: LatLon[]): Promise<MapMatchResult>;
  searchAlternatives(request: RouteRequest): Promise<Route[]>;
}
```

Providers:

```text
OnlineValhallaProvider
OfflineValhallaProvider
DemoRoutingProvider
```

Online provider — HTTP backend.

Offline provider — локальный regional graph.

НЕ завязывать UI на конкретный routing engine.

---

# 12. OFFLINE ROUTING

Нужен реальный offline package для Kyiv + Kyiv Oblast.

Создать data pipeline:

```text
OSM PBF
 ↓
clip Kyiv + Kyiv Oblast
 ↓
build routing graph
 ↓
build address index
 ↓
build POI index
 ↓
build vector map tiles
 ↓
package
 ↓
download/import into app
```

Использовать Valhalla tiles / regional graph там, где это возможно.

Для production data builder должен генерировать:

```text
offline/
  maps/
  routing/
  geocoder/
  poi/
  metadata.json
```

`metadata.json` должен содержать:
- bbox;
- OSM source date;
- data version;
- graph version;
- map version;
- POI version;
- checksum;
- size.

Приложение должно показывать:

`Київ + область — офлайн пакет — готовий`

а не просто рисовать «100%».

---

# 13. MAP

MapLibre Native.

Функции:

- current position;
- accuracy circle;
- heading arrow;
- route polyline;
- road names;
- POI;
- landmarks;
- next maneuver;
- map rotation;
- follow mode;
- north-up mode;
- offline region;
- dark navigation style;
- user location;
- route deviation.

Создать map theme NAVIA.

---

# 14. ADDRESS SEARCH

Нужен настоящий поиск.

Online:
- geocoding backend.

Offline:
- SQLite FTS index.

Search supports:

```text
вулиця
будинок
місто
село
смт
район
```

Examples:

```text
Київ, вул. Хрещатик, 1
Боярка, вул. ...
Ірпінь, вул. ...
Бровари, вул. ...
```

Не hardcode 3 адреса.

---

# 15. POI / LANDMARK ENGINE

Создать POI database.

Categories:

- fuel;
- supermarket;
- pharmacy;
- hospital;
- bridge;
- railway crossing;
- major intersection;
- shopping centre;
- school;
- church;
- parking;
- government building;
- recognizable landmark.

Landmark scoring:

```text
relevance =
  routeProximity
  + maneuverProximity
  + visibility
  + semanticImportance
  + sideOfRoadMatch
```

Example:

User:
> «Я бачу WOG. Це моя заправка?»

NAVIA must calculate:
- current estimated position;
- candidate WOG POIs;
- distance;
- bearing;
- side of road;
- route compatibility;
- next maneuver.

Answer only if data supports it.

Example:

> «Так, найближчий WOG на вашому маршруті приблизно за 180 метрів. Після нього — праворуч.»

If uncertain:

> «Є два WOG поблизу. Я не можу надійно визначити, який саме ви бачите.»

---

# 16. AI SHUTTLEMAN / NAVIA AI

AI is a conversational interface over structured navigation data.

Create:

```ts
interface NavigationContext {
  state: NavigationState;
  route: Route | null;
  nearbyLandmarks: Landmark[];
  nearbyPOI: POI[];
  recentEvents: NavigationEvent[];
}
```

Tools available to AI:

```text
getNavigationState()
getPositionConfidence()
getGNSSState()
getNextTurn()
getRouteProgress()
getNearbyLandmarks()
searchNearbyPOI()
getCurrentRoad()
getDestination()
getOffRouteStatus()
getLastTrustedPosition()
```

LLM must never receive a raw prompt saying:
«guess where the user is».

It receives structured facts.

System policy for NAVIA AI:

```text
Never invent coordinates.
Never invent roads.
Never invent POIs.
Never claim GPS is healthy without data.
Never claim a landmark is confirmed without POI/vision evidence.
Never claim a route is safe.
If confidence is low, say so.
If two interpretations are plausible, say so.
```

---

# 17. VOICE

Voice is a first-class feature.

Input:
- speech recognition.

Output:
- Ukrainian TTS.

Commands:

```text
«Проклади маршрут до Боярки»
«Де наступний поворот?»
«Скільки до повороту?»
«Я на правильній дорозі?»
«Що з GPS?»
«Я бачу WOG — це вона?»
«Покажи маршрут»
«Повтори»
```

NAVIA should speak concise driver-safe responses.

Do not generate long paragraphs while driving.

---

# 18. CAMERA VISION

Implement architecture now even if production CV model is phase 2.

Interface:

```ts
interface VisionProvider {
  analyzeFrame(frame: CameraFrame): Promise<VisionDetection[]>;
}

type VisionDetection = {
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
};
```

Phase 1:
- simulated detections in Demo Mode.

Phase 2:
- on-device ML model.

Phase 3:
- landmark matching.

Example:

Camera detects:
`WOG confidence 0.93`

LandmarkEngine combines that with map data.

Only then NAVIA can say:

> «Так, це WOG, яку я бачу на маршруті.»

---

# 19. AIR-RAID INFORMATION LAYER

This is INFORMATIONAL ONLY.

Do not calculate «safe routes».
Do not advise tactical movement.
Do not infer threat direction.

Data model:

```ts
type AirAlertStatus = {
  active: boolean;
  region?: string;
  startedAt?: number;
  updatedAt?: number;
  source?: string;
};
```

UI:

```text
⚠ Інформаційний статус
Київська область
Оновлено: 14:32
Джерело: ...
```

During active alert, navigation continues, but app clearly separates:
- route information;
- alert information.

No claim:
`«Цей маршрут безпечний»`.

---

# 20. CONFIDENCE ENGINE

Confidence must be calculated.

Inputs:

```text
GNSS accuracy
GNSS freshness
GNSS anomaly score
sensor agreement
map-match score
route consistency
time since trusted fix
speed consistency
heading consistency
```

Example:

```ts
confidence =
  wGnss * gnssQuality +
  wFreshness * freshness +
  wSensor * sensorAgreement +
  wMap * mapMatchQuality +
  wRoute * routeConsistency;
```

Normalize to 0..1.

Bands:

```text
0.75–1.00 HIGH
0.50–0.74 MEDIUM
0.25–0.49 LOW
0.00–0.24 UNKNOWN
```

Thresholds configurable.

UI should show the USER meaning, not engineering noise.

HIGH:
`Позиція підтверджена`

MEDIUM:
`Позиція уточнюється`

LOW:
`Позиція неточна`

UNKNOWN:
`Не можу надійно визначити позицію`

---

# 21. STATE MACHINE

Implement deterministic state machine:

```text
IDLE
  ↓
ROUTING
  ↓
ACTIVE
  ↓
GNSS_DEGRADED
  ↓
GNSS_LOST
  ↓
POSITION_UNCERTAIN
  ↓
GNSS_RECOVERED
  ↓
ACTIVE
```

Also:

```text
ACTIVE -> OFF_ROUTE
OFF_ROUTE -> ROUTING
ACTIVE -> ARRIVED
```

Use hysteresis.

Do not switch state on one noisy sample.

---

# 22. OFF-ROUTE

Detect:

- distance from route corridor;
- map-matched road mismatch;
- heading mismatch;
- sustained deviation.

Use a timer/hysteresis.

Example:
do not say «you left the route» after a single 10m deviation.

When confirmed:

> «Ви відхилилися від маршруту. Перераховую.»

Then reroute.

---

# 23. ROUTE PROGRESS

Calculate:

```text
distance completed
distance remaining
ETA
current road
next maneuver
next landmark
```

Update continuously.

No fake `3.4 km` or `<1 min` values.

---

# 24. NAVIGATION UI

Главный экран должен быть минимальным.

While driving:

TOP:
- current road;
- GNSS/position integrity status.

CENTER:
- MapLibre map;
- vehicle marker;
- route.

MANEUVER CARD:
```text
Через 320 м
ПОВЕРНІТЬ ПРАВОРУЧ
вул. Сагайдачного
```

BOTTOM:
- ETA;
- remaining distance;
- NAVIA voice button.

A separate small confidence indicator.

No giant dashboards.

---

# 25. «ИЗЮМКА» PRODUCT FEATURE

Создать главный UX-loop:

### Normal

> «Через 420 м поверніть праворуч.»

### GNSS degradation

> «GNSS нестабільний. Я перевіряю положення за рухом та картою.»

### GNSS lost

> «Сигнал GNSS втрачено. Продовжую оцінювати ваш рух від останньої підтвердженої позиції.»

### Landmark

> «Через 180 м праворуч буде WOG. Після неї — поворот.»

### User asks

> «Я бачу WOG. Це вона?»

NAVIA verifies map/POI/vision context.

### Recovery

> «GNSS відновлено. Положення підтверджено.»

This sequence is the core demo and product identity.

---

# 26. DEMO MODE

Demo mode must be real software test harness, not fake UI.

Controls:

- Start demo
- Simulate GNSS degradation
- Simulate GNSS loss
- Simulate GPS jump
- Simulate wrong heading
- Simulate off-route
- Simulate landmark
- Simulate camera detection
- Simulate network loss
- Restore GNSS
- Reset

Every simulation must feed the same production engines.

Do NOT make a separate fake UI engine.

---

# 27. TEST ROUTE

Create reproducible demo route:

Kyiv center -> Kyiv Oblast destination.

Use actual route generated by routing engine.

Demo landmarks are associated with actual map coordinates.

Do not invent a route geometry just for UI.

---

# 28. OFFLINE TEST

The app must have a test:

1. download Kyiv/oblast offline package;
2. enable airplane mode;
3. disable network;
4. open map;
5. search local indexed address;
6. load saved route;
7. continue navigation;
8. dead reckoning works;
9. voice works;
10. app reports exactly what is unavailable.

---

# 29. DATA DOWNLOAD SCRIPTS

Create scripts:

```text
npm run data:download
npm run data:clip
npm run data:build-routing
npm run data:build-geocoder
npm run data:build-poi
npm run data:build-map
npm run data:package
```

Scripts must fail loudly with useful instructions.

No fake `offline=true`.

---

# 30. PRIVACY

Do not upload location to an AI provider by default.

Architecture:

```text
Phone
  ↓
local navigation
  ↓
structured context
  ↓
backend AI only when user asks
```

Allow a setting:

`Send location context to AI: ON/OFF`

Default should be conservative.

Do not store raw microphone audio unless explicitly required.

---

# 31. TELEMETRY / DEBUG

Create developer diagnostics screen.

Show:

```text
GPS accuracy
GPS speed
GPS heading
GNSS state
anomaly score
trusted position age
dead reckoning age
map match score
current road
route distance
confidence
sensor availability
network
offline package
```

This screen is for developers, not the driver.

---

# 32. LOGGING

Every navigation event gets:

```ts
type NavigationEvent = {
  timestamp: number;
  type:
    | "GNSS_FIX"
    | "GNSS_DEGRADED"
    | "GNSS_LOST"
    | "MAP_MATCH"
    | "ROUTE_UPDATE"
    | "OFF_ROUTE"
    | "RECOVERY"
    | "LANDMARK"
    | "VOICE"
    | "ALERT";
  payload: Record<string, unknown>;
};
```

Allow export to JSON for testing.

---

# 33. SAFETY

When confidence is low:

Do NOT give exact maneuver commands unless the route/road is independently reliable.

Example:

BAD:
> «Через 80 метров поверните направо»

when position uncertainty is high.

GOOD:
> «Позиция сейчас неточная. Я не могу надёжно подтвердить следующий поворот.»

Driver safety always wins over UX.

---

# 34. ACCEPTANCE TESTS

The application is not complete until these work.

## A. GPS

[ ] permission request
[ ] real coordinates
[ ] accuracy displayed
[ ] heading
[ ] speed
[ ] location updates
[ ] permission denied state

## B. Routing

[ ] address search
[ ] Kyiv address
[ ] Kyiv oblast address
[ ] real route
[ ] route geometry
[ ] turn instructions
[ ] ETA
[ ] rerouting

## C. GNSS resilience

[ ] trusted position
[ ] anomaly detection
[ ] simulated jump
[ ] GNSS degraded
[ ] GNSS lost
[ ] dead reckoning
[ ] confidence decay
[ ] recovery
[ ] recovery validation

## D. Map matching

[ ] road candidates
[ ] distance score
[ ] heading score
[ ] route continuity
[ ] ambiguity state
[ ] wrong-road detection

## E. Voice

[ ] TTS
[ ] STT
[ ] Ukrainian
[ ] repeat
[ ] navigation question
[ ] GNSS question
[ ] landmark question

## F. Landmarks

[ ] POI database
[ ] nearest landmark
[ ] route relevance
[ ] side of road
[ ] distance
[ ] ambiguity

## G. Offline

[ ] offline map
[ ] offline route package
[ ] offline address
[ ] offline POI
[ ] saved route
[ ] airplane mode test

## H. Air alert

[ ] informational status
[ ] timestamp
[ ] source
[ ] no safety claim

## I. Build

[ ] Android debug APK
[ ] Android release build configuration
[ ] iOS build configuration
[ ] TypeScript clean
[ ] tests pass
[ ] no fatal warnings

---

# 35. AUTOMATED TESTS

Create tests for:

### Geodesy
- haversine distance
- bearing
- destination point
- projection

### GNSS
- normal samples
- 500m jump
- impossible speed
- stale sample
- heading discontinuity

### Dead reckoning
- 10m/s for 10s = approximately 100m
- heading 0/90/180/270

### Map matching
- nearest road
- parallel roads
- ambiguous roads
- wrong heading

### Confidence
- clean GNSS => high
- poor accuracy => lower
- lost GNSS => decays
- map match disagreement => lower
- recovery => rises after validation

### Route
- progress
- next maneuver
- off route
- arrival

### AI
- must never invent POI
- must not answer exact turn under LOW confidence
- must use current route step
- must use actual distance

---

# 36. E2E TEST

Implement a deterministic simulation test:

```text
start at real Kyiv coordinate
↓
route to real destination
↓
drive normally
↓
GNSS accuracy degrades
↓
GNSS disappears
↓
dead reckoning continues
↓
map matching remains plausible
↓
AI answers "what is next?"
↓
landmark appears
↓
AI confirms only when data supports it
↓
GNSS recovers
↓
recovery validated
↓
arrive
```

The test must output a report.

---

# 37. BUILD OUTPUT

At the end, create:

```text
dist/
  android/
  ios/
  web/
```

At minimum produce an Android debug APK that can be installed for testing if the environment supports it.

If the environment cannot produce an iOS binary, still make the iOS project fully buildable.

Create:

```text
BUILD.md
TESTING.md
ARCHITECTURE.md
LIMITATIONS.md
```

---

# 38. CLAUDE CODE EXECUTION PROTOCOL

Work in stages.

## Stage 1
Inspect repository.

If an existing NAVIA prototype exists:
DO NOT throw it away.
Extract useful UI and migrate it into the new architecture.

## Stage 2
Create architecture and domain types.

## Stage 3
Implement geodesy + GNSS + trusted position.

Run tests.

## Stage 4
Implement route engine + MapLibre.

Run tests.

## Stage 5
Implement map matching + confidence.

Run tests.

## Stage 6
Implement dead reckoning + sensor fusion abstraction.

Run tests.

## Stage 7
Implement voice.

Run tests.

## Stage 8
Implement landmarks + POI.

Run tests.

## Stage 9
Implement offline package.

Run offline tests.

## Stage 10
Implement AI adapter.

Use mock/local deterministic AI first.
Then optional backend provider.

## Stage 11
Implement camera abstraction.

## Stage 12
Implement air alert informational layer.

## Stage 13
Polish UX.

## Stage 14
Build APK.

## Stage 15
Run complete acceptance suite.

---

# 39. AI PROVIDER

Create:

```ts
interface AIProvider {
  answer(context: NavigationContext, userText: string): Promise<string>;
}
```

Providers:

```text
DeterministicDemoAIProvider
RemoteLLMProvider
```

The app must run without an API key using deterministic AI.

Remote LLM must be behind backend.

Never put provider secret in mobile code.

---

# 40. NO FAKE DATA IN PRODUCTION PATH

The only acceptable mock data is:

`DemoEngine`.

Every production service must clearly identify itself:

```text
source: real
source: demo
source: unavailable
```

Do not silently substitute fake data.

---

# 41. ERROR STATES

Every subsystem needs explicit error handling.

Examples:

GPS denied:
> «Доступ до геолокації вимкнено.»

No network:
> «Мережі немає. Використовую офлайн пакет.»

No offline map:
> «Цей район не завантажено офлайн.»

No route:
> «Не вдалося побудувати маршрут.»

Low confidence:
> «Позиція неточна.»

AI unavailable:
> «Голосовий штурман тимчасово недоступний.»

---

# 42. PRODUCT QUALITY BAR

The app should feel like a real navigation product.

Do NOT fill screen with:
- engineering numbers;
- huge cards;
- fake confidence;
- decorative animations;
- unnecessary onboarding.

Main driving screen should be:
- map;
- next maneuver;
- distance;
- ETA;
- position integrity;
- voice button.

Developer diagnostics is a separate screen.

---

# 43. WHAT "DONE" MEANS

DONE means:

1. I can install the app.
2. I can grant Location permission.
3. NAVIA sees my actual position.
4. I can enter an actual Kyiv/Kyiv Oblast address.
5. NAVIA finds it.
6. NAVIA builds a real route.
7. I can start navigation.
8. NAVIA speaks instructions.
9. I can ask NAVIA a question.
10. I can simulate GNSS loss.
11. The navigation engine does not simply freeze.
12. Trusted position is preserved.
13. Dead reckoning continues.
14. Confidence changes based on real inputs.
15. Map matching continues to constrain the estimate.
16. GNSS recovery is validated.
17. I can download/use an offline map package.
18. I can use saved route without network.
19. POI/landmark context works.
20. AI never invents navigation facts.
21. Air-alert layer is informational.
22. Diagnostics allow me to inspect every subsystem.
23. Automated tests pass.
24. Android APK can be built.
25. iOS project can be built.

---

# 44. FIRST RESPONSE REQUIRED FROM CLAUDE CODE

Before changing code, give me:

1. current repository tree;
2. detected existing technologies;
3. what can be reused;
4. what must be replaced;
5. exact implementation plan;
6. dependencies to install;
7. data required for Kyiv/Kyiv Oblast;
8. expected build commands;
9. risks/blockers.

Then start implementation.

Do not ask me to approve every stage.
Proceed autonomously and keep the repository buildable.

At the end of every stage report:

```text
STAGE:
IMPLEMENTED:
TESTS:
BUILD:
REMAINING:
```

Do not claim a feature is complete until it has been tested.

---

# 45. FINAL INSTRUCTION

Build NAVIA as an actual resilient navigation application.

The heart of the product is NOT the AI chat.

The heart is:

GNSS integrity
+
sensor fusion
+
trusted position
+
dead reckoning
+
map matching
+
route engine
+
landmark engine
+
offline maps
+
voice
+
AI explanation layer.

The AI is the interface that makes the complex navigation system understandable to a human.

Do not build a fake demo.

Build the real system, with Demo Mode only as a controlled test harness.
