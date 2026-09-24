import test from "node:test";
import assert from "node:assert/strict";
import { buildCopilotState } from "../src/ai/copilotState";

test("co-pilot state never carries coordinates", () => {
  const input = {
    lang: "uk" as const,
    gnss: "NORMAL",
    confidenceBand: "HIGH",
    destinationLabel: "Хрещатик, 22",
    nextStep: { maneuver: "right", roadName: "вулиця Шевченка", location: { lat: 50.45, lon: 30.52 } },
    nextStepDistanceM: 312.4,
    alert: { active: false, locationLabel: "Печерський район", since: 0 },
    places: [{ name: "Укриття", category: "shelter", distanceM: 120.6, location: { lat: 50.4, lon: 30.5 } }],
  };
  const json = JSON.stringify(buildCopilotState(input));
  assert.doesNotMatch(json, /lat|lon|50\.4|30\.5/);
  assert.match(json, /вулиця Шевченка/);
  assert.match(json, /"distanceM":312/);
});

test("unknown GNSS/confidence values degrade to the cautious state", () => {
  const s = buildCopilotState({ lang: "en", gnss: "weird", confidenceBand: "??" });
  assert.equal(s.gnss, "LOST");
  assert.equal(s.confidence, "UNKNOWN");
});
