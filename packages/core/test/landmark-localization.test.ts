// Localization from what the driver sees — spec scenarios A–E
// (docs/NAVIA_MASTER_SPEC.md §65) on RECORDED REAL map data: OpenStreetMap
// features and junctions from the OpenFreeMap tiles and real Valhalla routes
// (fixtures/osm-*.json, see their `source` block; recorded by
// scripts/fixtures/record-landmark-fixtures.ts). No invented places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { locateByDescription, nameMatch, featureCategories, type MapFeature, type LocateRequest } from "../src/landmark-localizer";
import { NavigationEngine } from "../src/navigation-engine";
import { haversineMeters, destinationPoint, initialBearing } from "../src/geodesy";
import type { Route, RoutingProvider } from "../src/route-engine";
import type { LatLon } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
type Fixture = { source: Record<string, string>; features: MapFeature[]; junctions: LatLon[]; routes: { name: string; route: Route }[] };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(here, "fixtures", `osm-${name}.json`), "utf8"));
const METRO = load("kyiv-kharkivska-pozniaky");
const FORA = load("kyiv-two-fora");

/** A point on the route `progressM` metres from its start. */
function along(route: Route, progressM: number): LatLon {
  let acc = 0;
  const g = route.geometry;
  for (let i = 1; i < g.length; i++) {
    const seg = haversineMeters(g[i - 1]!, g[i]!);
    if (acc + seg >= progressM) return destinationPoint(g[i - 1]!, initialBearing(g[i - 1]!, g[i]!), progressM - acc);
    acc += seg;
  }
  return g[g.length - 1]!;
}
function progressOf(route: Route, p: LatLon): number {
  let best = { d: Infinity, at: 0 };
  for (let m = 0; m < route.distanceM; m += 10) { const d = haversineMeters(along(route, m), p); if (d < best.d) best = { d, at: m }; }
  return best.at;
}
const find = (fx: Fixture, pred: (f: MapFeature) => boolean) => fx.features.filter(pred);
const dnipro = (fx: Fixture) => find(fx, (f) => !!f.name && /dnipro|дніпро/i.test(f.name) && featureCategories(f).includes("shop"));
const station = (fx: Fixture, name: string) => find(fx, (f) => featureCategories(f).includes("metro") && f.name === name)[0]!;

const metroRoute = METRO.routes[0]!.route;
const kharkivska = station(METRO, "Харківська");
const pozniaky = station(METRO, "Позняки");
const dniproAtKharkivska = dnipro(METRO).sort((a, b) => haversineMeters(a.location, kharkivska.location) - haversineMeters(b.location, kharkivska.location))[0]!;

const metroAndDnipro = (variant: string): LocateRequest["objects"] => [
  { category: "metro" },
  { category: "shop", name_variants: [variant], relation: "opposite", of: 0 },
];

test("fixtures are real recorded OSM data with provenance", () => {
  for (const fx of [METRO, FORA]) {
    assert.match(fx.source.license!, /OpenStreetMap contributors, ODbL/);
    assert.match(fx.source.features!, /OpenFreeMap/);
    assert.ok(fx.features.length > 400 && fx.junctions.length > 100);
  }
  assert.ok(kharkivska && pozniaky, "both metro stations are in the data");
  assert.ok(haversineMeters(kharkivska.location, pozniaky.location) > 1200);
});

test("names match across Ukrainian, Russian, Latin, typos", () => {
  assert.ok(nameMatch("Днипро-М", "Dnipro-M") >= 0.9);
  assert.ok(nameMatch("Дніпро М", "Фірмовий магазин Dnipro-M") >= 0.9);
  assert.ok(nameMatch("Фора", "Fora") >= 0.9);
  assert.ok(nameMatch("Харьковская", "Харківська") >= 0.55);
  assert.ok(nameMatch("Позняки", "Pozniaky") >= 0.55);
  assert.ok(nameMatch("Фора", "Платформа") < 0.55, "no match inside another word");
  assert.ok(nameMatch("Сільпо", "Фора") < 0.55);
});

test("B: metro + Dnipro-M opposite, estimate near Kharkivska → one place, the right one", () => {
  // GNSS lost ~35 s ago; the estimate is ~250 m behind the real position along the route.
  const truthM = progressOf(metroRoute, dniproAtKharkivska.location);
  for (const variant of ["Днипро-М", "Дніпро-М", "Dnipro M", "днипро м"]) {
    const r = locateByDescription({ objects: metroAndDnipro(variant), estimate: { location: along(metroRoute, truthM - 250), sigmaM: 250 }, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
    assert.equal(r.status, "unique", `${variant}: ${r.status} ${JSON.stringify(r.candidates.map((c) => c.matched))}`);
    const best = r.candidates[0]!;
    assert.ok(haversineMeters(best.location, kharkivska.location) < 120, `${variant}: ${Math.round(haversineMeters(best.location, kharkivska.location))} m from Kharkivska`);
    assert.ok(best.matched.every((m) => m.category === "metro" || /dnipro|дніпро/i.test(m.name ?? "")), "only real matched features");
  }
});

test("B: estimate between the stations with large σ → ambiguous, a distinguishing question, no pick", () => {
  const mid = along(metroRoute, (progressOf(metroRoute, kharkivska.location) + progressOf(metroRoute, pozniaky.location)) / 2);
  const r = locateByDescription({ objects: metroAndDnipro("Дніпро-М"), estimate: { location: mid, sigmaM: 900 }, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  assert.equal(r.status, "ambiguous");
  const near = (c: { location: LatLon }, s: MapFeature) => haversineMeters(c.location, s.location) < 150;
  assert.ok(r.candidates.some((c) => near(c, kharkivska)) && r.candidates.some((c) => near(c, pozniaky)), "both real places are candidates");
  assert.equal(r.candidates.length, 2, "two places, not one per metro entrance");
  // Both have shops, pharmacies, stops around them: the station name is what tells them apart.
  assert.deepEqual(r.hint && r.hint.kind === "name" ? r.hint.options.map((o) => o.name).sort() : r.hint, ["Позняки", "Харківська"]);
});

test("A: two Fora stores on the route → ambiguous with a hint; the side of the road settles it", () => {
  const route = FORA.routes[0]!.route;
  const foras = find(FORA, (f) => !!f.name && nameMatch("Фора", f.name) >= 0.9);
  assert.ok(foras.length >= 2, "real data has several Fora stores here");
  const mid = along(route, route.distanceM / 2);
  const base: LocateRequest = { objects: [{ category: "supermarket", name_variants: ["Фора", "Fora"] }], estimate: { location: mid, sigmaM: 300 }, route: route.geometry, features: FORA.features, junctions: FORA.junctions };
  const r = locateByDescription(base);
  assert.equal(r.status, "ambiguous", JSON.stringify(r.candidates.map((c) => [c.id, c.distanceFromEstimateM, c.side])));
  assert.ok(r.candidates.length >= 2);
  assert.ok(r.hint, "a distinguishing question is offered");
  // Answering the hint makes it unique when the candidates differ on it.
  if (r.hint!.kind === "side") {
    const pick = r.hint!.options[0]!;
    const again = locateByDescription({ ...base, objects: [{ ...base.objects[0]!, side: pick.side }] });
    const left = again.candidates.filter((c) => c.contradictions.length === 0);
    assert.ok(left.length < r.candidates.length, "the answer removes at least one candidate");
  }
});

test("C: a contradiction (map has it on the other side) is reported and blocks a confident pick", () => {
  const truthM = progressOf(metroRoute, dniproAtKharkivska.location);
  const est = { location: along(metroRoute, truthM - 150), sigmaM: 200 };
  const shop = { category: "shop" as const, name_variants: ["Дніпро-М"] };
  const ok = locateByDescription({ objects: [shop], estimate: est, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  const side = ok.candidates[0]!.side!;
  assert.ok(side === "left" || side === "right");
  const wrong = side === "left" ? "right" : "left";
  const r = locateByDescription({ objects: [{ ...shop, side: wrong }], estimate: est, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  assert.notEqual(r.status, "unique");
  assert.ok(r.candidates.find((c) => haversineMeters(c.location, dniproAtKharkivska.location) < 50)!.contradictions.length > 0);
});

test("D: a landmark that is not in the data → none, nothing invented", () => {
  assert.equal(METRO.features.filter((f) => f.name && nameMatch("IKEA", f.name) >= 0.55).length, 0, "precondition: no IKEA in the data");
  const r = locateByDescription({ objects: [{ category: "shop", name_variants: ["IKEA", "Ікеа"] }], estimate: { location: kharkivska.location, sigmaM: 400 }, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  assert.equal(r.status, "none");
  assert.equal(r.candidates.length, 0);
});

test("things the map data cannot show are reported as unsupported, not guessed", () => {
  const r = locateByDescription({ objects: [{ category: "traffic_signals" }], estimate: { location: kharkivska.location, sigmaM: 300 }, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  assert.equal(r.status, "unsupported");
  assert.deepEqual(r.unsupported, ["traffic_signals"]);
});

test("a unique match far outside the estimate is flagged for confirmation", () => {
  const r = locateByDescription({ objects: metroAndDnipro("Дніпро-М"), estimate: { location: along(metroRoute, 500), sigmaM: 100 }, route: metroRoute.geometry, features: METRO.features, junctions: METRO.junctions });
  // σ 100 → searched 300 m around a point far from both stations, plus the route corridor.
  for (const c of r.candidates) assert.equal(c.farFromEstimate, c.distanceFromEstimateM > 450);
});

// ——— engine: landmark fix, undo, stationary (E) ———

const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("x")), match: () => Promise.reject(new Error("x")), searchAlternatives: () => Promise.reject(new Error("x")) };
const vib = (() => { let s = 7; return (a: number) => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 2 * a; }; })();

function driveThenLoseGps(engine: NavigationEngine, route: Route, t0: number, seconds: number): number {
  let t = t0;
  for (let i = 0; i < seconds; i++, t += 1000) {
    const p = along(route, 400 + i * 12);
    engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 12, headingDeg: null }, t);
    for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.6), accelY: vib(0.6), accelZ: -9.81 + vib(0.8), gyroX: vib(0.02), gyroY: vib(0.02), gyroZ: vib(0.02) });
    engine.tick(t);
  }
  return t;
}

test("landmark fix moves the estimate to the landmark; undo puts it back", () => {
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(metroRoute);
  let t = driveThenLoseGps(engine, metroRoute, 1_000_000, 30);
  // GNSS gone for 40 s while moving.
  for (let i = 0; i < 40; i++, t += 1000) {
    for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.6), accelY: vib(0.6), accelZ: -9.81 + vib(0.8), gyroX: vib(0.02), gyroY: vib(0.02), gyroZ: vib(0.02) });
    engine.tick(t);
  }
  const before = engine.tick(t);
  assert.equal(before.positionMode, "DEAD_RECKONING");
  const r = engine.applyLandmarkFix(dniproAtKharkivska.location, 40, t);
  assert.equal(r.applied, true, JSON.stringify(r));
  const after = engine.tick(t + 100);
  assert.ok(haversineMeters(after.position!.position, dniproAtKharkivska.location) < 80, `${Math.round(haversineMeters(after.position!.position, dniproAtKharkivska.location))} m`);
  assert.equal(after.deadReckoningAnchor?.source, "landmark");
  assert.ok((after.positionUncertaintyM ?? 999) <= 60);
  assert.equal(engine.undoLandmarkFix(t + 200), true);
  const undone = engine.tick(t + 300);
  assert.ok(haversineMeters(undone.position!.position, before.position!.position) < 60, "back to the old estimate");
});

test("a landmark far off the route is not applied (a reroute is needed instead)", () => {
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(metroRoute);
  const far = FORA.features[0]!.location; // another district
  const r = engine.applyLandmarkFix(far, 40, 2_000_000);
  assert.equal(r.applied, false);
  assert.equal(r.reason, "off_route");
});

test("E: GNSS lost and the car stands still → the estimate stops advancing", () => {
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(metroRoute);
  let t = driveThenLoseGps(engine, metroRoute, 3_000_000, 30);
  // Stopped: only sensor noise, no road vibration.
  const still = () => { for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.01), accelY: vib(0.01), accelZ: -9.81 + vib(0.01), gyroX: 0, gyroY: 0, gyroZ: 0 }); };
  for (let i = 0; i < 15; i++, t += 1000) { still(); engine.tick(t); }
  const a = engine.tick(t).routeProgressM;
  for (let i = 0; i < 60; i++, t += 1000) { still(); engine.tick(t); }
  const b = engine.tick(t).routeProgressM;
  assert.ok(Math.abs(b - a) < 5, `advanced ${Math.round(b - a)} m while standing`);
});
