// NAVIA's own "do you see …?" question when the position is uncertain.
import test from "node:test";
import assert from "node:assert/strict";
import { landmarkQuestionText, pickLandmarkQuestion, type LandmarkAskInput } from "../src/navigation/landmarkQuestion";
import type { RouteLandmark } from "../src/navigation/landmarks";

const wog: RouteLandmark = { id: "l1", kind: "fuel", name: "WOG", location: { lat: 50.4, lon: 30.6 }, alongM: 2150, offsetM: 20, side: "right" };
const unnamed: RouteLandmark = { id: "l2", kind: "shop", name: null, location: { lat: 50.4, lon: 30.6 }, alongM: 2100, offsetM: 10, side: "left" };
const base: LandmarkAskInput = { positionMode: "DEAD_RECKONING", uncertaintyM: 200, progressM: 2000, speedMps: 12, nextManeuverInM: 900, landmarks: [wog, unnamed], asked: new Set(), lastAskedAtMs: 0, nowMs: 1_000_000 };

test("asks about a named, visible landmark just ahead while dead reckoning with a wide error", () => {
  assert.equal(pickLandmarkQuestion(base)?.id, "l1");
  assert.equal(landmarkQuestionText(wog, "uk"), "Бачите праворуч АЗС «WOG»? Скажіть «так» або «ні».");
});

test("never with GPS, a tight estimate, right before a maneuver, twice, or too often", () => {
  assert.equal(pickLandmarkQuestion({ ...base, positionMode: "GNSS" }), null);
  assert.equal(pickLandmarkQuestion({ ...base, uncertaintyM: 60 }), null);
  assert.equal(pickLandmarkQuestion({ ...base, nextManeuverInM: 150 }), null, "12 s to the turn: the driver is busy");
  assert.equal(pickLandmarkQuestion({ ...base, asked: new Set(["l1"]) }), null, "the unnamed shop is not asked about");
  assert.equal(pickLandmarkQuestion({ ...base, lastAskedAtMs: base.nowMs - 30_000 }), null);
  assert.equal(pickLandmarkQuestion({ ...base, progressM: 1000 }), null, "too far ahead to see");
});
