// Strict radius search: inside → in, outside → out, exactly on the circle → in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { POIEngine, searchByRadius } from "../src/poi-engine";
import { destinationPoint, haversineMeters } from "../src/geodesy";

const center = { lat: 50.4501, lon: 30.5234 }; // Maidan, Kyiv
const at = (bearing: number, m: number) => destinationPoint(center, bearing, m);

const items = [
  { id: "in-100", category: "shelter", location: at(10, 100) },
  { id: "in-999", category: "shelter", location: at(80, 999) },
  { id: "edge", category: "shelter", location: at(200, 1000) },
  { id: "out-1001", category: "shelter", location: at(300, 1001) },
  { id: "far", category: "shelter", location: at(45, 5000) },
  { id: "fuel-500", category: "fuel", location: at(120, 500) },
];

test("searchByRadius: points inside are found, points outside are not", () => {
  const r = searchByRadius(items, center, 1000, "shelter").map((x) => x.id);
  assert.deepEqual(r, ["in-100", "in-999", "edge"]);
  assert.ok(!r.includes("out-1001") && !r.includes("far"));
});

test("searchByRadius: a point exactly on the circle is inside (boundary inclusive)", () => {
  const edge = items.find((x) => x.id === "edge")!;
  const d = haversineMeters(center, edge.location);
  assert.ok(Math.abs(d - 1000) < 1e-6, `edge is at ${d} m`);
  assert.ok(searchByRadius([edge], center, 1000).length === 1);
  assert.ok(searchByRadius([edge], center, 999.99).length === 0);
});

test("searchByRadius: works for any category and without one; nearest first with distances", () => {
  assert.deepEqual(searchByRadius(items, center, 1000, "fuel").map((x) => x.id), ["fuel-500"]);
  const all = searchByRadius(items, center, 1000);
  assert.deepEqual(all.map((x) => x.id), ["in-100", "fuel-500", "in-999", "edge"]);
  assert.ok(all.every((x, i) => i === 0 || all[i - 1]!.distanceM <= x.distanceM));
  assert.ok(Math.abs(all[1]!.distanceM - 500) < 0.01);
});

test("searchByRadius: radius 0 and invalid radius", () => {
  assert.deepEqual(searchByRadius([{ id: "here", category: "x", location: center }], center, 0).map((x) => x.id), ["here"]);
  assert.throws(() => searchByRadius(items, center, -1));
  assert.throws(() => searchByRadius(items, center, Number.NaN));
});

test("POIEngine.searchByRadius uses the same strict rule", () => {
  const engine = new POIEngine();
  engine.load([
    { id: "a", name: "ОККО", category: "fuel", location: at(0, 300) },
    { id: "b", name: "WOG", category: "fuel", location: at(0, 1200) },
    { id: "c", name: "Аптека", category: "pharmacy", location: at(90, 200) },
  ]);
  assert.deepEqual(engine.searchByRadius(center, 1000, "fuel").map((p) => p.id), ["a"]);
  assert.deepEqual(engine.near(center, 1000).map((p) => p.id), ["c", "a"]);
});
