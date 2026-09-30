// GNSS-denied navigation: RoadNetwork, MotionPreprocessor, ResilientNavigator
// and its integration into NavigationEngine (the engine the app runs on real
// sensors). The drives below are generated deterministically: a car moves
// along a real route computed by DemoRoutingProvider over a synthetic street
// grid, and the test produces the samples a phone would — GNSS fixes (true,
// jammed or spoofed) and 10 Hz raw IMU samples (gyro rad/s, accelerometer g).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine } from "../src/navigation-engine";
import { DemoRoutingProvider, type DemoRoadGraph } from "../src/demo-routing-provider";
import { positionAtDistance, type Route } from "../src/route-engine";
import { haversineMeters, initialBearing } from "../src/geodesy";
import { RoadNetwork, mapRouteToNetwork, wrapDeg } from "../src/resilient/road-network";
import { MotionPreprocessor } from "../src/resilient/motion-preprocessor";
import { Rng } from "../src/resilient/resilient-navigator";
import { generateWorld } from "../sim/world";
import { sampleScenario, runScenario } from "../sim/closed-loop";
import type { NavigationState } from "../src/types";
import { NavigationStateMachine } from "../src/navigation-state-machine";
import { DeterministicDemoAIProvider } from "../src/ai-engine";

// A plain 200 m street grid, 6 × 6 junctions.
function grid(): DemoRoadGraph {
  const nodes = [], edges = [];
  const base = { lat: 50.45, lon: 30.5 };
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    nodes.push({ id: `g${r}_${c}`, position: { lat: base.lat + (r * 200) / 111_320, lon: base.lon + (c * 200) / (111_320 * Math.cos((base.lat * Math.PI) / 180)) } });
  }
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    if (c < 5) edges.push({ id: `h${r}_${c}`, fromId: `g${r}_${c}`, toId: `g${r}_${c + 1}`, roadName: `вул. Поперечна ${r + 1}` });
    if (r < 5) edges.push({ id: `v${r}_${c}`, fromId: `g${r}_${c}`, toId: `g${r + 1}_${c}`, roadName: `вул. Поздовжня ${c + 1}` });
  }
  return { nodes, edges };
}

type Drive = {
  engine: NavigationEngine;
  route: Route;
  /** Drive for `seconds`; `gnssAt(t, truth)` decides what GNSS reports. Returns the worst position error seen. */
  run(seconds: number, gnssAt: (t: number, truth: { lat: number; lon: number }, v: number, heading: number) => { lat: number; lon: number; speedMps: number; headingDeg: number } | null | "true", opts?: { imu?: boolean }): { maxErrM: number; last: NavigationState };
  distanceM(): number;
};

async function startDrive(graph: DemoRoadGraph, from: string, to: string, withGraph: boolean): Promise<Drive> {
  const router = new DemoRoutingProvider(graph);
  const net = RoadNetwork.fromDemoGraph(graph);
  const engine = new NavigationEngine({
    routingProvider: router,
    resilient: withGraph ? { networkForRoute: () => net } : true,
  });
  const pos = (id: string) => graph.nodes.find((n) => n.id === id)!.position;
  const route = await engine.requestRoute(pos(from), pos(to));
  const rng = new Rng(7);
  let d = 0, t = 0, heading = initialBearing(route.geometry[0]!, route.geometry[1]!);
  // Where the route turns: the car slows to 5 m/s for those, cruises at 10 m/s otherwise.
  const turnsAt: number[] = [];
  let cum = 0;
  for (const st of route.steps) { if (st.maneuver === "left" || st.maneuver === "right") turnsAt.push(cum); cum += st.distanceM; }
  return {
    engine,
    route,
    distanceM: () => d,
    run(seconds, gnssAt, opts = {}) {
      let maxErrM = 0;
      for (let k = 0; k < seconds; k++) {
        // Parked at the destination once reached.
        const parked = d >= route.distanceM;
        const v = parked ? 0 : turnsAt.some((a) => Math.abs(a - d) < 25) ? 5 : 10;
        const before = positionAtDistance(route.geometry, d);
        d = Math.min(route.distanceM, d + v);
        const truth = positionAtDistance(route.geometry, d);
        const ahead = positionAtDistance(route.geometry, Math.min(route.distanceM, d + 1));
        const target = parked ? heading : haversineMeters(truth, ahead) > 0.1 ? initialBearing(truth, ahead) : initialBearing(before, truth);
        const step = Math.max(-25, Math.min(25, wrapDeg(target - heading)));
        heading = (heading + step + 360) % 360;
        // 10 Hz raw IMU: phone flat, screen up (accelerometer reads +1 g on z at rest);
        // road vibration while moving, near-silence when parked.
        const vib = parked ? 0.002 : 0.03;
        if (opts.imu !== false) {
          for (let j = 0; j < 10; j++) {
            engine.pushImuSample({
              timestamp: t * 1000 + j * 100,
              accelX: rng.normal() * vib, accelY: rng.normal() * vib, accelZ: 1 + rng.normal() * vib,
              gyroX: rng.normal() * 0.002, gyroY: rng.normal() * 0.002, gyroZ: (-step * Math.PI) / 180 + rng.normal() * 0.002,
            });
          }
        }
        t += 1;
        const g = gnssAt(t, truth, v, heading);
        const fix = g === "true" ? { lat: truth.lat + rng.normal() * 3 / 111_320, lon: truth.lon, speedMps: v, headingDeg: heading } : g;
        if (fix) engine.pushGnssSample({ ...fix, timestamp: t * 1000, accuracyM: 5 });
        const s = engine.tick(t * 1000);
        const p = s.position?.position;
        if (p) maxErrM = Math.max(maxErrM, haversineMeters(p, truth));
      }
      return { maxErrM, last: engine.getState() };
    },
  };
}

test("RoadNetwork: two directed edges per road, turn sign (+ right), route maps onto graph edges", async () => {
  const g = grid();
  const net = RoadNetwork.fromDemoGraph(g);
  assert.equal(net.edges.length, 2 * g.edges.length);
  // East along a row, then north: a left turn (−90°).
  const east = net.edges.find((e) => net.nodes[e.from]!.id === "g0_0" && net.nodes[e.to]!.id === "g0_1")!;
  const north = net.edges.find((e) => net.nodes[e.from]!.id === "g0_1" && net.nodes[e.to]!.id === "g1_1")!;
  const south = net.edges.find((e) => net.nodes[e.from]!.id === "g1_1" && net.nodes[e.to]!.id === "g0_1")!;
  assert.ok(Math.abs(net.turn(east.index, north.index) + 90) < 1);
  assert.equal(east.reverse >= 0, true);
  assert.ok(Math.abs(Math.abs(net.edges[north.index]!.bearing - net.edges[south.index]!.bearing) - 180) < 1);
  const route = await new DemoRoutingProvider(g).route({ origin: g.nodes[0]!.position, destination: g.nodes[35]!.position });
  const edgesBefore = net.edges.length;
  const spans = mapRouteToNetwork(net, route);
  assert.equal(net.edges.length, edgesBefore, "every route segment lies on a graph edge");
  const mapped = spans.reduce((a, s) => a + (s.toOffset - s.fromOffset), 0);
  assert.ok(Math.abs(mapped - route.distanceM) < 5, `mapped ${mapped} vs route ${route.distanceM}`);
});

test("MotionPreprocessor: yaw about the vertical axis whatever the phone's orientation", () => {
  // Flat phone, screen up: turning right (clockwise from above) is negative z rotation.
  const flat = new MotionPreprocessor();
  let out = null;
  for (let i = 0; i <= 10; i++) out = flat.push({ timestamp: i * 100, accelX: 0, accelY: 0, accelZ: 1, gyroX: 0, gyroY: 0, gyroZ: -0.2 }) ?? out;
  assert.ok(out && Math.abs(out.yawRateDps - 11.46) < 0.2, `flat: ${out?.yawRateDps}`);
  // Upright in a holder (gravity along +y): the same turn is rotation about y.
  const upright = new MotionPreprocessor();
  out = null;
  for (let i = 0; i <= 10; i++) out = upright.push({ timestamp: i * 100, accelX: 0, accelY: 1, accelZ: 0, gyroX: 0, gyroY: -0.2, gyroZ: 0 }) ?? out;
  assert.ok(out && Math.abs(out.yawRateDps - 11.46) < 0.2, `upright: ${out?.yawRateDps}`);
});

test("MotionPreprocessor: learns the platform's gravity sign from GNSS turns", () => {
  // Phone flat, screen up, on a platform that reports gravity as −1 g on z
  // (the opposite convention): with the default assumption yaw comes out inverted.
  // A real right turn (clockwise seen from above) is a negative rotation about z.
  const mp = new MotionPreprocessor();
  let ts = 0, course = 0;
  const turn = (dir: 1 | -1) => {
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 10; i++) { mp.push({ timestamp: ts, accelX: 0, accelY: 0, accelZ: -1, gyroX: 0, gyroY: 0, gyroZ: (-dir * 15 * Math.PI) / 180 }); ts += 100; }
      course = (course + dir * 15 + 360) % 360;
      mp.observeGnss(ts, 10, course);
    }
    for (let s = 0; s < 20; s++) { for (let i = 0; i < 10; i++) { mp.push({ timestamp: ts, accelX: 0, accelY: 0, accelZ: -1, gyroX: 0, gyroY: 0, gyroZ: 0 }); ts += 100; } mp.observeGnss(ts, 10, course); }
  };
  assert.equal(mp.getCalibration().upSign, 1);
  turn(1); turn(-1); turn(1);
  assert.equal(mp.getCalibration().upSign, -1, "sign flipped after disagreeing turns");
  let out = null;
  for (let i = 0; i <= 10; i++) { out = mp.push({ timestamp: ts, accelX: 0, accelY: 0, accelZ: -1, gyroX: 0, gyroY: 0, gyroZ: -0.2 }) ?? out; ts += 100; }
  assert.ok(out && out.yawRateDps > 10, `after learning a right turn reads positive: ${out?.yawRateDps}`);
});

test("NavigationEngine (resilient): GNSS jammed for the rest of the trip — keeps guiding along the route to arrival", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", true);
  drive.run(25, () => "true");
  const jam = drive.run(400, () => null);
  const s = jam.last;
  assert.equal(s.positioning?.source, "DEAD_RECKONING");
  assert.equal(s.gnss, "LOST");
  assert.ok(jam.maxErrM < 100, `max error during jam ${jam.maxErrM.toFixed(0)} m`);
  assert.equal(s.mode, "ARRIVED", `mode ${s.mode}, remaining ${s.routeRemainingM}`);
});

test("NavigationEngine (resilient): next-maneuver distance is the distance to the turn, not the step length", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", true);
  const { last } = drive.run(10, () => "true");
  assert.ok(last.nextStep && last.nextManeuverDistanceM != null);
  // Distance to the maneuver from the route geometry.
  let along = 0;
  for (const st of drive.route.steps) {
    if (st.id === last.nextStep!.id) break;
    along += st.distanceM;
  }
  assert.ok(Math.abs(last.nextManeuverDistanceM! - (along - drive.distanceM())) < 25,
    `reported ${last.nextManeuverDistanceM} vs geometric ${along - drive.distanceM()}`);
});

test("NavigationEngine (resilient): spoofed GNSS far away is rejected and flagged, position stays with the car", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", true);
  drive.run(25, () => "true");
  let spoofT = 0;
  const spoof = drive.run(90, (_t, truth, v, h) => {
    spoofT++;
    return { lat: truth.lat + 0.02, lon: truth.lon + 0.01 + (spoofT * v) / 70_000, speedMps: v, headingDeg: h };
  });
  const s = spoof.last;
  assert.equal(s.positioning?.gnssVerdict, "REJECTED");
  assert.equal(s.positioning?.gnssSuspectedSpoofing, true);
  assert.notEqual(s.confidenceBand, "HIGH");
  assert.ok(spoof.maxErrM < 80, `max error under spoofing ${spoof.maxErrM.toFixed(0)} m`);
});

test("NavigationEngine (resilient): with no road graph, the route itself carries the car through a jam", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", false);
  drive.run(25, () => "true");
  const jam = drive.run(60, () => null);
  assert.equal(jam.last.positioning?.source, "DEAD_RECKONING");
  assert.ok(jam.maxErrM < 60, `max error ${jam.maxErrM.toFixed(0)} m`);
  assert.ok(jam.last.routeProgressM > 600, `progress ${jam.last.routeProgressM}`);
});

test("NavigationEngine (resilient): without motion sensors, confidence is never HIGH once GNSS is gone", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", true);
  drive.run(25, () => "true", { imu: false });
  const jam = drive.run(40, () => null, { imu: false });
  assert.equal(jam.last.positioning?.imuAvailable, false);
  assert.notEqual(jam.last.confidenceBand, "HIGH");
});

test("NavigationEngine: classic pipeline unchanged when resilient navigation is not enabled", async () => {
  const g = grid();
  const engine = new NavigationEngine({ routingProvider: new DemoRoutingProvider(g) });
  await engine.requestRoute(g.nodes[0]!.position, g.nodes[35]!.position);
  engine.pushGnssSample({ ...g.nodes[0]!.position, timestamp: 1000, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  const s = engine.tick(1000);
  assert.equal(s.positioning, undefined);
  assert.equal(engine.getResilientEstimate(), null);
});

test("Closed-loop sim smoke: a driver following only the navigator reaches the destination more often than with the classic engine", async () => {
  let base = 0, res = 0;
  const N = 16;
  for (let i = 0; i < N; i++) {
    const r = await runScenario(sampleScenario(i));
    if (r.baseline.success) base++;
    if (r.resilient.success) res++;
  }
  assert.ok(res >= base, `resilient ${res}/${N} vs baseline ${base}/${N}`);
  assert.ok(res >= Math.ceil(N * 0.7), `resilient ${res}/${N}`);
});

test("Synthetic worlds are connected and reproducible", () => {
  const a = generateWorld(new Rng(3), "urban"), b = generateWorld(new Rng(3), "urban");
  assert.deepEqual(a.graph.nodes.slice(0, 5), b.graph.nodes.slice(0, 5));
  assert.equal(a.graph.edges.length, b.graph.edges.length);
  for (const kind of ["urban", "suburban", "highway"] as const) {
    const w = generateWorld(new Rng(11), kind);
    assert.ok(w.graph.nodes.some((n) => n.id === w.origin) && w.graph.nodes.some((n) => n.id === w.destination));
  }
});

test("NavigationStateMachine: a trip can end at the destination while GNSS is lost", () => {
  const sm = new NavigationStateMachine();
  const base = { gnssIntegrity: "NORMAL" as const, confidenceBand: "HIGH" as const, offRouteConfirmed: false, hasArrived: false, routeRequested: false, routeReady: false };
  sm.tick({ ...base, routeRequested: true });
  sm.tick({ ...base, routeReady: true });
  for (let i = 0; i < 4; i++) sm.tick({ ...base, gnssIntegrity: "LOST", confidenceBand: "LOW" });
  assert.equal(sm.getMode(), "GNSS_LOST");
  assert.equal(sm.tick({ ...base, gnssIntegrity: "LOST", confidenceBand: "LOW", hasArrived: true }), "ARRIVED");
});

test("Offline co-pilot answer to 'what do I do without GPS?' says what the navigator is actually doing", async () => {
  const drive = await startDrive(grid(), "g0_0", "g5_5", true);
  drive.run(25, () => "true");
  drive.run(30, () => null);
  const ctx = { state: drive.engine.getState(), route: drive.route, nearbyLandmarks: [], nearbyPOI: [], recentEvents: [] };
  const ai = new DeterministicDemoAIProvider();
  const noGps = await ai.answer(ctx, "Що робити без GPS?");
  assert.match(noGps, /продовжую вести/);
  assert.match(noGps, /гіроскоп/);
  assert.match(noGps, /\d+ м/);
  const next = await ai.answer(ctx, "Куди далі?");
  assert.doesNotMatch(next, /не можу впевнено/, next);
});
