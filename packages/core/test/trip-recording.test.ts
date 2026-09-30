// Real-trip recordings: recorder → file → parse → replay through the app's
// NavigationEngine with GNSS cut or spoofed. A drive along the demo route
// stands in for a real recording here; real ones come from the phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { TripRecorder, parseTripRecording, replayTrip } from "../src/trip-recording";
import { destinationPoint, haversineMeters, initialBearing } from "../src/geodesy";
import type { LatLon } from "../src/types";
import { kyivToBoryspilGraph } from "./fixtures/kyiv-oblast-graph";

async function drive(): Promise<string> {
  const route = await new DemoRoutingProvider(kyivToBoryspilGraph).route({ origin: { lat: 50.4501, lon: 30.5234 }, destination: { lat: 50.3450, lon: 30.9526 } });
  const rec = new TripRecorder({ startedAt: 1_000_000, device: "test" });
  let t = 1_000_000;
  rec.route(route, t);
  const g = route.geometry;
  const speed = 14; // m/s
  // Road vibration: a moving car is never perfectly still to the accelerometer.
  let seed = 3;
  const noise = (a: number) => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * a; };
  let text = rec.headerLine() + "\n";
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1]!, b = g[i]!;
    const len = haversineMeters(a, b);
    const brg = initialBearing(a, b);
    for (let d = 0; d < len; d += speed) {
      const p: LatLon = destinationPoint(a, brg, d);
      rec.gnss({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: speed, headingDeg: brg }, t);
      for (let k = 0; k < 20; k++) rec.imu({ timestamp: t + k * 50, accelX: noise(0.6), accelY: noise(0.6), accelZ: -9.81 + noise(0.8), gyroX: noise(0.02), gyroY: noise(0.02), gyroZ: noise(0.02) }, t + k * 50);
      t += 1000;
    }
    text += rec.takeChunk();
  }
  return text;
}

test("recorder writes a header, GNSS at 1 Hz and IMU thinned to 10 Hz", async () => {
  const rec = parseTripRecording(await drive());
  assert.equal(rec.header.kind, "navia-trip");
  const gnss = rec.events.filter((e) => e.k === "gnss").length;
  const imu = rec.events.filter((e) => e.k === "imu").length;
  assert.ok(gnss > 500, `gnss ${gnss}`);
  assert.ok(imu >= gnss * 9 && imu <= gnss * 10 + 1, `imu ${imu} for ${gnss} s`);
  assert.equal(rec.events.filter((e) => e.k === "route").length, 1);
});

test("a truncated last line does not lose the trip", async () => {
  const text = await drive();
  const cut = text.slice(0, text.length - 40);
  assert.ok(parseTripRecording(cut).events.length > 100);
});

test("replay with GNSS cut after the warm-up scores dead reckoning against the fixes it did not see", async () => {
  const r = replayTrip(parseTripRecording(await drive()), { outages: "full", warmupS: 60 });
  assert.ok(r.truthPoints > 300, `truth ${r.truthPoints}`);
  assert.ok((r.coverage ?? 0) > 0.95, `coverage ${r.coverage}`);
  // Constant speed along the route: dead reckoning should stay close.
  assert.ok((r.errorM.p50 ?? Infinity) < 150, `p50 ${r.errorM.p50}`);
  assert.ok(r.maneuvers.length > 0);
});

test("periodic outages and spoofing produce comparable numbers", async () => {
  const rec = parseTripRecording(await drive());
  const periodic = replayTrip(rec, { outages: "periodic" });
  assert.ok(periodic.outageS > 0 && periodic.outageS < periodic.durationS);
  const spoof = replayTrip(rec, { outages: "full", spoofOffsetM: 800 });
  assert.ok(spoof.errorM.p50 != null);
  assert.ok(spoof.confidentErrorShare != null && spoof.confidentErrorShare >= 0 && spoof.confidentErrorShare <= 1);
});
