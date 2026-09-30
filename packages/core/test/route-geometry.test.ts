// Deterministic route geometry used by the AI co-pilot's tools: projection,
// side of road, time along the route, slicing, detour estimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteGeometryIndex, RouteTimeline, estimateDetourSeconds, samplePolyline } from "../src/route-geometry";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, demoPointAlongRoad } from "../src/demo-data";
import { haversineMeters } from "../src/geodesy";

// A straight west->east line along lat 50.45, ~1.42 km long.
const line = [{ lat: 50.45, lon: 30.50 }, { lat: 50.45, lon: 30.52 }];

test("RouteGeometryIndex: projects a point onto the polyline with along-distance and offset", () => {
  const idx = new RouteGeometryIndex(line);
  assert.ok(Math.abs(idx.lengthM - haversineMeters(line[0]!, line[1]!)) < 5);
  const p = idx.project({ lat: 50.4509, lon: 30.51 })!; // ~100 m north of the midpoint
  assert.ok(Math.abs(p.alongM - idx.lengthM / 2) < 5, `along ${p.alongM}`);
  assert.ok(Math.abs(p.offsetM - 100) < 3, `offset ${p.offsetM}`);
});

test("RouteGeometryIndex: side of road — north of an eastbound road is LEFT, south is RIGHT", () => {
  const idx = new RouteGeometryIndex(line);
  assert.equal(idx.project({ lat: 50.4509, lon: 30.51 })!.side, "left");
  assert.equal(idx.project({ lat: 50.4491, lon: 30.51 })!.side, "right");
  assert.equal(idx.project({ lat: 50.45, lon: 30.51 })!.side, "on_route");
});

test("RouteGeometryIndex: minAlongM restricts projection to the part of the route ahead", () => {
  // A U-shaped route: out east, back west 200 m further north. A point near
  // the start is closest to the first leg, but "ahead only" must pick the return leg.
  const u = [{ lat: 50.45, lon: 30.50 }, { lat: 50.45, lon: 30.52 }, { lat: 50.4518, lon: 30.52 }, { lat: 50.4518, lon: 30.50 }];
  const idx = new RouteGeometryIndex(u);
  const p = { lat: 50.4505, lon: 30.501 };
  assert.ok(idx.project(p)!.alongM < 200);
  assert.ok(idx.project(p, 1500)!.alongM > 1500);
});

test("RouteGeometryIndex: slice/pointAt are consistent with along distances", () => {
  const idx = new RouteGeometryIndex(line);
  const mid = idx.pointAt(idx.lengthM / 2);
  assert.ok(Math.abs(mid.lon - 30.51) < 1e-6);
  const slice = idx.slice(200, 800);
  assert.ok(Math.abs(haversineMeters(slice[0]!, slice[slice.length - 1]!) - 600) < 3);
  assert.equal(samplePolyline(idx, 5).length, 5);
});

test("RouteTimeline: time along the route follows the provider's per-step durations, and inverts", async () => {
  const route = await new DemoRoutingProvider(DEMO_KYIV_TO_BORYSPIL_GRAPH).route({ origin: DEMO_ORIGIN, destination: DEMO_DESTINATION });
  const tl = new RouteTimeline(route);
  assert.equal(tl.secondsAt(0), 0);
  assert.ok(Math.abs(tl.secondsAt(route.distanceM) - route.durationS) < 1e-6);
  const d = tl.distanceAtSeconds(30 * 60);
  assert.ok(Math.abs(tl.secondsAt(d) - 1800) < 1e-6);
  // Demo speed is 11 m/s -> 30 min ≈ 19.8 km.
  assert.ok(Math.abs(d - 19_800) < 50, `distance at 30 min: ${d}`);
});

test("estimateDetourSeconds: out-and-back with road circuity at access-road speed", () => {
  assert.equal(estimateDetourSeconds(0), 0);
  // 500 m off route: 2 * 500 * 1.4 / 8.3 ≈ 169 s
  assert.ok(Math.abs(estimateDetourSeconds(500) - 168.7) < 1);
});

test("demoPointAlongRoad: places points at the requested offset from the demo road", () => {
  const idx = new RouteGeometryIndex(DEMO_KYIV_TO_BORYSPIL_GRAPH.nodes.map((n) => n.position));
  const p = demoPointAlongRoad(14_000, -700);
  const proj = idx.project(p)!;
  assert.ok(Math.abs(proj.offsetM - 700) < 10, `offset ${proj.offsetM}`);
  assert.ok(Math.abs(proj.alongM - 14_000) < 30, `along ${proj.alongM}`);
  assert.equal(proj.side, "left");
});
