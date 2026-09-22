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
import { demoGraph } from "./fixtures/demo-graph";

const provider = new DemoRoutingProvider(demoGraph);

test("NavigationEngine: with no GNSS pushed yet, reports LOST and no position (never fabricates 0,0)", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
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

test("NavigationEngine: staleness (no new fix within staleAfterMs) declares GNSS_LOST and keeps a dead-reckoned position moving", async () => {
  const engine = new NavigationEngine({ routingProvider: provider, staleAfterMs: 5000 });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5234, timestamp: 0, accuracyM: 5, speedMps: 10, headingDeg: 90 });
  engine.tick(0);
  // 8s later, no new fix — past the 5s staleness threshold.
  const state = engine.tick(8000);
  assert.equal(state.gnss, "LOST");
  assert.ok(state.position != null, "dead reckoning should still produce a position");
  assert.equal(state.position!.source, "DEAD_RECKONING");
});

test("NavigationEngine: off-route is detected via real corridor distance and reflected in state", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  // Far off the route line (route runs along lat 50.4501).
  for (let t = 0; t <= 9000; t += 1000) {
    engine.pushGnssSample({ lat: 50.4600, lon: 30.5280, timestamp: t, accuracyM: 5, speedMps: 8, headingDeg: 90 });
    engine.tick(t);
  }
  const state = engine.getState();
  assert.equal(state.offRoute, true);
  assert.equal(state.mode, "OFF_ROUTE");
});

test("NavigationEngine: rejects honestly (no silent demo fallback) when the routing provider fails", async () => {
  const isolatedGraph = { nodes: [{ id: "a", position: { lat: 50.5, lon: 30.5 } }, { id: "b", position: { lat: 51.5, lon: 31.5 } }], edges: [] };
  const brokenProvider = new DemoRoutingProvider(isolatedGraph);
  const engine = new NavigationEngine({ routingProvider: brokenProvider });
  await assert.rejects(() => engine.requestRoute({ lat: 50.5, lon: 30.5 }, { lat: 51.5, lon: 31.5 }));
  assert.equal(engine.getRoute(), null);
});

test("NavigationEngine: reaching the destination transitions to ARRIVED via real route progress", async () => {
  const engine = new NavigationEngine({ routingProvider: provider });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  engine.pushGnssSample({ lat: 50.4501, lon: 30.5366, timestamp: 0, accuracyM: 5, speedMps: 0, headingDeg: 90 });
  const state = engine.tick(0);
  assert.equal(state.mode, "ARRIVED");
});
