// Turn direction must match the real geometry: heading east and then south is
// a RIGHT turn (clockwise), heading south and then east is a LEFT turn.
// Coordinates are real Kyiv points (Maidan area, streets laid out as a grid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoRoutingProvider, type DemoRoadGraph } from "../src/demo-routing-provider";
import { signedTurnDeg } from "../src/geodesy";

// A (Maidan) → east → B → south → C → east → D → south → E
const lShape: DemoRoadGraph = {
  nodes: [
    { id: "A", position: { lat: 50.4501, lon: 30.5234 } },
    { id: "B", position: { lat: 50.4501, lon: 30.5300 } },
    { id: "C", position: { lat: 50.4470, lon: 30.5300 } },
    { id: "D", position: { lat: 50.4470, lon: 30.5366 } },
    { id: "E", position: { lat: 50.4430, lon: 30.5366 } },
  ],
  edges: [
    { id: "AB", fromId: "A", toId: "B", roadName: "вул. Хрещатик" },
    { id: "BC", fromId: "B", toId: "C", roadName: "вул. Прорізна" },
    { id: "CD", fromId: "C", toId: "D", roadName: "вул. Шевченка" },
    { id: "DE", fromId: "D", toId: "E", roadName: "вул. Грушевського" },
  ],
};

test("signedTurnDeg: clockwise (right) is positive, counter-clockwise (left) is negative", () => {
  assert.equal(signedTurnDeg(90, 180), 90, "east → south is a right turn");
  assert.equal(signedTurnDeg(180, 90), -90, "south → east is a left turn");
  assert.equal(signedTurnDeg(350, 20), 30, "across north, still to the right");
  assert.equal(signedTurnDeg(20, 350), -30, "across north, to the left");
  assert.equal(Math.abs(signedTurnDeg(90, 270)), 180, "reversal");
});

test("demo routing: a known right turn is 'right' and a known left turn is 'left'", async () => {
  const route = await new DemoRoutingProvider(lShape).route({ origin: lShape.nodes[0]!.position, destination: lShape.nodes[4]!.position });
  const maneuvers = route.steps.map((s) => s.maneuver);
  assert.deepEqual(maneuvers, ["depart", "right", "left", "right", "arrive"],
    "east→south = right (at B), south→east = left (at C), east→south = right (at D)");
});

test("demo routing: a reversal is a U-turn, a slight bend is straight", async () => {
  const graph: DemoRoadGraph = {
    nodes: [
      { id: "A", position: { lat: 50.4501, lon: 30.5234 } },
      { id: "B", position: { lat: 50.4501, lon: 30.5300 } },
      { id: "C", position: { lat: 50.45013, lon: 30.5234 } },
      { id: "D", position: { lat: 50.4502, lon: 30.5400 } },
    ],
    edges: [
      { id: "AB", fromId: "A", toId: "B", roadName: "a" },
      { id: "BC", fromId: "B", toId: "C", roadName: "b" },
      { id: "BD", fromId: "B", toId: "D", roadName: "c" },
    ],
  };
  const back = await new DemoRoutingProvider(graph).route({ origin: graph.nodes[0]!.position, destination: graph.nodes[2]!.position });
  assert.equal(back.steps[1]!.maneuver, "uturn");
  const on = await new DemoRoutingProvider(graph).route({ origin: graph.nodes[0]!.position, destination: graph.nodes[3]!.position });
  assert.equal(on.steps[1]!.maneuver, "straight");
});
