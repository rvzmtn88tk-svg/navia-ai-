import test from "node:test";
import assert from "node:assert/strict";
import { splitRoute } from "../src/map/routeSplit";

const line = [{ lat: 50, lon: 30 }, { lat: 50.001, lon: 30 }, { lat: 50.002, lon: 30 }]; // ~111 m per leg

test("splitRoute: nothing travelled at the start", () => {
  const { traveled, remaining } = splitRoute(line, 0);
  assert.equal(traveled.length, 0);
  assert.equal(remaining.length, 3);
});

test("splitRoute: cuts inside a segment and both parts share the cut point", () => {
  const { traveled, remaining } = splitRoute(line, 55);
  assert.equal(traveled.length, 2);
  assert.deepEqual(traveled[1], remaining[0]);
  assert.ok(Math.abs(traveled[1]!.lat - 50.0005) < 0.00002);
});

test("splitRoute: beyond the end everything is travelled", () => {
  const { traveled, remaining } = splitRoute(line, 10_000);
  assert.equal(traveled.length, 3);
  assert.equal(remaining.length, 0);
});
