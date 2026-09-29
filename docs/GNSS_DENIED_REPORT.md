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
following the new navigator reached the destination **88.7%** of the time
(95% CI 88.5–88.9). With the existing engine it was **67.9%**. The share of
disrupted seconds where the app was confidently wrong fell from **57.4% to
5.2%**, and the typical worst-case position error from 1.3 km to 65 m.

Where it helps most:
- GPS jammed until arrival: 86.9% vs. 46.4%.
- Far, static or jumping spoofs: about 90% vs. about 62%, confidently wrong
  under 1% vs. 98%.

Where it does not:
- Intermittent GPS (60% of fixes missing) is slightly **worse** than the
  existing engine: 97.4% vs. 99.4%. The integrity checks cost more than they
  save when real fixes keep arriving.
- Along-road drift spoofing is still hard: 71.0%, and confidently wrong 26%
  of the time.
- Without motion sensors: 70.5%, about the same as the baseline.
- With no disruption both are equal: 99.3% vs. 99.5%.

"R" = resilient navigator, "B" = baseline (existing NavigationEngine), on
identical scenarios. Extra distance is the median over trips that arrived.
Rows: `packages/core/sim/reports/mc-100k.json`; per-scenario rows are
regenerated by the command above (16 MB, not in Git).

Run: 100000 scenarios, 0 errored, 1432 s, 2026-09-29T20:51:43.519Z.

### Overall

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 100000 | **88.7%** [88.5–88.9] | 67.9% | 5.2% | 57.4% | 65 | 1269 | 3.51 | 9.55 | 0% | 0% |

### By GNSS disruption

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| degraded | 8018 | **98.5%** [98.2–98.8] | 97.0% | 0.9% | 17.8% | 18 | 63 | 0.53 | 1.34 | 0% | 0% |
| intermittent | 6041 | **97.4%** [96.9–97.7] | 99.4% | 1.3% | 12.1% | 16 | 48 | 0.96 | 0.40 | 0% | 0% |
| jam | 19847 | **90.4%** [90.0–90.8] | 63.9% | 0.9% | 27.5% | 74 | 1959 | 3.15 | 10.99 | 0% | 4% |
| jam_to_end | 16164 | **86.9%** [86.4–87.4] | 46.4% | 0.8% | 23.7% | 80 | 3715 | 3.87 | 14.55 | 0% | 1% |
| none | 4021 | **99.3%** [99.0–99.5] | 99.5% | 0.0% | 0.0% | 9 | 14 | 0.28 | 0.22 | 0% | 0% |
| spoof_drift_along | 6957 | **71.0%** [69.9–72.0] | 69.0% | 26.4% | 87.5% | 585 | 422 | 8.56 | 9.33 | 0% | 0% |
| spoof_drift_lateral | 8873 | **86.0%** [85.3–86.7] | 70.3% | 6.2% | 87.9% | 89 | 418 | 4.00 | 8.81 | 0% | 0% |
| spoof_far | 7963 | **89.9%** [89.2–90.5] | 61.6% | 0.8% | 98.4% | 75 | 50071 | 3.28 | 11.68 | 0% | 6% |
| spoof_jumping | 7074 | **89.4%** [88.7–90.1] | 63.2% | 1.0% | 98.4% | 81 | 5602 | 3.50 | 11.37 | 0% | 6% |
| spoof_replay | 8063 | **82.4%** [81.5–83.2] | 63.5% | 16.5% | 96.3% | 212 | 698 | 5.68 | 11.38 | 0% | 7% |
| spoof_static | 6979 | **89.9%** [89.1–90.5] | 62.9% | 0.8% | 98.4% | 78 | 12978 | 3.32 | 11.41 | 0% | 4% |

### By road network

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| highway | 20154 | **85.3%** [84.8–85.8] | 75.3% | 6.0% | 48.6% | 355 | 2552 | 5.88 | 9.54 | 0% | 0% |
| suburban | 20139 | **90.6%** [90.1–90.9] | 77.7% | 3.8% | 55.1% | 66 | 1249 | 4.34 | 11.40 | 0% | 0% |
| urban | 59707 | **89.3%** [89.0–89.5] | 62.1% | 5.0% | 62.7% | 48 | 1057 | 2.43 | 8.93 | 0% | 1% |

### By motion sensors

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| imu | 89936 | **90.8%** [90.6–90.9] | 67.9% | 5.8% | 57.4% | 57 | 1270 | 2.94 | 9.56 | 0% | 0% |
| no_imu | 10064 | **70.5%** [69.6–71.4] | 68.1% | 1.5% | 57.3% | 709 | 1257 | 8.61 | 9.49 | 0% | 0% |

### By driver reading street signs

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| no_signs | 40042 | **88.2%** [87.9–88.5] | 67.3% | 5.0% | 57.2% | 65 | 1280 | 3.67 | 9.62 | 0% | 0% |
| reads_signs | 59958 | **89.1%** [88.8–89.3] | 68.3% | 5.3% | 57.5% | 65 | 1263 | 3.41 | 9.51 | 0% | 0% |

### By driver's own mistake

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| driver_mistake | 9931 | **83.6%** [82.9–84.4] | 65.9% | 5.1% | 56.7% | 100 | 1386 | 4.85 | 10.37 | 0% | 2% |
| no_mistake | 90069 | **89.3%** [89.1–89.5] | 68.1% | 5.2% | 57.4% | 63 | 1258 | 3.36 | 9.46 | 0% | 0% |

### By air-alert label

| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| alert | 50075 | **88.7%** [88.4–88.9] | 67.9% | 5.1% | 57.3% | 66 | 1253 | 3.52 | 9.54 | 0% | 0% |
| no_alert | 49925 | **88.8%** [88.5–89.1] | 67.8% | 5.2% | 57.4% | 65 | 1285 | 3.50 | 9.57 | 0% | 0% |



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
| v7 (final) | count rejected fixes; re-place the car only if its own estimate doesn't fit the turn | 88.1% | 5.2% |

The rejected variant shows the trade-off: it was even less often
confidently wrong, but it threw away correct estimates under obvious spoofs
and arrived less often. The final version keeps success and cuts
confidently-wrong time by more than half compared with v1.

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
