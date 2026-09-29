// Co-pilot tools against the real navigation stack (demo road, demo POIs,
// real DemoRoutingProvider). Every number asserted here is what the model
// would be handed — computed, never guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCopilotTool, type ToolContext } from "../src/copilot/tool-executor";
import { CopilotSession, EntityRegistry } from "../src/copilot/runtime";
import { buildTripSnapshot } from "../src/copilot/trip-snapshot";
import { buildWorld, WORLD_SAVED_HOME, type WorldOptions } from "../eval/world";

type Row = Record<string, unknown>;

async function setup(opts: WorldOptions = {}) {
  const world = await buildWorld(opts);
  const ctx: ToolContext = { runtime: world.runtime, registry: new EntityRegistry(), session: new CopilotSession() };
  ctx.session.beginTurn(0);
  const run = (name: string, input: Row = {}) => executeCopilotTool(name, input, ctx);
  return { world, ctx, run };
}

const results = (c: Row) => c.results as Row[];

test("search_along_route: fuel ahead, sorted by routed detour, with ahead km/min and side", async () => {
  const { run } = await setup();
  const out = await run("search_along_route", { categories: ["fuel"], limit: 5 });
  assert.equal(out.isError, false);
  const rows = results(out.content);
  assert.deepEqual(rows.map((r) => r.name), ["WOG", "ОККО", "SOCAR"]);
  assert.ok(rows.every((r) => r.detour === "routed"));
  const wog = rows[0]!, okko = rows[1]!, socar = rows[2]!;
  assert.equal(wog.ahead_km, 16);
  assert.equal(okko.ahead_km, 7);
  assert.equal(okko.ahead_min, 11); // 7 km at the demo provider's 11 m/s
  assert.equal(okko.side, "right");
  assert.equal(socar.side, "left");
  assert.equal(socar.detour_min, 3.6); // 2 x 900 m at 8.3 m/s
  assert.equal(out.content.source, "demo");
  assert.equal(wog.open_now, true);
});

test("search_along_route: 'McDonald's adding at most 10 minutes' keeps only the one within the limit", async () => {
  const { run } = await setup();
  const out = await run("search_along_route", { name_variants: ["McDonald's", "Макдональдз"], categories: ["fast_food"], max_detour_minutes: 10 });
  const rows = results(out.content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "McDonald's");
  assert.equal(rows[0]!.detour_min, 2.8);
  assert.equal(rows[0]!.ahead_km, 12);
  assert.equal(out.content.excluded_by_detour, 1, "the second McDonald's (+10.4 min) is excluded, and the model is told so");
});

test("search_along_route: 'a restaurant in about 30 minutes' uses the route timeline; closed places dropped on request", async () => {
  const { run } = await setup();
  const out = await run("search_along_route", { categories: ["restaurant"], ahead_min_minutes: 20, ahead_max_minutes: 40, open_now_only: true });
  const rows = results(out.content);
  assert.deepEqual(rows.map((r) => r.name), ["Ресторан Козак"]);
  assert.equal(rows[0]!.ahead_min, 27);
  assert.equal(out.content.excluded_closed, 1); // the night grill opens at 20:00
  const searched = out.content.searched as Row;
  assert.equal(searched.from_km_ahead, 13);
  assert.equal(searched.to_km_ahead, 26);
});

test("search_along_route: remaining range marks reachability with a reserve", async () => {
  const { run } = await setup();
  const ok = results((await run("search_along_route", { categories: ["fuel"], vehicle_range_km: 10 })).content);
  assert.deepEqual(ok.map((r) => [r.name, r.reachable]), [["ОККО", true]]);
  const tight = await run("search_along_route", { categories: ["fuel"], vehicle_range_km: 7 });
  const rows = results(tight.content);
  assert.ok(rows.every((r) => r.reachable === false), "OKKO at 7.2 km is beyond 85% of a 7 km range");
  assert.match(String(tight.content.range_reserve), /85%/);
});

test("search_near: parking around the destination with walking minutes, radius respected", async () => {
  const { run } = await setup();
  const out = await run("search_near", { anchor: "destination", categories: ["parking"] });
  const rows = results(out.content);
  assert.deepEqual(rows.map((r) => [r.name, r.distance_m, r.walk_min]), [["Паркінг Бориспіль-центр", 250, 3], ["Паркінг ТРЦ", 600, 8]]);
  assert.equal(out.content.anchor, "Бориспіль");
});

test("place data failures are explicit errors, never an empty list; no results is a real empty result", async () => {
  assert.equal((await (await setup({ places: "none" })).run("search_along_route", { categories: ["fuel"] })).content.error, "place_search_unavailable");
  const failing = await (await setup({ places: "failing" })).run("search_near", { anchor: "destination", categories: ["parking"] });
  assert.equal(failing.isError, true);
  assert.match(String(failing.content.message), /504/);
  const empty = await (await setup({ places: "empty" })).run("search_along_route", { categories: ["fuel"] });
  assert.equal(empty.isError, false);
  assert.equal(empty.content.found_total, 0);
  assert.deepEqual(results(empty.content), []);
  const noRoute = await (await setup({ noRoute: true })).run("search_along_route", { categories: ["fuel"] });
  assert.equal(noRoute.content.error, "no_active_route");
});

test("search_along_route: window beyond the end of the route is reported, not silently empty", async () => {
  const { run } = await setup({ alongM: 30_000 });
  const out = await run("search_along_route", { categories: ["restaurant"], ahead_min_minutes: 30 });
  assert.match(String(out.content.note), /window is empty/);
});

test("get_route_overview: real remaining/arrival; maneuver distances withheld under LOW confidence", async () => {
  const high = await (await setup()).run("get_route_overview");
  assert.equal(high.content.remaining_km, 31);
  assert.equal(high.content.remaining_min, 48);
  assert.equal(high.content.arrival, "14:48");
  const next = high.content.next_maneuvers as Row[];
  assert.equal(typeof next[0]!.in_m, "number");
  assert.equal((high.content.main_roads_ahead as Row[])[0]!.road, "Бориспільське шосе");
  const low = await (await setup({ band: "LOW" })).run("get_route_overview");
  assert.match(String((low.content.next_maneuvers as Row[])[0]!.in_m), /withheld/);
  assert.equal(low.content.position_uncertain, true);
});

test("compare_routes: no fake alternative when the router has none; traffic honestly unavailable", async () => {
  const { run } = await setup();
  const cmp = await run("compare_routes");
  assert.deepEqual(cmp.content.alternatives, []);
  assert.match(String(cmp.content.note), /no meaningfully different alternative/);
  const traffic = await run("get_traffic_ahead");
  assert.equal(traffic.content.available, false);
});

test("add_stop: proposes first, cannot self-confirm in the same turn, executes after the driver's next message", async () => {
  const { world, ctx, run } = await setup();
  const found = results((await run("search_along_route", { categories: ["cafe"] })).content);
  const id = String(found[0]!.id);
  const p1 = await run("add_stop", { place_id: id });
  assert.equal(p1.content.status, "awaiting_user_confirmation");
  assert.equal(p1.content.added_min, 0.3);
  const p2 = await run("add_stop", { place_id: id }); // model tries to confirm itself, same turn
  assert.equal(p2.content.status, "awaiting_user_confirmation");
  assert.equal(world.host.route!.waypointCount ?? 0, 0, "route untouched before confirmation");
  ctx.session.beginTurn(1); // the driver answered
  const done = await run("add_stop", { place_id: id });
  assert.equal(done.content.status, "done");
  assert.equal(world.host.route!.waypointCount, 1);
  assert.equal(world.planner.getPlan().stops[0]!.label, "Aroma Kava");
  assert.equal(ctx.session.pending, null);
});

test("add_stop: a different target than the one proposed is a new proposal, not a confirmation", async () => {
  const { world, ctx, run } = await setup();
  const found = results((await run("search_along_route", { categories: ["fuel"] })).content);
  await run("add_stop", { place_id: String(found[0]!.id) });
  ctx.session.beginTurn(1);
  const other = await run("add_stop", { place_id: String(found[1]!.id) });
  assert.equal(other.content.status, "awaiting_user_confirmation");
  assert.equal(world.host.route!.waypointCount ?? 0, 0);
});

test("actions reject ids the model made up", async () => {
  const { run } = await setup();
  assert.equal((await run("add_stop", { place_id: "p99" })).content.error, "unknown_place_id");
  assert.equal((await run("switch_route", { route_id: "r7" })).content.error, "unknown_route_id");
  assert.equal((await run("remove_stop", { stop_id: "s3" })).content.error, "unknown_stop_id");
  assert.equal((await run("definitely_not_a_tool")).content.error, "unknown_tool");
});

test("set_route_preferences: unsupported by the demo router -> route unchanged and said so; routing outage -> reverted", async () => {
  const { world, run } = await setup();
  const before = world.host.route;
  const out = await run("set_route_preferences", { avoid_unpaved: true });
  assert.equal(out.content.status, "not_supported");
  assert.equal(world.host.route, before);
  assert.deepEqual(world.planner.getPlan().preferences, {});

  const down = await setup({ routingFails: true });
  const failed = await down.run("set_route_preferences", { avoid_tolls: true });
  assert.equal(failed.content.error, "routing_failed");
  assert.deepEqual(down.world.planner.getPlan().preferences, {});
});

test("add_stop during a routing outage: the stop is not left half-added", async () => {
  const { world, ctx, run } = await setup();
  const id = String(results((await run("search_along_route", { categories: ["cafe"] })).content)[0]!.id);
  await run("add_stop", { place_id: id });
  ctx.session.beginTurn(1);
  world.routing.failing = true;
  const out = await run("add_stop", { place_id: id });
  assert.equal(out.content.error, "routing_failed");
  assert.deepEqual(world.planner.getPlan().stops, []);
});

test("find_destination: saved home, missing home, and address search", async () => {
  const missing = await (await setup()).run("find_destination", { saved_place: "home" });
  assert.equal(missing.content.found, false);
  const withHome = await (await setup({ savedPlaces: [WORLD_SAVED_HOME] })).run("find_destination", { saved_place: "home" });
  assert.equal((withHome.content.candidates as Row[])[0]!.label, WORLD_SAVED_HOME.label);
  const q = await (await setup()).run("find_destination", { query: "Бровари" });
  assert.equal((q.content.candidates as Row[])[0]!.label, "Бровари, центр");
});

test("check_landmark: confirms the WOG ahead from map data, hedges under low confidence", async () => {
  const high = await (await setup({ alongM: 17_700 })).run("check_landmark", { name_variants: ["WOG"] });
  assert.equal(high.content.result, "confirmed");
  assert.equal(high.content.ahead_m, 300);
  const low = await (await setup({ alongM: 17_700, band: "LOW" })).run("check_landmark", { name_variants: ["WOG"] });
  assert.equal(low.content.result, "likely_but_position_uncertain");
  const none = await (await setup({ alongM: 17_700 })).run("check_landmark", { name_variants: ["KLO"] });
  assert.equal(none.content.result, "no_match");
});

test("trip_state snapshot: compact, factual, no coordinates; withholds maneuver distance under LOW confidence", async () => {
  const { world, ctx } = await setup();
  const snap = buildTripSnapshot(world.runtime, ctx.session);
  assert.match(snap, /remaining: 31 km, 48 min, arrival 14:48/);
  assert.match(snap, /next_maneuver: right onto Бориспільське шосе in 2440 m/);
  assert.match(snap, /traffic=unavailable/);
  assert.doesNotMatch(snap, /\d{2}\.\d{4,}/, "no raw coordinates in the model context");
  assert.ok(snap.length < 900, `snapshot is compact (${snap.length} chars)`);
  const low = await setup({ band: "LOW" });
  assert.match(buildTripSnapshot(low.world.runtime, low.ctx.session), /distance withheld: position uncertain/);
});
