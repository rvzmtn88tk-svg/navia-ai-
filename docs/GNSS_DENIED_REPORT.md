# NAVIA without GPS: design, evidence, limits

Date: 2026-09-29. The question was whether NAVIA can keep leading a driver to
the destination during an air alert, when GPS is jammed, degraded or
spoofed. This file describes what was built, how it was tested, the numbers
and what they do *not* prove.

## 1. What runs on the phone

`NavigationEngine({ resilient: true })` is on in the app
(`apps/mobile/src/engine/naviaController.ts`). Every second it feeds
`ResilientNavigator` (`packages/core/src/resilient/`) three inputs:

| Input | Where from | Used for |
|---|---|---|
| GNSS fix (lat/lon, accuracy, speed, course) | `expo-location` | Position, only after the integrity checks below |
| Yaw rate about the vertical axis, deg/s | gyroscope, projected on gravity (`MotionPreprocessor`), any phone mounting | Detects turns and bends and their angle |
| Vibration level (std of \|a\| over 1 s) | accelerometer | Stopped vs. moving (traffic lights, queues) |
| Road network | route polyline (online routes); a full road graph when one is supplied (offline package) | Constrains every hypothesis to a road |

**The filter.** Three hundred hypotheses of the form "on road edge E, O metres
in, at V m/s, cruising at C". Between junctions a car can only move along the
road, so the only unknown is distance travelled. At junctions and bends the
gyroscope says how much the car turned. Hypotheses that disagree die out,
which re-anchors the along-road position at every turn. It also shows when
the car turned where the route doesn't go. Speed follows a per-hypothesis
cruise speed learned while GPS was good (Ornstein–Uhlenbeck model), slows
before route turns and stops when the accelerometer says the car is still.
When no hypothesis explains a measured turn three times in a row, the filter
re-spreads over all roads nearby, and the next turns decide.

**GNSS integrity: when a fix is believed.**
1. *Position gate*: within 4σ (2.5σ for the first fixes after an outage) of
   the filter's cloud. σ is never smaller than 3% of the distance driven
   without GPS, so a collapsed but wrong cloud can't lock GPS out.
2. *Motion agreement*: the phone is still but GPS says moving (or the
   reverse); Doppler speed > 1.2 m/s while stopped at lights (a drifting
   spoof keeps "moving"); GPS course change ≠ gyro heading change over the
   last seconds.
3. *Turn-anchored check*: when the gyro sees a turn, the car is at a
   junction that allows that turn. If GPS puts the car where no such
   junction exists at two turns in a row, GPS is distrusted for 3 minutes
   and the car is re-placed on the exits of nearby junctions that fit the
   turn. This catches spoofs that drag the position slowly along or across
   the road, or replay an old track. Such spoofs pass every per-fix check.
4. *Re-acquisition*: a run of rejected fixes is believed again only if it is
   self-consistent, lies on roads, and shows a turn at the same time and
   angle as the gyro at a junction that allows it. On a long straight road
   with no turn to verify against, and only when the filter itself is lost
   (σ ≥ 150 m), a 30 s self-consistent on-road track is taken back as
   *unverified*: confidence stays at most LOW for 2 minutes or until a turn
   confirms it.

**What the driver sees and hears.**
- HUD: distance *to* the maneuver (the step length was shown before), with
  ±σ when uncertain, and "Без GPS: карта + гіроскоп (±80 м)" or "GPS
  підмінено — ігнорую".
- Voice, once per change: "GPS зник. Продовжую вести…", "Увага: сигнал GPS
  схожий на підробку…", "GPS відновлено".
- Turn announcements say "приблизно" and "звірте з табличкою" when
  uncertain.
- Off-route without GPS (the gyro saw a turn the route doesn't have):
  reroute from the junction ahead of the car.
- The co-pilot gets a `positioning:` line in `<trip_state>`. "Що робити без
  GPS?" is answered with what NAVIA is doing now (source, uncertainty, how
  to confirm turns), both by the LLM and by the offline fallback.

**Confidence is part of the output.** The navigator reports σ and a band
(HIGH/MEDIUM/LOW/UNKNOWN). It never claims more certainty than the spread of
its hypotheses supports, plus the dead-reckoning floor. Without motion
sensors it never reports HIGH once GPS is gone.

## 2. How it was tested: closed loop

A navigator is useful if a driver who follows it arrives, not if its
position error is small. `packages/core/sim/` therefore simulates the whole
loop:

- **World.** A synthetic road network per scenario: urban (jittered grid,
  7–12 × 7–12 blocks of 110–280 m, missing links, diagonals), suburban
  (sparse grid, bending roads), highway (8–20 km curving road with side
  roads). Origin and destination are ≥1.2 km apart.
- **Driver.** Does not know the route. At every junction they follow only
  the navigator's current instruction: they turn where the announced
  distance puts the maneuver and take the exit whose angle best matches.
  In 60% of scenarios they also read street-name signs (70% of the time).
  In 10% they make one wrong turn of their own.
- **Car.** Cruise speed varies ±20% every 20–60 s, slows for turns, stops
  at junctions (traffic lights, 5–45 s).
- **Sensors.** GNSS 1 Hz with 2–6 m noise and a slowly wandering bias. IMU
  present in 90% of scenarios: gyro bias ±0.08 °/s (iOS-calibrated) or
  ±0.6 °/s (uncalibrated), noise 0.1–0.5 °/s, the phone occasionally bumped.
- **Disruption** (starts 25–120 s in, lasts 60–900 s or to the end):

| Disruption | Share | What GNSS does |
|---|---|---|
| none | 4% | normal |
| jam | 20% | no fixes |
| jam_to_end | 16% | no fixes until arrival |
| degraded | 8% | 10–35 m noise, 5× bias, 10% dropouts |
| intermittent | 6% | 60% of fixes missing |
| spoof_far | 8% | a plausible track km away, moving at the car's speed |
| spoof_static | 7% | a fixed fake position |
| spoof_drift_lateral | 9% | the true position dragged sideways at 0.3–3 m/s |
| spoof_drift_along | 7% | dragged forward along the heading, speed inflated to match |
| spoof_replay | 8% | the car's own track replayed 15–120 s late |
| spoof_jumping | 7% | jumps to random positions within 5 km |

  Half the spoofs are preceded by a 5–30 s jam, as in capture attacks. The
  "air alert" flag is a label for stratification. The navigator doesn't use
  it, and the effect of an alert (more jamming/spoofing) is what the
  disruption mix models.
- **Compared on identical scenarios** (same world, sensors and driver random
  streams): the resilient navigator vs. the **existing NavigationEngine**
  (GNSSMonitor + dead reckoning + corridor off-route detector), both with
  automatic rerouting.
- **Metrics.**
  - *Reached destination*: physically, within a time budget of 3× the
    optimal time or optimal + 10 min.
  - *Confidently wrong*: share of disrupted seconds with band HIGH and
    error > 50 m, or MEDIUM and error > 150 m. This is the dangerous
    failure: the app is sure and wrong.
  - Per-trip p95 position error (median over trips).
  - Wrong turns (junction choices that lengthen the shortest remaining
    path).
  - Extra distance over the shortest path, for trips that arrived.

Reproduce: `npm run sim:gnss:100k` (4 workers, ~25 min), one case:
`npm run sim:replay -- <index>` (`SIM_TRACE=1` for a per-second trace).
Every scenario is determined by its index.

## 3. Results — 100,000 scenarios

**In short:** on 100,000 simulated trips with jamming or spoofing, a driver
following the new navigator reached the destination **90.5%** of the time
(95% CI 90.4–90.7). With the existing engine it was **67.9%**. The share of
disrupted seconds where the app was confidently wrong fell from **57.4% to
5.1%**, and the typical worst-case position error from 1.3 km to 66 m.

Where it helps most:
- GPS jammed until arrival: 86.9% vs. 46.4%.
- Far, static or jumping spoofs: 91–92% vs. about 62%, confidently wrong
  under 1% vs. 98%.
- Degraded or intermittent GPS: 99.7% (vs. 97.0% / 99.4%).
- With no disruption both are equal: 99.9% vs. 99.5%.

Where it does not:
- Along-road drift spoofing is still the hardest case: 77.1%, and
  confidently wrong 26% of the time.
- Replayed tracks: 83.4%, confidently wrong 20%.
- Without motion sensors: 75.0% (baseline 68.1%).

"R" = resilient navigator, "B" = baseline (existing NavigationEngine), on
identical scenarios. Extra distance is the median over trips that arrived.
Summary: `packages/core/sim/reports/mc-100k.json`. Per-scenario rows are
regenerated by the command above (16 MB, not in Git).

Run: 100000 scenarios, 0 errored, 2006 s, 2026-09-29T21:37:25.418Z.

### Overall

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 100000 | **90.5%** [90.4–90.7] | 67.9% | 5.1% | 57.4% | 66 | 1269 | 3.14 | 9.55 | 0% | 0% |

### By GNSS disruption

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| degraded | 8018 | **99.7%** [99.5–99.8] | 97.0% | 0.6% | 17.8% | 18 | 63 | 0.27 | 1.34 | 0% | 0% |
| intermittent | 6041 | **99.7%** [99.5–99.8] | 99.4% | 0.5% | 12.1% | 16 | 48 | 0.26 | 0.40 | 0% | 0% |
| jam | 19847 | **92.3%** [91.9–92.7] | 63.9% | 0.4% | 27.5% | 75 | 1959 | 2.70 | 10.99 | 0% | 4% |
| jam_to_end | 16164 | **86.9%** [86.4–87.4] | 46.4% | 0.4% | 23.7% | 79 | 3715 | 3.92 | 14.55 | 0% | 1% |
| none | 4021 | **99.9%** [99.7–100.0] | 99.5% | 0.0% | 0.0% | 9 | 14 | 0.14 | 0.22 | 0% | 0% |
| spoof_drift_along | 6957 | **77.1%** [76.1–78.1] | 69.0% | 25.7% | 87.5% | 471 | 422 | 7.35 | 9.33 | 0% | 0% |
| spoof_drift_lateral | 8873 | **88.6%** [87.9–89.3] | 70.3% | 5.6% | 87.9% | 99 | 418 | 3.59 | 8.81 | 0% | 0% |
| spoof_far | 7963 | **91.8%** [91.2–92.4] | 61.6% | 0.4% | 98.4% | 75 | 50071 | 2.90 | 11.68 | 0% | 6% |
| spoof_jumping | 7074 | **91.3%** [90.6–91.9] | 63.2% | 0.6% | 98.4% | 79 | 5602 | 3.14 | 11.37 | 0% | 6% |
| spoof_replay | 8063 | **83.4%** [82.5–84.2] | 63.5% | 20.1% | 96.3% | 311 | 698 | 5.48 | 11.38 | 0% | 7% |
| spoof_static | 6979 | **92.0%** [91.3–92.6] | 62.9% | 0.4% | 98.4% | 77 | 12978 | 2.87 | 11.41 | 0% | 4% |

### By road network

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| highway | 20154 | **89.1%** [88.7–89.6] | 75.3% | 6.0% | 48.6% | 339 | 2552 | 4.82 | 9.54 | 0% | 0% |
| suburban | 20139 | **91.4%** [91.0–91.7] | 77.7% | 3.2% | 55.1% | 67 | 1249 | 4.13 | 11.40 | 0% | 0% |
| urban | 59707 | **90.7%** [90.5–91.0] | 62.1% | 5.0% | 62.7% | 49 | 1057 | 2.23 | 8.93 | 0% | 1% |

### By motion sensors

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| imu | 89936 | **92.3%** [92.1–92.5] | 67.9% | 5.7% | 57.4% | 57 | 1270 | 2.62 | 9.56 | 0% | 0% |
| no_imu | 10064 | **75.0%** [74.1–75.8] | 68.1% | 1.4% | 57.3% | 520 | 1257 | 7.72 | 9.49 | 0% | 0% |

### By driver reading street signs

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| no_signs | 40042 | **90.0%** [89.7–90.3] | 67.3% | 4.9% | 57.2% | 65 | 1280 | 3.31 | 9.62 | 0% | 0% |
| reads_signs | 59958 | **90.9%** [90.7–91.1] | 68.3% | 5.2% | 57.5% | 66 | 1263 | 3.02 | 9.51 | 0% | 0% |

### By driver's own mistake

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| driver_mistake | 9931 | **85.8%** [85.1–86.5] | 65.9% | 5.0% | 56.7% | 99 | 1386 | 4.51 | 10.37 | 0% | 2% |
| no_mistake | 90069 | **91.1%** [90.9–91.2] | 68.1% | 5.1% | 57.4% | 64 | 1258 | 2.99 | 9.46 | 0% | 0% |

### By air-alert label

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| alert | 50075 | **90.6%** [90.4–90.9] | 67.9% | 5.1% | 57.3% | 66 | 1253 | 3.11 | 9.54 | 0% | 0% |
| no_alert | 49925 | **90.5%** [90.2–90.7] | 67.8% | 5.0% | 57.4% | 65 | 1285 | 3.16 | 9.57 | 0% | 0% |


## 4. How the algorithm got here

The simulator was used as a test bench, not just a scoreboard. Each change
below came from tracing failed scenarios. Numbers are success / confidently
wrong % on the same 2,000 scenarios.

| Version | Change (found by tracing failed scenarios) | Reached | Confidently wrong |
|---|---|---|---|
| Existing engine | — | 67.2% | 58.0% |
| v1 | road-graph particle filter, gyro/accelerometer weighting, basic GNSS gate, reacquire on gyro-matched turn | 88.0% | 11.5% |
| v2 | + probation after outage, DR uncertainty floor, adaptive heading σ | 86.5% | 7.3% |
| v3 | adaptive heading σ off (hurt success, kept off) | 87.7% | 7.3% |
| v4 | DR floor in the gate; unverified re-acquisition on long straight roads (a highway-jam deadlock) | 87.9% | 7.4% |
| v5 | course/gyro check only over recent fixes (stale history locked GPS out after long jams); driving the route backwards counts as off-route | 88.0% | 7.9% |
| v6 | turn-anchored spoof check, evaluated on the full turn angle (the first version fired mid-turn and distrusted real GPS) | 87.8% | 6.3% |
| (rejected) | also count rejected fixes and always re-place the car | 83.3% | 4.2% |
| v7 | count rejected fixes; re-place the car only if its own estimate doesn't fit the turn | 88.1% | 5.2% |
| v8 (final) | found by the tunnel / parking / recovery tests: re-seed on a trusted fix far from all hypotheses (after an outage or when lost), GPS course in the fix likelihood, uncertainty floor growing with distance since the last anchor (reported, not used for the gate), unexplained gyro turns raise uncertainty, app-suspension gaps bridged | 89.3% | 4.6% |

The rejected variant shows the trade-off: it was even less often
confidently wrong, but it threw away correct estimates under obvious spoofs
and arrived less often. The final version improves success and cuts
confidently-wrong time by more than half compared with v1. v8 on the full
100k run: 90.5% / 5.1%.

## 5. What this does NOT prove

- **Synthetic worlds and sensor models.** The road networks are generated,
  not Kyiv's. Sensor noise, gyro bias and spoof behaviour are models of the
  published behaviour of phone IMUs and of known jamming/spoofing patterns,
  not recordings. Real urban canyons, multipath, tunnels, multi-level
  junctions and phones sliding in a cup holder are not in the model.
- **The driver model is generous in one way and strict in another.** The
  simulated driver executes instructions perfectly at the junction they pick
  and reads signs in 60% of scenarios. They also never use common sense
  ("that was obviously the ring road").
- **Online routes give a route-only network.** In the app today, online
  (Valhalla) routes come without a local road graph. The navigator then
  constrains the car to the route itself. That keeps along-route tracking
  and spoof rejection, but a turn off the route is recognised only from GPS
  fixes the gyro confirms, and the turn-anchored spoof check is off. The
  simulator measured the full-graph case. Loading the offline OSM road graph
  (`scripts/data`) into `networkForRoute` closes this gap. It is plumbing,
  not new algorithm work.
- **Without motion sensors** (10% of scenarios) success is much lower. The
  road constraint and the speed model alone drift, and there is no way to
  tell a real turn from a spoofed one. The app then caps confidence at LOW.
- **Along-road drift spoofing is the hardest case.** Between turns, a
  forward drift of 0.3–3 m/s with matching Doppler is indistinguishable from
  driving slightly faster. It is caught at the next turn or stop, not
  before.
- **No real drive has been recorded.** Everything above ran in Node; the
  code runs unchanged on the phone, but it has not been validated on a real
  iPhone in a real car. This cloud environment cannot install on or drive
  with a phone.

## 6. Validating on the phone (next step)

1. Build per `docs/HANDOFF_IOS.md`. Mount the phone in a holder. Drive
   5 minutes with good GPS first (calibrates gravity sign and vibration
   level).
2. Airplane mode is not a GPS test: iOS keeps GPS on in airplane mode. To
   test GNSS loss, use a Faraday pouch around the phone briefly or drive
   through a long tunnel. Or record: log `GNSSRawSample` and `IMUSample`
   streams on real drives, then replay them through
   `NavigationEngine({ resilient: true })` with fixes removed or altered.
   This is the offline test the synthetic simulator stands in for, and the
   single most valuable next step.
3. Watch for: yaw sign (a right turn must show a positive rate; learned
   automatically after two GPS turns), the stopped/moving threshold on your
   mount, and HUD distance vs. real distance at turns.

## 7. GPS loss in the app: states, guidance, offline

**One location state for everyone.** `LocationStateTracker` classifies the
navigator's output into PRECISE / REDUCED_ACCURACY / STALE (a few seconds
without a fix) / UNSTABLE (coming and going) / LOST / SPOOFED / RECOVERED.
It adds a confidence (0–1) and a guidance policy:

| Policy | When | What NAVIA says |
|---|---|---|
| exact | σ ≤ 30 m, with a fix in the last 5 s | "Через 400 метрів праворуч, на вул. …" |
| approximate | σ ≤ 150 m, or dead reckoning for more than 5 s | "Приблизно через 400 метрів праворуч… Звірте з табличкою." |
| none | σ > 150 m or the navigator itself is lost | the maneuver from the route without a distance, and "Точна геопозиція тимчасово недоступна…" once |

The HUD, `VoiceGuidance` (announcements at 1000/400/150/30 m), the co-pilot
(`positioning:` line) and the offline fallback all read the same state. The
AI never estimates position itself.

**Recovery without a jump.** When GPS returns, the fix is checked against
the dead-reckoned estimate: the gate, motion agreement, and a gyro turn when
one is available. The particles re-seed around a trusted fix if needed, and
off-route is judged against the real road graph. The map marker glides over
a correction of 15–400 m in about 3 s (`PositionSmoother`); larger ones snap.

**Internet ≠ GPS.** A connectivity monitor probes NAVIA's own services, so
`internet=offline` is separate from GPS state.

- The active trip (destination, stops, preferences, full route with
  maneuvers) is saved on the phone (`ActiveTripCache`, expo-sqlite).
- A failed reroute keeps the current route instead of replacing the
  navigation screen with an error.
- After a restart without internet, the saved trip to the same destination
  is restored.
- The cloud AI falls back to the on-device answers.

**App suspended.** A gap of more than 10 s without input (screen locked, app
in background) is bridged honestly. The uncertainty grows with the gap, and
the first fixes afterwards are accepted through a correspondingly wide gate.
Navigation keeps the screen awake, like any turn-by-turn app.

**Scenario tests** (`packages/core/test/location-resilience.test.ts`, all
passing). They run through `NavigationEngine` + `VoiceGuidance` with 10 Hz
raw IMU and a car that accelerates and brakes realistically (≤3 m/s² /
4 m/s²):

| Scenario | Checked |
|---|---|
| GPS lost 5 s | STALE only, guidance continues, no alarm, error < 25 m |
| 30 s | LOST, dead reckoning, error < 40 m, one spoken notice, "GPS відновлено" on return |
| 2 min | turn announcements continue, confidence falls, "exact" only while σ ≤ 30 m |
| tunnel (1.7 km, turn after the exit) | turn announced inside, never off-route, marker moves < 25 m/s at recovery, arrives |
| long tunnel (6.7 km, faster inside) | never "exact" with error > 2σ; recovered ≤ 40 s after the exit |
| underground parking (5 min of ramps, no GPS) | never HIGH, never "exact" when wrong; recovered ≤ 45 s after exiting, stays recovered |
| urban drift (±35 m wandering bias) | no false off-route, error < 40 m, never PRECISE |
| weak GPS (60–100 m) | never PRECISE / HIGH |
| one fix 300 m away | rejected: no reroute, no marker jump |
| no internet, GPS fine | route kept after failed reroute; guidance continues; AI says offline |
| GPS + internet lost | dead reckoning continues; offline co-pilot explains truthfully |
| GPS returns after a real departure | off-route detected, reroute from the junction ahead |
| GPS returns on the route | no reroute, confidence back |
| app suspended 2 min driving / parked | first fixes accepted, no false spoofing alarm, correct position |

**iOS realities.**

- **Sensors.** The gyro and accelerometer come from `expo-sensors`
  (CoreMotion underneath; no permission prompt). Magnetometer heading is not
  used: inside a car it is unreliable.
- **Background.** With the screen locked and no background location mode,
  iOS suspends the app. NAVIA keeps the screen awake during navigation.
  True background navigation needs `expo-task-manager` +
  `Location.startLocationUpdatesAsync` + `UIBackgroundModes`
  location/audio, a native change to add and verify on a device.
- **Map tiles.** Offline tiles need MapLibre offline packs for the route
  corridor. Not implemented. The saved route is enough for guidance, but the
  map background may be blank offline.


## App path (route dead reckoning) — aids without GNSS (30.09.2026)

`npx tsx packages/core/sim/outage-bench.ts 12`: the real Valhalla route along Mykoly Bazhana Ave (fixture), realistic speed
(slowing for turns, two stops at lights), a phone IMU at 10 Hz in expo-sensors units, GNSS jammed at a random point;
error of the engine's position vs. the truth, every second of the outage, 12 drives per variant.

route 8031 m, 11 turns, 12 drives per variant
| variant | error p50 | p90 | mean | confident & >100 m | error within 2σ |
|---|---|---|---|---|---|
| baseline (speed × time only) | 428 m | 1260 m | 582 m | 0.2% | 86.2% |
| + gyro turns | 124 m | 940 m | 295 m | 0.4% | 83.6% |
| + learned speed | 399 m | 983 m | 474 m | 0.2% | 96.4% |
| + Wi-Fi/cell coarse fixes | 45 m | 122 m | 58 m | 1.3% | 94.4% |
| all aids, no Wi-Fi | 120 m | 372 m | 167 m | 0.2% | 94.3% |
| all aids + Wi-Fi | 33 m | 84 m | 42 m | 0.4% | 98.1% |

What each aid is: gyroscope turns matched to the route's own heading profile (curves, ramps, loops; ambiguous → no
anchor); coarse Wi-Fi/cell fixes (they survive GNSS jamming) as a 1-D Kalman update with an outlier gate; learned speed
per ~200 m stretch × time of day; barometer humps/dips at the route's bridges/tunnels (map tiles); the driver's words
(report_driver_observation); OBD speed (Bluetooth ELM327); pedometer when walking; live traffic flow (TomTom via the
proxy — needs a key). "error within 2σ" = how honest the reported uncertainty is. Tests: `packages/core/test/dr-aids.test.ts`.
Not yet from real drives: record trips (Settings → Запис поїздок) and replay them (`npm run replay:trips`).
