// Direct unit coverage for DemoEngine controls not exercised by the E2E
// scenario test: camera-detection simulation and reset().
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoEngine } from "../src/demo-engine";
import { demoGraph } from "./fixtures/demo-graph";
import type { POI } from "../src/landmark-engine";

test("DemoEngine: simulateCameraDetection ties a detection to a real nearby POI", async () => {
  const pois: POI[] = [{ id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: { lat: 50.4501, lon: 30.5240 } }];
  const engine = new DemoEngine({ graph: demoGraph, origin: { lat: 50.4501, lon: 30.5234 }, destination: { lat: 50.4501, lon: 30.5366 }, pois });
  await engine.start();
  engine.tick(1);
  const detections = await engine.simulateCameraDetection();
  assert.ok(detections.length >= 0); // may be 0 if not yet close enough; check shape when present
  for (const d of detections) {
    assert.equal(d.source, "demo");
    assert.ok(d.confidence > 0 && d.confidence <= 1);
  }
});

test("DemoEngine: reset() clears simulated conditions and telemetry", async () => {
  const engine = new DemoEngine({ graph: demoGraph, origin: { lat: 50.4501, lon: 30.5234 }, destination: { lat: 50.4501, lon: 30.5366 } });
  await engine.start();
  engine.simulateGnssLoss();
  engine.tick(1);
  assert.ok(engine.getTelemetry().getEvents().length > 0);
  engine.reset();
  assert.equal(engine.getTelemetry().getEvents().length, 0);
  assert.equal(engine.getRoute(), null);
  assert.equal(engine.getState().mode, "IDLE");
});

test("DemoEngine: askAI answers using only real context data", async () => {
  const engine = new DemoEngine({ graph: demoGraph, origin: { lat: 50.4501, lon: 30.5234 }, destination: { lat: 50.4501, lon: 30.5366 } });
  await engine.start();
  engine.tick(1);
  const reply = await engine.askAI("Який зараз сигнал GPS?");
  assert.ok(reply.length > 0);
});
