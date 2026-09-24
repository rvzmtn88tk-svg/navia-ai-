// Resilient navigation: guiding along the route while GNSS is jammed, lost
// or spoofed (the core NAVIA behaviour).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine } from "../src/navigation-engine";
import { MotionDetector, RouteDeadReckoner, deadReckoningConfidence } from "../src/route-dead-reckoning";
import type { Route, RoutingProvider } from "../src/route-engine";
import type { IMUSample } from "../src/types";

// A straight 2 km route due east along lat 50.45, two legs (turn at 1 km).
const route: Route = {
  id: "r", source: "demo", distanceM: 2000, durationS: 200,
  geometry: [{ lat: 50.45, lon: 30.5 }, { lat: 50.45, lon: 30.5 + 1000 / (111_320 * Math.cos(50.45 * Math.PI / 180)) }, { lat: 50.45, lon: 30.5 + 2000 / (111_320 * Math.cos(50.45 * Math.PI / 180)) }],
  steps: [
    { id: "s0", roadName: "A", maneuver: "depart", distanceM: 1000, durationS: 100, location: { lat: 50.45, lon: 30.5 } },
    { id: "s1", roadName: "B", maneuver: "right", distanceM: 1000, durationS: 100, location: { lat: 50.45, lon: 30.514 } },
    { id: "s2", roadName: "", maneuver: "arrive", distanceM: 0, durationS: 0, location: { lat: 50.45, lon: 30.528 } },
  ],
};
const fixedProvider: RoutingProvider = { route: async () => route, match: async () => ({ matchedPoints: [], roadSegmentIds: [] }), searchAlternatives: async () => [route] };

function imu(t: number, shake: number): IMUSample {
  return { timestamp: t, accelX: 0, accelY: shake * Math.sin(t), accelZ: 1 + shake * Math.cos(t * 1.3), gyroX: 0, gyroY: 0, gyroZ: 0 };
}

test("MotionDetector: vibration means moving, stillness means stationary, too little data is unknown", () => {
  const m = new MotionDetector();
  assert.equal(m.isMoving(0), null);
  for (let t = 0; t < 3000; t += 100) m.push(imu(t, 0.08));
  assert.equal(m.isMoving(3000), true);
  const still = new MotionDetector();
  for (let t = 0; t < 3000; t += 100) still.push(imu(t, 0.001));
  assert.equal(still.isMoving(3000), false);
});

test("RouteDeadReckoner: advances at the trusted speed while moving and stops when stationary", () => {
  const dr = new RouteDeadReckoner();
  dr.setRoute(route);
  dr.anchorFromGnss(100, 10, 5, 0);
  const moving = dr.estimate(10_000, true)!;
  assert.ok(Math.abs(moving.progressM - 200) < 1, `expected ~200 m, got ${moving.progressM}`);
  const stopped = dr.estimate(20_000, false)!;
  assert.ok(Math.abs(stopped.progressM - 200) < 1, "no progress while stationary");
  assert.ok(stopped.uncertaintyM > moving.uncertaintyM, "uncertainty keeps growing with time");
});

test("RouteDeadReckoner: with no trusted speed it uses the route's pace only while motion is confirmed", () => {
  const dr = new RouteDeadReckoner();
  dr.setRoute(route);
  dr.anchorManually(0, 0);
  assert.equal(dr.estimate(10_000, null)!.progressM, 0, "unknown motion + unknown speed: stay put");
  assert.ok(Math.abs(dr.estimate(20_000, true)!.progressM - 100) < 1, "route pace 10 m/s for 10 s");
});

test("deadReckoningConfidence: never high, collapses to unknown when the estimate is too old", () => {
  const dr = new RouteDeadReckoner();
  dr.setRoute(route);
  dr.anchorFromGnss(0, 10, 5, 0);
  const fresh = deadReckoningConfidence(dr.estimate(2_000, true)!);
  assert.equal(fresh.band, "MEDIUM");
  const old = deadReckoningConfidence(dr.estimate(16 * 60_000, false)!);
  assert.equal(old.band, "UNKNOWN");
});

test("NavigationEngine: keeps guiding along the route after GNSS loss and updates the next maneuver", async () => {
  const engine = new NavigationEngine({ routingProvider: fixedProvider, staleAfterMs: 3000 });
  await engine.requestRoute(route.geometry[0]!, route.geometry[2]!);
  engine.pushGnssSample({ lat: 50.45, lon: 30.5, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  engine.tick(0);
  for (let t = 100; t <= 60_000; t += 100) { engine.pushImuSample(imu(t, 0.08)); if (t % 1000 === 0) engine.tick(t); }
  const s = engine.getState();
  assert.equal(s.positionMode, "DEAD_RECKONING");
  assert.equal(s.gnss, "LOST");
  assert.ok(s.routeProgressM > 500 && s.routeProgressM < 700, `progress ~600 m, got ${s.routeProgressM}`);
  assert.equal(s.nextStep?.id, "s1", "still approaching the right turn");
  assert.ok((s.nextStepDistanceM ?? 0) > 300 && (s.nextStepDistanceM ?? 0) < 500);
  assert.notEqual(s.mode, "ARRIVED");
});

test("NavigationEngine: a spoofed fix far from the dead-reckoned position is rejected", async () => {
  const engine = new NavigationEngine({ routingProvider: fixedProvider, staleAfterMs: 3000 });
  await engine.requestRoute(route.geometry[0]!, route.geometry[2]!);
  engine.pushGnssSample({ lat: 50.45, lon: 30.5, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  engine.tick(0);
  engine.tick(10_000);
  assert.equal(engine.getState().positionMode, "DEAD_RECKONING");
  // "GPS" suddenly says we are ~20 km away (e.g. at the airport).
  const accepted = engine.pushGnssSample({ lat: 50.34, lon: 30.9, timestamp: 11_000, accuracyM: 4, speedMps: 10, headingDeg: 90 }, 11_000);
  assert.equal(accepted, false);
  assert.ok(engine.getTelemetry().getEventsByType("SPOOF_SUSPECT").length === 1);
  assert.notEqual(engine.tick(11_000).positionMode, "GNSS");
});

test("NavigationEngine: manual start and maneuver confirmation drive the estimate without any GNSS", async () => {
  const engine = new NavigationEngine({ routingProvider: fixedProvider, staleAfterMs: 3000 });
  engine.setManualPosition(route.geometry[0]!, 0);
  await engine.requestRoute(route.geometry[0]!, route.geometry[2]!);
  let s = engine.tick(1000);
  assert.equal(s.positionMode, "MANUAL");
  assert.equal(s.nextStep?.id, "s1");
  assert.ok(engine.confirmManeuverReached(2000));
  s = engine.tick(2000);
  assert.ok(s.routeProgressM >= 999, "snapped to the confirmed turn");
  assert.equal(s.nextStep?.id, "s2");
});
