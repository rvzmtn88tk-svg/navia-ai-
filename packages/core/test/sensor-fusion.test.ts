// Spec section 9 explicitly requires unit tests for: stationary, constant
// velocity, turning, GPS outage.
import {test} from "node:test";
import assert from "node:assert/strict";
import {SensorFusionEngine, ExtendedKalmanFilterFusion} from "../src/sensor-fusion";

const engine = new SensorFusionEngine();

test("sensor fusion: stationary — GNSS and DR agree, fused position matches both", () => {
  const pos = {lat: 50.45, lon: 30.52};
  const out = engine.fuse({
    gnss: {position: pos, timestamp: Date.now(), speedMps: 0, headingDeg: 90, quality: 0.97},
    deadReckoned: {position: pos, speedMps: 0, headingDeg: 90},
  });
  assert.equal(out.position.lat, 50.45);
  assert.equal(out.position.lon, 30.52);
  assert.equal(out.speedMps, 0);
  assert.equal(out.source, "GNSS"); // quality 0.97 clears the >=0.95 "effectively pure GNSS" threshold
});

test("sensor fusion: constant velocity — fused position lands between GNSS and DR, closer to the higher-quality one", () => {
  const gnssPos = {lat: 50.4600, lon: 30.52};
  const drPos = {lat: 50.4602, lon: 30.52}; // DR has drifted slightly north of the true GNSS fix
  const out = engine.fuse({
    gnss: {position: gnssPos, timestamp: Date.now(), speedMps: 12, headingDeg: 0, quality: 0.8},
    deadReckoned: {position: drPos, speedMps: 12, headingDeg: 0},
  });
  assert.equal(out.source, "FUSED");
  assert.equal(out.gnssWeight, 0.8);
  // 80% weight toward GNSS means fused lat should be much closer to gnssPos than drPos.
  assert.ok(out.position.lat < gnssPos.lat + 0.0001);
  assert.ok(Math.abs(out.position.lat - gnssPos.lat) < Math.abs(out.position.lat - drPos.lat));
  assert.equal(out.speedMps, 12);
  assert.equal(out.headingDeg, 0);
});

test("sensor fusion: turning — heading blends circularly across the 0/360 wrap, not linearly", () => {
  const pos = {lat: 50.45, lon: 30.52};
  const out = engine.fuse({
    gnss: {position: pos, timestamp: Date.now(), speedMps: 8, headingDeg: 350, quality: 0.5},
    deadReckoned: {position: pos, speedMps: 8, headingDeg: 10},
  });
  // Naive linear average of 350 and 10 is 180 (exactly backwards). Circular
  // average must land near 0/360 instead.
  assert.ok(out.headingDeg !== null);
  const h = out.headingDeg as number;
  const nearZero = h < 5 || h > 355;
  assert.ok(nearZero, `expected heading near 0/360, got ${h}`);
});

test("sensor fusion: GPS outage — gnss is null, falls back cleanly to dead reckoning", () => {
  const drPos = {lat: 50.47, lon: 30.53};
  const out = engine.fuse({
    gnss: null,
    deadReckoned: {position: drPos, speedMps: 9, headingDeg: 200},
  });
  assert.equal(out.source, "DEAD_RECKONING");
  assert.equal(out.gnssWeight, 0);
  assert.deepEqual(out.position, drPos);
});

test("sensor fusion: throws when neither GNSS nor DR is available", () => {
  assert.throws(() => engine.fuse({gnss: null, deadReckoned: null}));
});

test("sensor fusion: EKF v2 is an honest not-implemented stub, not a fake result", () => {
  const ekf = new ExtendedKalmanFilterFusion();
  assert.throws(() => ekf.step({}, {}, 1), /not implemented/);
});
