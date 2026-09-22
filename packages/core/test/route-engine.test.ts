// Spec section 34/35 require route tests covering: progress, next maneuver,
// arrival. Also exercises DemoRoutingProvider's real Dijkstra search and
// searchAlternatives, since RouteEngine is built directly on those.
import {test} from "node:test";
import assert from "node:assert/strict";
import {DemoRoutingProvider} from "../src/demo-routing-provider";
import {RouteProgressEngine} from "../src/route-engine";
import {demoGraph} from "./fixtures/demo-graph";

const provider = new DemoRoutingProvider(demoGraph);

test("route: finds the real shortest path (n1 -> n2 -> n3 direct, not via n5)", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  assert.equal(route.source, "demo");
  const roadSegmentIds = route.steps.map((s) => s.roadSegmentId);
  assert.deepEqual(roadSegmentIds, ["e-n1-n2", "e-n2-n3", "e-n2-n3"]); // last is the synthetic arrive step, same segment
  assert.equal(route.steps[route.steps.length - 1]!.maneuver, "arrive");
  assert.equal(route.steps[0]!.maneuver, "depart");
  assert.ok(route.distanceM > 0);
});

test("route: throws (does not fake a route) when no path exists", async () => {
  const isolatedGraph = {
    nodes: [{id: "a", position: {lat: 50.5, lon: 30.5}}, {id: "b", position: {lat: 51.5, lon: 31.5}}],
    edges: [],
  };
  const isolatedProvider = new DemoRoutingProvider(isolatedGraph);
  await assert.rejects(() => isolatedProvider.route({origin: {lat: 50.5, lon: 30.5}, destination: {lat: 51.5, lon: 31.5}}));
});

test("route: searchAlternatives excludes the primary route's first edge and finds a genuinely different, longer path", async () => {
  const alts = await provider.searchAlternatives({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  assert.equal(alts.length, 2);
  assert.ok(alts[1]!.distanceM > alts[0]!.distanceM, "the alternative should be longer than the direct route");
  const primarySegIds = new Set(alts[0]!.steps.map((s) => s.roadSegmentId));
  const altSegIds = new Set(alts[1]!.steps.map((s) => s.roadSegmentId));
  // The primary route's first edge (n1->n2) must be genuinely absent from
  // the alternative — that's the real search strategy DemoRoutingProvider
  // uses (exclude-and-re-run-Dijkstra), not a relabeled copy of the primary.
  const primaryFirstEdge = alts[0]!.steps[0]!.roadSegmentId;
  assert.ok(primaryFirstEdge && !altSegIds.has(primaryFirstEdge));
  assert.notDeepEqual([...altSegIds].sort(), [...primarySegIds].sort());
});

test("route: match() snaps traced points to nearest graph nodes", async () => {
  const result = await provider.match([{lat: 50.4502, lon: 30.5301}]);
  assert.equal(result.matchedPoints.length, 1);
  assert.equal(result.roadSegmentIds[0] !== null, true);
});

const progressEngine = new RouteProgressEngine();

test("route progress: partway along the route reports real completed/remaining distances", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  // A point roughly halfway along the n1->n2 leg.
  const midpoint = {lat: 50.4501, lon: 30.5267};
  const progress = progressEngine.computeProgress(route, midpoint, 10);
  assert.ok(progress.distanceCompletedM > 0);
  assert.ok(progress.distanceRemainingM > 0);
  assert.ok(progress.distanceCompletedM + progress.distanceRemainingM <= route.distanceM + 1);
  assert.equal(progress.currentRoadName, "вул. Хрещатик");
  assert.ok(progress.etaSeconds > 0);
  assert.ok(progress.nextStep !== null);
});

test("route progress: at the destination, remaining distance is ~0 and next step is arrival", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const dest = {lat: 50.4501, lon: 30.5366};
  const progress = progressEngine.computeProgress(route, dest, 10);
  assert.ok(progress.distanceRemainingM < 5, `expected ~0 remaining, got ${progress.distanceRemainingM}`);
  assert.equal(progress.nextStep!.maneuver, "arrive");
});

test("route progress: ETA falls back to the route's implied pace when no live speed is available", async () => {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const start = {lat: 50.4501, lon: 30.5234};
  const progress = progressEngine.computeProgress(route, start, null);
  assert.ok(progress.etaSeconds > 0);
  assert.ok(Math.abs(progress.etaSeconds - route.durationS) < 1);
});
