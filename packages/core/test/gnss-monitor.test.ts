import { test } from "node:test";
import assert from "node:assert/strict";
import { GNSSMonitor, type GNSSRawSample } from "../src/gnss-monitor";

const monitor = new GNSSMonitor({
  maxPlausibleSpeedMps: 45,
  maxJumpM: 150,
  maxFreshAgeMs: 6_000,
  accuracyGoodM: 10,
  accuracyBadM: 80,
});

function fix(overrides: Partial<GNSSRawSample> = {}): GNSSRawSample {
  return { lat: 50.45, lon: 30.52, timestamp: 1_000, accuracyM: 5, speedMps: 4, headingDeg: 90, ...overrides };
}

test("GNSSMonitor trusts a fresh, accurate first fix", () => {
  const result = monitor.evaluate(null, fix(), 1_000);
  assert.equal(result.trusted, true);
  assert.equal(result.freshnessScore, 1);
});

test("GNSSMonitor rejects invalid coordinates, unknown accuracy and stale/future fixes", () => {
  assert.equal(monitor.evaluate(null, fix({ lat: 91 }), 1_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ accuracyM: null }), 1_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ timestamp: 0 }), 7_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ timestamp: 5_000 }), 1_000).trusted, false);
});

test("GNSSMonitor rejects out-of-order and physically implausible jumps", () => {
  const first = fix({ timestamp: 1_000 });
  assert.equal(monitor.evaluate(first, fix({ timestamp: 900 }), 1_000).trusted, false);
  assert.equal(monitor.evaluate(first, fix({ lat: 51.45, timestamp: 2_000 }), 2_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ speedMps: 80 }), 1_000).trusted, false);
});

test("GNSSMonitor rejects an impossible heading flip and malformed sensor values", () => {
  const first = fix({ timestamp: 1_000, headingDeg: 0, speedMps: 0 });
  assert.equal(monitor.evaluate(first, fix({ timestamp: 2_000, headingDeg: 180, speedMps: 0 }), 2_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ speedMps: -1 }), 1_000).trusted, false);
  assert.equal(monitor.evaluate(null, fix({ headingDeg: 360 }), 1_000).trusted, false);
});
