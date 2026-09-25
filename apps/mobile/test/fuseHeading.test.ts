import test from "node:test";
import assert from "node:assert/strict";
import { fuseHeading } from "../src/sensors/fuseHeading";

const base = { compassDeg: 90, compassAt: 1000, compassAccuracyDeg: 10, courseDeg: 200, speedMps: 0, nowMs: 1100 };

test("standing or walking: the compass, not the GPS course", () => {
  assert.deepEqual(fuseHeading({ ...base, speedMps: 0 }), { deg: 90, source: "compass" });
  assert.deepEqual(fuseHeading({ ...base, speedMps: 1.4 }), { deg: 90, source: "compass" });
});

test("driving: the GPS course (phone mount angle doesn't matter)", () => {
  assert.deepEqual(fuseHeading({ ...base, speedMps: 12 }), { deg: 200, source: "course" });
});

test("stale or badly calibrated compass is not used", () => {
  assert.equal(fuseHeading({ ...base, nowMs: 5000 }).source, null);
  assert.equal(fuseHeading({ ...base, compassAccuracyDeg: 80 }).source, null);
  assert.equal(fuseHeading({ ...base, compassAccuracyDeg: -1 }).source, "compass", "unknown accuracy is still usable");
});

test("no compass (simulator) and slow: no heading rather than a wandering GPS course", () => {
  assert.deepEqual(fuseHeading({ ...base, compassDeg: null, compassAt: null, speedMps: 1 }), { deg: null, source: null });
});
