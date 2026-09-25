// NavigationEngine — the real-GPS orchestrator apps/mobile pushes device
// sensor samples into. These tests push hand-written GNSSRawSample values
// shaped exactly like what ExpoLocationPositionProvider would deliver
// (lat/lon/timestamp/accuracyM/speedMps/headingDeg) — this is ordinary unit
// testing of the engine's integration logic, not "faking a device": the
// same engine is what apps/mobile calls with real expo-location callbacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine } from "../src/navigation-engine";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import type { Route, RoutingProvider } from "../src/route-engine";
import { demoGraph } from "./fixtures/demo-graph";

const provider = new DemoRoutingProvider(demoGraph);

test("NavigationEngine: with no GNSS pushed yet, reports LOST and no position (never fabricates 0,0)", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  assert.equal(engine.getState().gnss, "LOST", "initial state must not advertise a healthy fix before the first tick");
  assert.equal(engine.getState().position, null);
  const state = engine.tick(1000);
  assert.equal(state.gnss, "LOST");
  assert.equal(state.position, null);
  assert.equal(state.trustedPosition, null);
});

test("NavigationEngine: a trusted GNSS fix produces a real position and NORMAL gnss state", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 1000, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  const state = engine.tick(1000);
  assert.equal(state.gnss, "NORMAL");
  assert.ok(state.position != null);
  assert.equal(state.mode, "ACTIVE");
});

test("NavigationEngine: stale GNSS on an active route is shown as an honest dead-reckoned estimate, never as GNSS", async () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  engine.tick(0);
  // 8s later, no new fix — past the 5s staleness and 3s red-state confirmation thresholds.
  const state = engine.tick(8000);
  assert.equal(state.gnss, "LOST", "GNSS status stays honest");
  assert.ok(state.position != null);
  assert.equal(state.position!.source, "DEAD_RECKONING", "the estimate is labelled as dead reckoning, not GNSS");
  assert.equal(state.positionMode, "DEAD_RECKONING");
  assert.ok((state.positionUncertaintyM ?? 0) > 5, "uncertainty is reported and exceeds the last fix accuracy");
  assert.notEqual(state.confidenceBand, "HIGH", "never high confidence without GNSS");
});

test("NavigationEngine: without a route, stale GNSS keeps only the last real fix briefly (no invented travel)", async () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  engine.tick(0);
  const state = engine.tick(8000);
  assert.equal(state.gnss, "LOST");
  assert.equal(state.position!.source, "GNSS");
  assert.equal(state.position!.position.timestamp, 0, "position timestamp remains the timestamp of the real fix");
});

test("NavigationEngine: off-route is detected via real corridor distance and reflected in state", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  // Move plausibly off the route over several fixes (route runs along lat 50.4501).
  for (let t = 0; t <= 16000; t += 1000) {
    const seconds = t / 1000;
    engine.pushGnssSample({ lat: 50.4501 + Math.min(seconds, 6) * 0.0001, lon: 30.5234 + seconds * 0.00005, timestamp: t, accuracyM: 5, speedMps: 9, headingDeg: 90 });
    engine.tick(t);
  }
  const state = engine.getState();
  assert.equal(state.offRoute, true);
  assert.equal(state.mode, "OFF_ROUTE");
});

test("NavigationEngine: a jumped fix cannot replace the last trusted location", () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 1000, accuracyM: 5, speedMps: 4, headingDeg: 90 });
  const accepted = engine.tick(1000).trustedPosition!.position;
  engine.pushGnssSample({ lat: 51.4501, lon: 30.5234, timestamp: 2000, accuracyM: 5, speedMps: 4, headingDeg: 90 });
  const rejected = engine.tick(2000);
  assert.deepEqual(rejected.trustedPosition!.position, accepted);
  assert.deepEqual(rejected.position!.position, accepted);
});

test("NavigationEngine: GPS reacquires after a long outage without comparing against the stale location", () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 0, headingDeg: null });
  engine.tick(0);
  engine.tick(9000);

  const resumed = { lat: 49.8397, lon: 24.0297, timestamp: 10_000, accuracyM: 5, speedMps: 0, headingDeg: null };
  engine.pushGnssSample(resumed, 10_000);
  assert.equal(engine.tick(10_000).trustedPosition?.position.lat, resumed.lat);
  engine.pushGnssSample({ ...resumed, timestamp: 11_000 }, 11_000);
  engine.tick(11_000);
  engine.pushGnssSample({ ...resumed, timestamp: 12_000 }, 12_000);
  assert.equal(engine.tick(12_000).gnss, "NORMAL");
});

test("NavigationEngine: public GNSS state uses hysteresis on degradation and recovery", () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  const push = (timestamp: number, accuracyM: number) => {
    engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp, accuracyM, speedMps: 4, headingDeg: 90 });
    return engine.tick(timestamp);
  };
  assert.equal(push(1000, 5).gnss, "NORMAL");
  assert.equal(push(2000, 100).gnss, "NORMAL", "one noisy fix does not flicker the public status");
  assert.equal(push(3000, 100).gnss, "DEGRADED");
  assert.equal(push(4000, 5).gnss, "DEGRADED", "one good fix does not immediately restore green");
  assert.equal(push(5000, 5).gnss, "DEGRADED");
  assert.equal(push(6000, 5).gnss, "NORMAL");
});

test("NavigationEngine: rejects honestly (no silent demo fallback) when the routing provider fails", async () => {
  const isolatedGraph = { nodes: [{ id: "a", position: { lat: 50.5, lon: 30.5 } }, { id: "b", position: { lat: 51.5, lon: 31.5 } }], edges: [] };
  const brokenProvider = new DemoRoutingProvider(isolatedGraph);
  const engine = new NavigationEngine({ routingProvider: brokenProvider });
  await assert.rejects(() => engine.requestRoute({ lat: 50.5, lon: 30.5 }, { lat: 51.5, lon: 31.5 }));
  assert.equal(engine.getRoute(), null);
});

test("NavigationEngine: a route response arriving after clearRoute cannot restore a cancelled trip", async () => {
  let resolveRoute!: (route: Route) => void;
  const pendingRoute = new Promise<Route>((resolve) => { resolveRoute = resolve; });
  const delayedProvider: RoutingProvider = {
    route: async () => pendingRoute,
    match: async (points) => ({ matchedPoints: points, roadSegmentIds: points.map(() => null) }),
    searchAlternatives: async () => [],
  };
  const engine = new NavigationEngine({ routingProvider: delayedProvider });
  const request = engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.clearRoute();
  resolveRoute(await provider.route({ origin: { lat: 50.4501, lon: 30.5234 }, destination: { lat: 50.4501, lon: 30.5366 } }));

  await assert.rejects(request, /cancelled or superseded/);
  assert.equal(engine.getRoute(), null);
});

test("NavigationEngine: reaching the destination transitions to ARRIVED via real route progress", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5366, timestamp: 0, accuracyM: 5, speedMps: 0, headingDeg: 90 });
  const state = engine.tick(0);
  assert.equal(state.mode, "ARRIVED");
});

test("GNSS: a phone standing still is not declared lost when iOS stops sending fixes", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) {
    engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: t0 + i * 1000, accuracyM: 5, speedMps: 0, headingDeg: null }, t0 + i * 1000);
    engine.tick(t0 + i * 1000);
  }
  assert.equal(engine.tick(t0 + 3000 + 15_000).gnss, "NORMAL");
  assert.notEqual(engine.tick(t0 + 3000 + 45_000).gnss, "NORMAL");
});

test("GNSS: a moving phone that stops getting fixes loses GNSS quickly", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  const t0 = 2_000_000;
  for (let i = 0; i < 4; i++) {
    engine.pushGnssSample({ lat: 50.45 + i * 0.0001, lon: 30.52, timestamp: t0 + i * 1000, accuracyM: 5, speedMps: 11, headingDeg: 0 }, t0 + i * 1000);
    engine.tick(t0 + i * 1000);
  }
  assert.notEqual(engine.tick(t0 + 3000 + 9_000).gnss, "NORMAL");
});

test("GNSS: unknown speed but the same place twice counts as standing still", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  const t0 = 3_000_000;
  for (let i = 0; i < 3; i++) {
    engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: t0 + i * 1000, accuracyM: 5, speedMps: null, headingDeg: null }, t0 + i * 1000);
    engine.tick(t0 + i * 1000);
  }
  assert.equal(engine.tick(t0 + 2000 + 15_000).gnss, "NORMAL");
});

test("GNSS conflict: fixes far from the dead-reckoned position are held back, then the user decides", async () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 }, 0);
  engine.tick(0);
  engine.tick(9000); // GNSS lost → dead reckoning
  assert.equal(engine.getState().positionMode, "DEAD_RECKONING");
  // A steady, plausible track ~1.2 km south: consistent with itself, not with the route estimate.
  for (let i = 0; i < 6; i++) {
    const t = 10_000 + i * 1000;
    const accepted = engine.pushGnssSample({ lat: 50.4390 - i * 0.00005, lon: 30.5250, timestamp: t, accuracyM: 5, speedMps: 6, headingDeg: 180 }, t);
    assert.equal(accepted, false, "not followed automatically");
    engine.tick(t);
  }
  const conflict = engine.getState().gnssConflict;
  assert.ok(conflict && conflict.distanceM > 800, "the user is asked about a sustained conflict");
  assert.equal(engine.acceptGnssConflict(15_000), true);
  engine.pushGnssSample({ lat: 50.43865, lon: 30.5250, timestamp: 16_000, accuracyM: 5, speedMps: 6, headingDeg: 180 }, 16_000);
  const after = engine.tick(16_000);
  assert.equal(after.positionMode, "GNSS", "after the user confirms, GNSS is followed again");
});

test("GNSS conflict: 'it's fake' keeps dead reckoning and stops asking for a while", async () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 }, 0);
  engine.tick(0);
  engine.tick(9000);
  for (let i = 0; i < 6; i++) {
    const t = 10_000 + i * 1000;
    engine.pushGnssSample({ lat: 50.4390, lon: 30.5250 + i * 0.00005, timestamp: t, accuracyM: 5, speedMps: 3, headingDeg: 90 }, t);
    engine.tick(t);
  }
  assert.ok(engine.getState().gnssConflict);
  engine.rejectGnssConflict(15_000);
  for (let i = 0; i < 6; i++) {
    const t = 16_000 + i * 1000;
    engine.pushGnssSample({ lat: 50.4390, lon: 30.5260 + i * 0.00005, timestamp: t, accuracyM: 5, speedMps: 3, headingDeg: 90 }, t);
    engine.tick(t);
  }
  assert.equal(engine.getState().gnssConflict, null);
  assert.equal(engine.getState().positionMode, "DEAD_RECKONING");
});

test("GNSS: standing still, a 5 s old fix of the same place (iOS position request) keeps GPS stable", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  for (let i = 0; i < 4; i++) {
    engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: i * 1000, accuracyM: 5, speedMps: 0, headingDeg: null }, i * 1000);
    engine.tick(i * 1000);
  }
  // 40 s of silence answered by probes returning 4.6 s old fixes.
  for (let t = 15_000; t <= 60_000; t += 15_000) {
    const accepted = engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: t - 4600, accuracyM: 5, speedMps: 0, headingDeg: null }, t);
    assert.equal(accepted, true, `probe at ${t} accepted`);
    assert.equal(engine.tick(t).gnss, "NORMAL");
  }
});

test("GNSS: an old fix is still rejected when moving, or when it is somewhere else", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  for (let i = 0; i < 4; i++) {
    engine.pushGnssSample({ lat: 50.45, lon: 30.52 + i * 0.0002, timestamp: i * 1000, accuracyM: 5, speedMps: 14, headingDeg: 90 }, i * 1000);
    engine.tick(i * 1000);
  }
  assert.equal(engine.pushGnssSample({ lat: 50.45, lon: 30.5208, timestamp: 3500, accuracyM: 5, speedMps: 14, headingDeg: 90 }, 8100), false);
});

test("GNSS: right after start (one fix, speed unknown) a slightly old probe fix of the same place is accepted", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 0, accuracyM: 5, speedMps: null, headingDeg: null }, 800);
  engine.tick(800);
  assert.equal(engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 11_000, accuracyM: 5, speedMps: null, headingDeg: null }, 15_800), true);
  assert.equal(engine.tick(15_800).gnss, "NORMAL");
});

test("GNSS: standing still, a 7 s old same-place fix under load is accepted; recovery needs one fix, not three", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 0, accuracyM: 5, speedMps: null, headingDeg: null }, 500);
  engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 1000, accuracyM: 5, speedMps: null, headingDeg: null }, 1500);
  engine.tick(1500);
  assert.equal(engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 9000, accuracyM: 5, speedMps: null, headingDeg: null }, 16_000), true);
  assert.equal(engine.tick(16_000).gnss, "NORMAL");
  // 50 s with no answer at all → lost (honest) …
  assert.notEqual(engine.tick(66_000).gnss, "NORMAL");
  // … then one clean same-place fix restores it.
  engine.pushGnssSample({ lat: 50.45, lon: 30.52, timestamp: 66_500, accuracyM: 5, speedMps: null, headingDeg: null }, 67_000);
  assert.equal(engine.tick(67_000).gnss, "NORMAL");
});
