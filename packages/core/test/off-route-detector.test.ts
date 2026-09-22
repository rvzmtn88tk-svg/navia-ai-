// Spec section 22: "do not say 'you left the route' after a single 10m
// deviation" — must use a timer/hysteresis, not a single sample.
import {test} from "node:test";
import assert from "node:assert/strict";
import {OffRouteDetector} from "../src/off-route-detector";

test("off-route: a single brief deviation does NOT confirm off-route", () => {
  const detector = new OffRouteDetector({sustainMs: 8000});
  const confirmed = detector.update({distanceFromRouteM: 55, roadMismatch: false, headingMismatchDeg: null, timestamp: 1000});
  assert.equal(confirmed, false);
});

test("off-route: sustained deviation past the dwell time DOES confirm", () => {
  const detector = new OffRouteDetector({sustainMs: 8000, corridorM: 40});
  let confirmed = false;
  for (let t = 0; t <= 9000; t += 1000) {
    confirmed = detector.update({distanceFromRouteM: 100, roadMismatch: false, headingMismatchDeg: null, timestamp: t});
  }
  assert.equal(confirmed, true);
});

test("off-route: a brief return to the route resets the dwell timer", () => {
  const detector = new OffRouteDetector({sustainMs: 8000, corridorM: 40});
  detector.update({distanceFromRouteM: 100, roadMismatch: false, headingMismatchDeg: null, timestamp: 0});
  detector.update({distanceFromRouteM: 100, roadMismatch: false, headingMismatchDeg: null, timestamp: 5000});
  // back on route briefly
  const midConfirmed = detector.update({distanceFromRouteM: 5, roadMismatch: false, headingMismatchDeg: null, timestamp: 6000});
  assert.equal(midConfirmed, false);
  // deviates again — dwell must restart, so 3s later should still be unconfirmed
  const laterConfirmed = detector.update({distanceFromRouteM: 100, roadMismatch: false, headingMismatchDeg: null, timestamp: 9000});
  assert.equal(laterConfirmed, false);
});

test("off-route: a map-matched road mismatch counts even within the distance corridor", () => {
  const detector = new OffRouteDetector({sustainMs: 1000, corridorM: 40});
  detector.update({distanceFromRouteM: 5, roadMismatch: true, headingMismatchDeg: null, timestamp: 0});
  const confirmed = detector.update({distanceFromRouteM: 5, roadMismatch: true, headingMismatchDeg: null, timestamp: 1500});
  assert.equal(confirmed, true);
});
