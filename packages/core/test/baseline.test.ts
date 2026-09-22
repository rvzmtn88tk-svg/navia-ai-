// Baseline tests carried over from the original master-spec starter kit
// (tests/core.test.ts in the zip), relocated into the workspace layout.
//
// NOTE ON TEST RUNNER: the spec's starter file imported from "vitest", but
// this sandbox's outbound network does not currently reach registry.npmjs.org
// (every package request returns 403, confirmed for typescript/vitest/lodash
// alike — this is an org egress policy state, not a code problem), so `npm
// install` cannot fetch vitest here. Node 22's built-in `node:test` +
// `node:assert/strict`, run through the globally-preinstalled `tsx` loader
// (`tsx --test`), is used instead — this is a real, executing test runner,
// not a stub. See LIMITATIONS.md. Swap back to vitest's describe/it/expect
// with a one-line change once `npm install` can reach the registry.
import {test} from "node:test";
import assert from "node:assert/strict";
import {haversineMeters,destinationPoint} from "../src/geodesy";
import {deadReckon} from "../src/dead-reckoning";
import {calculateConfidence} from "../src/confidence";

test("dead reckoning: moves ~100m at 10m/s for 10s", () => {
  const p = deadReckon({position:{lat:50.45,lon:30.52},speedMps:10,headingDeg:90,dtSeconds:10});
  const d = haversineMeters({lat:50.45,lon:30.52},p);
  assert.ok(d > 95, `expected >95m, got ${d}`);
  assert.ok(d < 105, `expected <105m, got ${d}`);
});

test("confidence: drops with poor inputs", () => {
  const high = calculateConfidence({gnssQuality:1,freshness:1,sensorAgreement:1,mapMatchQuality:1,routeConsistency:1});
  const low = calculateConfidence({gnssQuality:0,freshness:0,sensorAgreement:0,mapMatchQuality:0,routeConsistency:0});
  assert.equal(high.band, "HIGH");
  assert.equal(low.band, "UNKNOWN");
});

test("geodesy: destinationPoint + haversineMeters round-trip is consistent", () => {
  const origin = {lat:50.45,lon:30.52};
  const dest = destinationPoint(origin, 45, 500);
  const d = haversineMeters(origin, dest);
  assert.ok(Math.abs(d-500) < 1, `expected ~500m, got ${d}`);
});
