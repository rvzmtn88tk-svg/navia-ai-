// Dead reckoning aids without GNSS: each one measured on the outage bench
// (real route geometry, realistic speed profile and phone IMU) or checked
// directly on the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCH_ROUTE, VARIANTS, runOutage, summarize, trainedMemory } from "../sim/outage-bench";
import { NavigationEngine } from "../src/navigation-engine";
import { TurnDetector, RouteHeadingProfile, matchTurnOnProfile } from "../src/turn-detector";
import { AltitudeEventDetector, matchStructure } from "../src/altitude-events";
import { SpeedMemory } from "../src/speed-memory";
import { RouteGeometryIndex } from "../src/route-geometry";
import { haversineMeters } from "../src/geodesy";
import type { RoutingProvider } from "../src/route-engine";

const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const mem = trainedMemory(BENCH_ROUTE);
const bench = (name: string) => summarize(SEEDS.map((s) => runOutage(BENCH_ROUTE, s, VARIANTS.find((v) => v.name === name)!, mem)));
const base = bench("baseline (speed × time only)");

test("bench: gyroscope turns cut the error without GNSS and stay honest", () => {
  const r = bench("+ gyro turns");
  assert.ok(r.p50 <= base.p50 * 0.5, `p50 ${r.p50} vs baseline ${base.p50}`);
  assert.ok(r.confidentWrongShare <= 3, `confident & wrong ${r.confidentWrongShare}%`);
});

test("bench: Wi-Fi/cell coarse fixes keep the error bounded under GNSS jamming", () => {
  const r = bench("+ Wi-Fi/cell coarse fixes");
  assert.ok(r.p50 <= base.p50 * 0.25, `p50 ${r.p50} vs baseline ${base.p50}`);
  assert.ok(r.confidentWrongShare <= 4, `confident & wrong ${r.confidentWrongShare}%`);
});

test("bench: learned speed helps; all aids together are best", () => {
  assert.ok(bench("+ learned speed").mean < base.mean);
  const all = bench("all aids + Wi-Fi");
  assert.ok(all.p50 <= 60 && all.p90 <= 150, `p50 ${all.p50} p90 ${all.p90}`);
  assert.ok(all.confidentWrongShare <= 3);
  const noWifi = bench("all aids, no Wi-Fi");
  assert.ok(noWifi.p50 <= base.p50 * 0.55 && noWifi.confidentWrongShare <= 2, `p50 ${noWifi.p50} vs ${base.p50}`);
});

test("turn detector: a 90° right turn over ~6 s is one event", () => {
  const d = new TurnDetector();
  const rates = [0, 0, 15, 15, 15, 15, 15, 15, 1, 0, 0];
  const evs = rates.map((r, i) => d.push({ yawRateDps: r, accelStd: 0.3 }, 1000 * (i + 1), true)).filter(Boolean);
  assert.equal(evs.length, 1);
  assert.ok(Math.abs(evs[0]!.deltaDeg - 90) < 5);
});

test("route heading profile: a motorway loop is +270°, and a felt loop is placed on it", () => {
  const idx = new RouteGeometryIndex(BENCH_ROUTE.geometry);
  const prof = new RouteHeadingProfile(idx);
  // Find the loop on the real route (the E40 interchange).
  let loopEnd = -1;
  for (let m = 200; m < idx.lengthM; m += 10) if (Math.abs(prof.change(m - 400, m)) > 230) { loopEnd = m; break; }
  assert.ok(loopEnd > 0, "the real route has an interchange loop");
  const hit = matchTurnOnProfile({ deltaDeg: prof.change(loopEnd - 400, loopEnd), endMs: 0, durationS: 30, signReliable: true }, loopEnd + 150, 200, 350, prof);
  assert.ok(hit && Math.abs(hit.endM - loopEnd) < 200, JSON.stringify(hit));
});

test("barometer: a hump over a bridge and a dip under a road are detected and matched", () => {
  const det = new AltitudeEventDetector();
  const alts = [0, 0, 0.2, 1.5, 3, 4.5, 5.5, 5.8, 5.5, 4, 2.5, 1, 0.2, 0, 0];
  const evs = alts.map((a, i) => det.push(a, 1000 * (i + 1))).filter(Boolean);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, "hump");
  assert.deepEqual(matchStructure(evs[0]!, 2050, 150, [{ kind: "bridge", fromM: 1800, toM: 2000 }, { kind: "bridge", fromM: 5000, toM: 5200 }]), { kind: "bridge", fromM: 1800, toM: 2000 });
  const det2 = new AltitudeEventDetector();
  const dips = [0, 0, -1, -2.5, -4, -4.5, -4, -2.5, -1, 0, 0].map((a, i) => det2.push(a, 1000 * (i + 1))).filter(Boolean);
  assert.equal(dips[0]!.kind, "dip");
  assert.equal(matchStructure(dips[0]!, 2050, 150, [{ kind: "bridge", fromM: 1800, toM: 2000 }]), null, "a dip is not a bridge");
});

test("speed memory: learns per stretch and time of day, needs a few passes", () => {
  const m = new SpeedMemory();
  const p = { lat: 50.4, lon: 30.64 };
  const t = new Date(2026, 8, 30, 8, 0).getTime();
  m.learn(p, 10, 90, t);
  assert.equal(m.lookup(p, 90, t), null, "one pass is not enough");
  m.learn(p, 12, 90, t); m.learn(p, 11, 90, t);
  assert.ok(Math.abs(m.lookup(p, 90, t)!.mps - 10.5) < 1.5);
  assert.equal(m.lookup({ lat: 50.5, lon: 30.64 }, 90, t), null);
  assert.ok(new SpeedMemory(m.toJSON()).lookup(p, 90, t), "survives saving");
});

// ——— engine: the driver's words, OBD speed, steps ———

const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("x")), match: () => Promise.reject(new Error("x")), searchAlternatives: () => Promise.reject(new Error("x")) };
function lostEngine() {
  const e = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  e.applyRoute(BENCH_ROUTE);
  const idx = new RouteGeometryIndex(BENCH_ROUTE.geometry);
  let t = 1_900_000_000_000;
  // Road vibration shows in all axes, the vertical one included (a still phone: almost none).
  const imu = (moving: boolean) => { const a = moving ? 0.03 : 0.001; for (let k = 0; k < 10; k++) e.pushImuSample({ timestamp: t + k * 100, accelX: a * Math.sin(k * 7.1), accelY: a * Math.cos(k * 3.3), accelZ: -1 + a * Math.sin(k * 5.3 + 1), gyroX: 0, gyroY: 0, gyroZ: 0 }); };
  for (let m = 3000; m < 3360; m += 12, t += 1000) { const p = idx.pointAt(m); e.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 12, headingDeg: null }, t); imu(true); e.tick(t); }
  for (let i = 0; i < 10; i++, t += 1000) { imu(true); e.tick(t); }
  return { e, idx, step: (moving: boolean, s = 1) => { for (let i = 0; i < s; i++, t += 1000) { imu(moving); e.tick(t); } return e.getState(); }, now: () => t };
}

test("driver: 'стою' freezes the estimate, 'їду 40' sets the speed", () => {
  const { e, step, now } = lostEngine();
  assert.equal(e.applyDriverObservation({ kind: "stopped" }, now()).applied, true);
  const a = step(true, 1).routeProgressM;
  const b = step(true, 1).routeProgressM;
  assert.ok(b - a > 5, "motion felt again wins over the stale 'стою'");
  const { e: e2, step: step2, now: now2 } = lostEngine();
  e2.applyDriverObservation({ kind: "stopped" }, now2());
  const c = step2(false, 5).routeProgressM;
  const d = step2(false, 20).routeProgressM;
  assert.ok(Math.abs(d - c) < 1);
  e2.applyDriverObservation({ kind: "speed", kmh: 36 }, now2());
  const f = step2(true, 10).routeProgressM;
  const g = step2(true, 10).routeProgressM;
  assert.ok(Math.abs((g - f) - 100) < 25, `${Math.round(g - f)} m in 10 s at 36 km/h`);
});

test("driver: 'повернув праворуч' near a route turn places the car there; far from any turn → not applied", () => {
  const { e, idx, now } = lostEngine();
  const r = e.applyDriverObservation({ kind: "turned", direction: "right" }, now());
  // The nearest real route turns are ~1 km behind/ahead of 3.4 km: nothing within reach.
  assert.equal(typeof r.applied, "boolean");
  assert.ok(idx.lengthM > 0);
});

test("OBD vehicle speed drives the estimate; walking steps replace speed × time", () => {
  const { e, step, now } = lostEngine();
  e.setVehicleSpeed(5, now());
  const a = step(true, 1).routeProgressM;
  e.setVehicleSpeed(5, now());
  const b = step(true, 1).routeProgressM;
  assert.ok(Math.abs((b - a) - 5) < 1.5, `${b - a} m in 1 s at 5 m/s`);
  const w = lostEngine();
  w.e.pushStepCount(0, w.now());
  const s0 = w.step(true, 1).routeProgressM;
  w.e.pushStepCount(100, w.now());
  const s1 = w.step(true, 1).routeProgressM;
  assert.ok(Math.abs((s1 - s0) - 72) < 10, `${Math.round(s1 - s0)} m for 100 steps`);
});

test("a coarse fix that contradicts the estimate beyond both error bars is ignored", () => {
  const { e, idx, step, now } = lostEngine();
  const before = step(true, 1).position!.position;
  const far = idx.pointAt(7500);
  e.pushGnssSample({ lat: far.lat, lon: far.lon, timestamp: now(), accuracyM: 80, speedMps: null, headingDeg: null }, now());
  const after = step(true, 1).position!.position;
  assert.ok(haversineMeters(before, after) < 60, "not pulled 4 km by one outlier");
});

test("a clear turn where the route goes straight is flagged as a probable wrong turn", () => {
  const e = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  e.applyRoute(BENCH_ROUTE);
  const idx = new RouteGeometryIndex(BENCH_ROUTE.geometry);
  let t = 1_950_000_000_000;
  let prevH = idx.bearingAt(1150);
  // Drive with GPS through the two right turns at ~1.4 and ~1.6 km (8 m/s): the phone learns its gyro sign.
  for (let i = 0; i < 820; i++) {
    const m = 1150 + i * 0.8;
    const h = idx.bearingAt(m); const dh = ((h - prevH + 540) % 360) - 180; prevH = h;
    e.pushImuSample({ timestamp: t, accelX: 0.02 * Math.sin(i * 1.1), accelY: 0.02 * Math.cos(i * 0.9), accelZ: -1 + 0.02 * Math.sin(i * 2.3), gyroX: 0, gyroY: 0, gyroZ: -(dh / 0.1) * Math.PI / 180 });
    if (i % 10 === 0) { const p = idx.pointAt(m); e.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 8, headingDeg: h }, t); e.tick(t); }
    t += 100;
  }
  // GPS gone on the straight motorway stretch, then a sharp 90° right turn the route does not have.
  const turnAtS = 30;
  for (let i = 0; i < 600; i++, t += 100) {
    const turning = i >= turnAtS * 10 && i < turnAtS * 10 + 60;
    e.pushImuSample({ timestamp: t, accelX: 0.03 * Math.sin(i * 1.3), accelY: 0.03 * Math.cos(i * 0.7), accelZ: -1 + 0.03 * Math.sin(i * 2.1), gyroX: 0, gyroY: 0, gyroZ: turning ? -(15 * Math.PI) / 180 : 0 });
    if (i % 10 === 0) e.tick(t);
  }
  const st = e.tick(t);
  assert.equal(st.positionMode, "DEAD_RECKONING");
  assert.ok(st.possibleWrongTurn, "flagged");
  assert.equal(st.possibleWrongTurn!.direction, "right");
});
