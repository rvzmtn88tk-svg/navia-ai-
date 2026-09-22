// Exercises the spec's worked example (section 15): "Я бачу WOG. Це моя
// заправка?" -> confident answer when one clear match, honest "ambiguous"
// when two are similarly relevant, honest "no match" when there's nothing.
import {test} from "node:test";
import assert from "node:assert/strict";
import {DemoRoutingProvider} from "../src/demo-routing-provider";
import {LandmarkEngine, type POI} from "../src/landmark-engine";
import {demoGraph} from "./fixtures/demo-graph";

const provider = new DemoRoutingProvider(demoGraph);
const engine = new LandmarkEngine();

test("landmark query: confirms a single on-route WOG with real distance and the upcoming maneuver", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  // A WOG placed right on the n1->n2 leg, close to the route line.
  const pois: POI[] = [
    {id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.4501, lon: 30.5260}},
  ];
  const start = {lat: 50.4501, lon: 30.5234};
  const result = engine.identifyLandmarkQuery(pois, "WOG", route, start, 10);
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed") {
    assert.ok(result.distanceM > 0);
    assert.match(result.message, /WOG/);
    assert.match(result.message, /метрів/);
  }
});

test("landmark query: says no match when nothing by that name exists", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const result = engine.identifyLandmarkQuery([], "WOG", route, {lat: 50.4501, lon: 30.5234}, 10);
  assert.equal(result.kind, "no_match");
});

test("landmark query: says no match when the named POI exists but is nowhere near the route ahead", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const pois: POI[] = [
    {id: "wog-far", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.60, lon: 30.70}},
  ];
  const result = engine.identifyLandmarkQuery(pois, "WOG", route, {lat: 50.4501, lon: 30.5234}, 10);
  assert.equal(result.kind, "no_match");
});

test("landmark query: says ambiguous when two WOGs are similarly relevant", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const pois: POI[] = [
    {id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.4501, lon: 30.5255}},
    {id: "wog-2", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.4501, lon: 30.5265}},
  ];
  const result = engine.identifyLandmarkQuery(pois, "WOG", route, {lat: 50.4501, lon: 30.5234}, 10);
  assert.equal(result.kind, "ambiguous");
});

test("rankNearby: higher-category-importance POI on the corridor outranks a low-importance one further off it", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const pois: POI[] = [
    {id: "hosp", name: "Лікарня", category: "hospital", location: {lat: 50.4501, lon: 30.5260}},
    {id: "park", name: "Парковка", category: "parking", location: {lat: 50.4501, lon: 30.5261}},
  ];
  const ranked = engine.rankNearby(pois, route, {lat: 50.4501, lon: 30.5234}, 10);
  assert.equal(ranked[0]!.poi.id, "hosp");
});
