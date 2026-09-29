// TripPlanner + multi-stop / preference-aware routing + engines adopting a new route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TripPlanner, orderStopsAlongRoute } from "../src/trip-planner";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { DemoEngine } from "../src/demo-engine";
import { RouteGeometryIndex } from "../src/route-geometry";
import { DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_ROUTE_POIS, demoPointAlongRoad } from "../src/demo-data";

const provider = new DemoRoutingProvider(DEMO_KYIV_TO_BORYSPIL_GRAPH);
const mcd = DEMO_ROUTE_POIS.find((p) => p.id === "demo-ff-mcd-1")!; // 14 km along, 700 m off the road

test("DemoRoutingProvider: a waypoint off the road is reached via an access spur, and the route passes through it", async () => {
  const direct = await provider.route({ origin: DEMO_ORIGIN, destination: DEMO_DESTINATION });
  const via = await provider.route({ origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, waypoints: [mcd.location] });
  const pass = new RouteGeometryIndex(via.geometry).project(mcd.location)!;
  assert.ok(pass.offsetM < 1, `route must pass the stop, offset ${pass.offsetM}`);
  // Detour = drive 700 m to the stop and 700 m back at access-road speed.
  const extraS = via.durationS - direct.durationS;
  assert.ok(Math.abs(extraS - 1400 / 8.3) < 2, `extra ${extraS}s`);
  assert.ok(Math.abs(via.distanceM - direct.distanceM - 1400) < 2);
  assert.equal(via.waypointCount, 1);
  assert.ok(via.steps.some((s) => s.maneuver === "arrive" && s.distanceM === 0 && s !== via.steps[via.steps.length - 1]), "stop is announced as an arrival");
  // Step distances still add up to the route distance (RouteProgressEngine relies on it).
  const sum = via.steps.reduce((a, s) => a + s.distanceM, 0);
  assert.ok(Math.abs(sum - via.distanceM) < 1);
});

test("DemoRoutingProvider: an origin mid-edge starts the route where the car is (not at the previous node)", async () => {
  const mid = demoPointAlongRoad(15_000, 0);
  const r = await provider.route({ origin: mid, destination: DEMO_DESTINATION });
  assert.ok(Math.abs(r.distanceM - (33_494 - 15_000)) < 60, `remaining distance ${r.distanceM}`);
});

test("DemoRoutingProvider: road-type preferences are reported unsupported (demo graph has no road attributes)", async () => {
  const r = await provider.route({ origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, preferences: { avoidUnpaved: true, avoidTolls: true } });
  assert.deepEqual(r.unsupportedPreferences, ["avoidTolls", "avoidUnpaved"]);
  assert.deepEqual(r.appliedPreferences, []);
});

test("TripPlanner: stops are kept in driving order and preferences merge/clear", async () => {
  const planner = new TripPlanner(provider);
  planner.setDestination({ label: "Бориспіль", location: DEMO_DESTINATION });
  const route = await planner.route(DEMO_ORIGIN);
  const far = planner.addStop({ label: "WOG", location: DEMO_ROUTE_POIS.find((p) => p.id === "demo-fuel-wog-2")!.location }, route);
  const near = planner.addStop({ label: "Aroma Kava", location: DEMO_ROUTE_POIS.find((p) => p.id === "demo-cafe-aroma")!.location }, route);
  assert.deepEqual(planner.getPlan().stops.map((s) => s.id), [near.id, far.id]);
  const req = planner.buildRequest(DEMO_ORIGIN);
  assert.equal(req.waypoints?.length, 2);
  planner.setPreferences({ avoidUnpaved: true });
  planner.setPreferences({ avoidTolls: true });
  planner.setPreferences({ avoidUnpaved: false });
  assert.deepEqual(planner.getPlan().preferences, { avoidTolls: true });
  assert.equal(planner.markVisitedNear(DEMO_ROUTE_POIS.find((p) => p.id === "demo-cafe-aroma")!.location).length, 1);
  assert.deepEqual(planner.getPlan().stops.map((s) => s.id), [far.id]);
  assert.equal(orderStopsAlongRoute([], null).length, 0);
});

test("DemoEngine.applyRoute: the simulated car continues from where it is on the new route", async () => {
  const engine = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION });
  await engine.start();
  for (let i = 0; i < 120; i++) engine.tick(1); // ~1.3 km
  const before = engine.getState().routeProgressM;
  const here = engine.getState().position!.position;
  const via = await engine.getRoutingProvider().route({ origin: here, destination: DEMO_DESTINATION, waypoints: [mcd.location] });
  engine.applyRoute(via);
  engine.tick(1);
  const after = engine.getState();
  assert.equal(engine.getRoute(), via);
  assert.ok(after.routeProgressM < 100, `new route starts at the car: progress ${after.routeProgressM}`);
  assert.ok(before > 1000);
  assert.equal(after.offRoute, false);
});
