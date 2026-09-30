// Co-pilot tools for "GPS is gone — where am I?" on RECORDED REAL map data
// (fixtures/osm-kyiv-kharkivska-pozniaky.json: OpenStreetMap via OpenFreeMap
// tiles + a real Valhalla route along Mykoly Bazhana Ave). The engine is the
// app's NavigationEngine in route dead reckoning, exactly as on the phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { executeCopilotTool, type ToolContext } from "../src/copilot/tool-executor";
import { CopilotSession, EngineCopilotRuntime, EntityRegistry } from "../src/copilot/runtime";
import { buildTripSnapshot } from "../src/copilot/trip-snapshot";
import { TripPlanner } from "../src/trip-planner";
import { NavigationEngine } from "../src/navigation-engine";
import { haversineMeters, destinationPoint, initialBearing } from "../src/geodesy";
import type { Route, RoutingProvider } from "../src/route-engine";
import type { MapFeature } from "../src/landmark-localizer";
import type { LatLon } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(here, "fixtures", "osm-kyiv-kharkivska-pozniaky.json"), "utf8")) as { features: MapFeature[]; junctions: LatLon[]; routes: { route: Route }[] };
const route = FX.routes[0]!.route;
const kharkivska = FX.features.find((f) => f.name === "Харківська" && (f.sub === "subway_entrance" || f.cls === "railway"))!;

function along(progressM: number): LatLon {
  let acc = 0;
  const g = route.geometry;
  for (let i = 1; i < g.length; i++) {
    const seg = haversineMeters(g[i - 1]!, g[i]!);
    if (acc + seg >= progressM) return destinationPoint(g[i - 1]!, initialBearing(g[i - 1]!, g[i]!), progressM - acc);
    acc += seg;
  }
  return g[g.length - 1]!;
}
function progressOf(p: LatLon): number {
  let best = { d: Infinity, at: 0 };
  for (let m = 0; m < route.distanceM; m += 10) { const d = haversineMeters(along(m), p); if (d < best.d) best = { d, at: m }; }
  return best.at;
}

const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("offline")), match: () => Promise.reject(new Error("offline")), searchAlternatives: () => Promise.reject(new Error("offline")) };

/** Drive with GPS to `lostAtM`, then lose GPS and keep moving for `lostS` seconds. */
function setup(lostAtM: number, lostS: number) {
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(route);
  let seed = 11;
  const vib = (a: number) => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * a; };
  const imu = (t: number) => { for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.6), accelY: vib(0.6), accelZ: -9.81 + vib(0.8), gyroX: vib(0.02), gyroY: vib(0.02), gyroZ: vib(0.02) }); };
  let t = 1_700_000_000_000;
  for (let m = lostAtM - 360; m <= lostAtM; m += 12, t += 1000) {
    const p = along(m);
    engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 12, headingDeg: null }, t);
    imu(t);
    engine.tick(t);
  }
  for (let i = 0; i < lostS; i++, t += 1000) { imu(t); engine.tick(t); }
  const now = t;
  const runtime = new EngineCopilotRuntime({
    host: engine, planner: new TripPlanner(noRouting), now: () => new Date(now),
    mapFeatures: async (center, radiusM) => ({
      features: FX.features.filter((f) => haversineMeters(center, f.location) <= radiusM),
      junctions: FX.junctions.filter((j) => haversineMeters(center, j) <= radiusM),
    }),
  });
  const ctx: ToolContext = { runtime, registry: new EntityRegistry(), session: new CopilotSession() };
  ctx.session.beginTurn(0);
  return { engine, ctx, now, run: (name: string, input: Record<string, unknown> = {}) => executeCopilotTool(name, input, ctx) };
}

const metroOppositeDnipro = { objects: [{ category: "metro" }, { category: "shop", name_variants: ["Днипро-М", "Дніпро-М", "Dnipro-M"], relation: "opposite", of: 0 }] };

test("trip_state tells the model GPS is gone, how uncertain, and that it can locate by description", () => {
  const { ctx } = setup(progressOf(kharkivska.location) - 700, 90);
  const snap = buildTripSnapshot(ctx.runtime, ctx.session);
  assert.match(snap, /source=DEAD_RECKONING/);
  assert.match(snap, /locate_by_description=available/);
  assert.doesNotMatch(snap, /next_maneuver: \\w+ .* in \\d+ m$/m, "no exact metres while uncertain");
});

test("metro + Дніпро-М opposite → unique → confirm_position moves the navigator next to Kharkivska", async () => {
  const { engine, run, now } = setup(progressOf(kharkivska.location) - 700, 45);
  const loc = await run("locate_by_description", metroOppositeDnipro);
  assert.equal(loc.isError, false, JSON.stringify(loc.content));
  assert.equal(loc.content.status, "unique", JSON.stringify(loc.content));
  const cands = loc.content.candidates as { id: string; seen: string }[];
  assert.match(cands[0]!.seen, /Харківська/);
  assert.match(cands[0]!.seen, /Dnipro|Дніпро/i);
  assert.ok(!JSON.stringify(loc.content).match(/"lat"|"lon"/), "no coordinates reach the model");
  // One strong nearby match re-localizes at once (no second step needed from the model).
  assert.equal(loc.content.position_fixed, true);
  assert.match(String(loc.content.driver_is_now), /Харківська/);
  const auto = engine.tick(now + 200);
  assert.ok(haversineMeters(auto.position!.position, kharkivska.location) < 120, "placed by locate itself");
  const fix = await run("confirm_position", { candidate_id: cands[0]!.id });
  assert.equal(fix.isError, false, JSON.stringify(fix.content));
  assert.equal(fix.content.status, "done");
  assert.ok(fix.content.next_maneuver, "the next maneuver from there");
  const st = engine.tick(now + 500);
  assert.ok(haversineMeters(st.position!.position, kharkivska.location) < 120, `${Math.round(haversineMeters(st.position!.position, kharkivska.location))} m from Kharkivska`);
  // "No, I'm not there" → back.
  const undo = await run("undo_position_fix");
  assert.equal(undo.content.status, "undone");
});

test("ambiguous (between Pozniaky and Kharkivska, large uncertainty) → confirm is refused until the driver answers", async () => {
  const mid = (progressOf(kharkivska.location) + progressOf(FX.features.find((f) => f.name === "Позняки")!.location)) / 2;
  // 150 s without GPS at 12 m/s: the estimate ends between the stations, ±~250 m.
  const { run } = setup(mid - 1800, 150);
  const loc = await run("locate_by_description", metroOppositeDnipro);
  assert.equal(loc.content.status, "ambiguous", JSON.stringify(loc.content));
  const hint = loc.content.distinguishing_hint as { ask_about: string; options: { candidate: string; name: string }[] };
  assert.equal(hint.ask_about, "which_name");
  assert.deepEqual(hint.options.map((o) => o.name).sort(), ["Позняки", "Харківська"]);
  const refused = await run("confirm_position", { candidate_id: "l1" });
  assert.equal(refused.isError, true);
  assert.equal(refused.content.error, "not_unique");
  // The driver answers the hint: "Харківська".
  const pick = hint.options.find((o) => o.name === "Харківська")!.candidate;
  const ok = await run("confirm_position", { candidate_id: pick, driver_confirmed: true });
  assert.equal(ok.isError, false, JSON.stringify(ok.content));
});

test("an answer given as a new description is combined with the earlier one → one place", async () => {
  const mid = (progressOf(kharkivska.location) + progressOf(FX.features.find((f) => f.name === "Позняки")!.location)) / 2;
  const { run } = setup(mid - 1800, 150);
  assert.equal((await run("locate_by_description", metroOppositeDnipro)).content.status, "ambiguous");
  const again = await run("locate_by_description", { objects: [{ category: "metro", name_variants: ["Харьковская", "Харківська"] }] });
  assert.equal(again.content.status, "unique", JSON.stringify(again.content));
  assert.match((again.content.candidates as { seen: string }[])[0]!.seen, /Харківська/);
  assert.equal((await run("confirm_position", { candidate_id: "l1" })).isError, false);
});

test("nothing like it on the map → none; traffic lights → unsupported; nothing invented", async () => {
  const { run } = setup(progressOf(kharkivska.location) - 500, 45);
  const none = await run("locate_by_description", { objects: [{ category: "shop", name_variants: ["IKEA"] }] });
  assert.equal(none.content.status, "none");
  assert.deepEqual(none.content.candidates, []);
  const lights = await run("locate_by_description", { objects: [{ category: "traffic_signals" }] });
  assert.equal(lights.content.status, "unsupported");
  const refused = await run("confirm_position", { candidate_id: "l1" });
  assert.equal(refused.isError, true);
});

test("with healthy GPS a landmark never overrides it", async () => {
  const { run, engine } = setup(progressOf(kharkivska.location) - 300, 0);
  assert.equal(engine.getState().positionMode, "GNSS");
  const loc = await run("locate_by_description", metroOppositeDnipro);
  const id = (loc.content.candidates as { id: string }[])[0]?.id;
  if (id) {
    const r = await run("confirm_position", { candidate_id: id, driver_confirmed: true });
    assert.equal(r.isError, true);
    assert.equal(r.content.error, "gnss_is_trusted");
  }
});
