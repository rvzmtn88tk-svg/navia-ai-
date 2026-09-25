// Real Valhalla response (recorded 2026-09-25 from valhalla1.openstreetmap.de,
// Kyiv: Золоті ворота → Лук'янівська). Checks, on real data, that every
// maneuver's left/right matches the geometry Valhalla itself reports
// (bearing_before → bearing_after), and that the navigation engine shows the
// right maneuver as "next" just before each known turn.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RouteProgressEngine, positionAtDistance, signedTurnDeg } from "@navia/core";
import { mapManeuverType, valhallaLegToRoute, type ValhallaLeg } from "../src/providers/OnlineValhallaProvider";
import { instructionPhrase } from "../src/voice/guidance";

const json = JSON.parse(readFileSync(join(__dirname, "fixtures/valhalla-kyiv-zoloti-vorota-lukianivska.json"), "utf8")) as {
  trip: { legs: ValhallaLeg[]; summary: { length: number; time: number } };
};
const leg = json.trip.legs[0]!;
const route = valhallaLegToRoute(leg, json.trip.summary, "fixture");

function side(m: string): "left" | "right" | null {
  if (/left/.test(m)) return "left";
  if (/right/.test(m)) return "right";
  return null;
}

test("Valhalla (real Kyiv route): mapped left/right agrees with the geometry of every turn", () => {
  let checked = 0;
  for (const [i, raw] of leg.maneuvers.entries()) {
    const mapped = mapManeuverType(raw.type);
    const s = side(mapped);
    if (!s || raw.bearing_before == null || raw.bearing_after == null) continue;
    const turn = signedTurnDeg(raw.bearing_before, raw.bearing_after);
    assert.equal(turn > 0 ? "right" : "left", s, `maneuver ${i} (${raw.instruction}) is ${mapped} but turns ${turn.toFixed(0)}°`);
    checked++;
  }
  assert.ok(checked >= 8, `checked ${checked} real turns`);
});

test("Valhalla (real Kyiv route): known turns — right onto Ярославів Вал, then left onto Золотоворітська", () => {
  assert.equal(route.steps[1]!.maneuver, "right");
  assert.equal(route.steps[1]!.roadName, "вулиця Ярославів Вал");
  assert.equal(route.steps[2]!.maneuver, "left");
  assert.equal(route.steps[2]!.roadName, "Золотоворітська вулиця");
});

test("navigation engine: 60 m before each real turn the HUD's next maneuver is that turn, with the right words", () => {
  const engine = new RouteProgressEngine();
  let cum = 0;
  const legStarts = route.steps.map((s) => { const at = cum; cum += s.distanceM; return at; });
  for (const i of [1, 2, 3, 4, 7, 8]) {
    const step = route.steps[i]!;
    const before = positionAtDistance(route.geometry, Math.max(0, legStarts[i]! - 60));
    const progress = engine.computeProgress(route, before, 10);
    assert.equal(progress.nextStep?.id, step.id, `before maneuver ${i} the next step must be maneuver ${i}`);
    assert.equal(progress.nextStep?.maneuver, step.maneuver);
    const phrase = instructionPhrase(progress.nextStep!, progress.nextStepDistanceM, "uk");
    assert.match(phrase, step.maneuver === "right" ? /праворуч/ : /ліворуч/, phrase);
  }
});
