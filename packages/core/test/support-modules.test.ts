// Covers AirAlertLayer, TelemetryLogger, DiagnosticsEngine, POIEngine,
// DemoVisionProvider, and the offline-manager interfaces (spec sections
// 12, 15, 18, 19, 31, 32).
import {test} from "node:test";
import assert from "node:assert/strict";
import {AirAlertLayer, DemoAirAlertProvider} from "../src/air-alert-layer";
import {TelemetryLogger} from "../src/telemetry-logger";
import {DiagnosticsEngine, type DiagnosticsInput} from "../src/diagnostics-engine";
import {POIEngine} from "../src/poi-engine";
import {DemoVisionProvider} from "../src/vision-provider";
import {NotYetBuiltOfflineMapManager} from "../src/offline-manager";
import type {POI} from "../src/landmark-engine";

test("AirAlertLayer: with no provider, honestly reports unavailable rather than defaulting to 'no alert'", async () => {
  const layer = new AirAlertLayer();
  const status = await layer.refresh("Київська область");
  assert.equal(status.source, "unavailable");
});

test("AirAlertLayer: demo provider toggles active/inactive and tags source as demo", async () => {
  const demoProvider = new DemoAirAlertProvider(false);
  const layer = new AirAlertLayer(demoProvider);
  let status = await layer.refresh("Київська область");
  assert.equal(status.active, false);
  assert.equal(status.source, "demo");
  demoProvider.setActive(true);
  status = await layer.refresh("Київська область");
  assert.equal(status.active, true);
  assert.ok(status.startedAt);
});

test("AirAlertLayer: exposes no route-safety-claim API at all (design check)", () => {
  const layer = new AirAlertLayer();
  const anyLayer = layer as unknown as Record<string, unknown>;
  assert.equal(typeof anyLayer["isRouteSafe"], "undefined");
  assert.equal(typeof anyLayer["recommendPath"], "undefined");
  assert.match(AirAlertLayer.SAFETY_DISCLAIMER, /не оцінює безпечність/);
});

test("TelemetryLogger: logs real events and exports them as JSON", () => {
  const logger = new TelemetryLogger();
  logger.log("GNSS_LOST", {reason: "tunnel"}, 1000);
  logger.log("RECOVERY", {}, 2000);
  assert.equal(logger.getEvents().length, 2);
  assert.equal(logger.getEventsByType("GNSS_LOST").length, 1);
  const json = JSON.parse(logger.exportJSON());
  assert.equal(json[0].type, "GNSS_LOST");
  assert.equal(json[0].payload.reason, "tunnel");
});

test("TelemetryLogger: caps history at maxEvents (oldest dropped first)", () => {
  const logger = new TelemetryLogger(3);
  for (let i = 0; i < 5; i++) logger.log("GNSS_FIX", {i});
  const events = logger.getEvents();
  assert.equal(events.length, 3);
  assert.equal(events[0]!.payload.i, 2); // events 0,1 were evicted
});

test("DiagnosticsEngine: computes real ages from timestamps, never fabricates unavailable fields", () => {
  const engine = new DiagnosticsEngine();
  const now = 10_000;
  const input: DiagnosticsInput = {
    gpsAccuracyM: 5, gpsSpeedMps: 10, gpsHeadingDeg: 90, gnssState: "NORMAL",
    anomalyScore: 0.1, trustedPositionAt: 8000, deadReckoningActiveSince: null,
    mapMatchScore: 0.9, currentRoadName: "вул. Хрещатик", routeDistanceRemainingM: 500,
    confidence: 0.9, confidenceBand: "HIGH",
    sensorsAvailable: {gnss: true, accelerometer: true, gyroscope: true, magnetometer: false},
    networkAvailable: true, offlinePackageState: "not_downloaded",
  };
  const snap = engine.snapshot(input, now);
  assert.equal(snap.trustedPositionAgeMs, 2000);
  assert.equal(snap.deadReckoningAgeMs, null); // never active in this sample -> honestly null, not 0
  assert.equal(snap.currentRoadName, "вул. Хрещатик");
});

test("POIEngine: near() returns only POIs within radius, nearest first", () => {
  const engine = new POIEngine();
  const pois: POI[] = [
    {id: "a", name: "A", category: "fuel", location: {lat: 50.45, lon: 30.52}},
    {id: "b", name: "B", category: "fuel", location: {lat: 50.4505, lon: 30.52}}, // ~55m away
    {id: "c", name: "C", category: "fuel", location: {lat: 51.0, lon: 31.0}}, // far
  ];
  engine.load(pois);
  const near = engine.near({lat: 50.45, lon: 30.52}, 100);
  assert.deepEqual(near.map((p) => p.id), ["a", "b"]);
});

test("POIEngine: searchByName matches name or brand case-insensitively", () => {
  const engine = new POIEngine();
  engine.load([{id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.45, lon: 30.52}}]);
  assert.equal(engine.searchByName("wog").length, 1);
  assert.equal(engine.searchByName("shell").length, 0);
});

test("DemoVisionProvider: detection is tied to an actual nearby POI, not invented", async () => {
  const pois: POI[] = [{id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.4501, lon: 30.5210}}];
  const provider = new DemoVisionProvider(pois);
  const detections = await provider.analyzeFrame(
    {timestamp: Date.now(), width: 640, height: 480},
    {position: {lat: 50.4501, lon: 30.5200}, headingDeg: 90}
  );
  assert.equal(detections.length, 1);
  assert.equal(detections[0]!.label, "WOG");
  assert.equal(detections[0]!.source, "demo");
  assert.ok(detections[0]!.confidence > 0 && detections[0]!.confidence <= 1);
});

test("DemoVisionProvider: no nearby POI -> no fabricated detection", async () => {
  const provider = new DemoVisionProvider([]);
  const detections = await provider.analyzeFrame(
    {timestamp: Date.now(), width: 640, height: 480},
    {position: {lat: 50.4501, lon: 30.5200}, headingDeg: 90}
  );
  assert.equal(detections.length, 0);
});

test("offline manager: honestly reports 'unavailable' rather than faking a ready package", async () => {
  const manager = new NotYetBuiltOfflineMapManager();
  const status = manager.getStatus();
  assert.equal(status.state, "unavailable");
  const downloadResult = await manager.download();
  assert.equal(downloadResult.state, "unavailable");
});
