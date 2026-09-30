// The co-pilot agent loop, driven by a scripted LLM so every path is
// deterministic: multi-step tool use, confirmation over two turns, parallel
// tool calls, model-tier cascade, budgets, outages, refusal, memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NaviaCopilot, toSpeakable } from "../src/copilot/copilot";
import { chooseTier, DEFAULT_ROUTER_POLICY } from "../src/copilot/model-router";
import { DemoEngine } from "../src/demo-engine";
import { TripPlanner } from "../src/trip-planner";
import { EngineCopilotRuntime } from "../src/copilot/runtime";
import { LocalPlaceSearchProvider } from "../src/place-search";
import { DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_ROUTE_POIS } from "../src/demo-data";
import { buildWorld, type WorldOptions } from "../eval/world";
import { ScriptedLLM, type ScriptStep } from "./fixtures/scripted-llm";

type Row = Record<string, unknown>;

async function copilotWith(steps: ScriptStep[], world: WorldOptions = {}, extra: { failAtCall?: number; maxLlmCalls?: number; aiEnabled?: boolean } = {}) {
  const w = await buildWorld(world);
  const llm = new ScriptedLLM(steps, extra.failAtCall != null ? { failAtCall: extra.failAtCall } : {});
  const copilot = new NaviaCopilot({
    runtime: w.runtime,
    llm,
    aiEnabled: () => extra.aiEnabled ?? true,
    ...(extra.maxLlmCalls ? { maxLlmCalls: extra.maxLlmCalls } : {}),
  });
  return { copilot, llm, world: w };
}

const firstResultId = (v: { lastToolResults: Row[] }) => String((v.lastToolResults[0]!.results as Row[])[0]!.id);

test("simple question is answered from trip_state alone: one fast call, no tools", async () => {
  const { copilot, llm } = await copilotWith([
    (v) => {
      assert.match(v.tripState, /remaining: 31 km, 48 min/);
      assert.equal(v.userText, "Скільки ще їхати?");
      return { text: "Ще 31 кілометр, приблизно 48 хвилин." };
    },
  ]);
  const reply = await copilot.ask("Скільки ще їхати?");
  assert.equal(reply.mode, "llm");
  assert.equal(reply.text, "Ще 31 кілометр, приблизно 48 хвилин.");
  assert.deepEqual(llm.tiers, ["fast"]);
  assert.equal(reply.trace.length, 0);
});

test("multi-step: McDonald's within +10 min -> propose -> driver says yes -> stop added (two turns)", async () => {
  const { copilot, llm, world } = await copilotWith([
    // Turn 1
    () => ({ tools: [{ name: "search_along_route", input: { name_variants: ["McDonald's", "Макдональдз"], categories: ["fast_food"], max_detour_minutes: 10 } }] }),
    (v) => ({ tools: [{ name: "add_stop", input: { place_id: firstResultId(v) } }] }),
    (v) => {
      assert.equal(v.lastToolResults[0]!.status, "awaiting_user_confirmation");
      return { text: "Є McDonald's через 12 кілометрів, додасть близько 3 хвилин. Додати зупинку?" };
    },
    // Turn 2
    (v) => {
      assert.match(v.tripState, /pending_action: add_stop/);
      assert.match(v.tripState, /last_results \([^)]*\): #1 p1 McDonald's/);
      return { tools: [{ name: "add_stop", input: { place_id: "p1" } }] };
    },
    (v) => {
      assert.equal(v.lastToolResults[0]!.status, "done");
      return { text: `Додала McDonald's. Прибуття о ${String(v.lastToolResults[0]!.arrival)}.` };
    },
  ]);
  const r1 = await copilot.ask("Знайди McDonald's по дорозі, але щоб додав не більше 10 хвилин, і додай його як зупинку");
  assert.deepEqual(r1.pendingAction?.tool, "add_stop");
  assert.equal(world.host.route!.waypointCount ?? 0, 0, "nothing changes before the driver confirms");
  assert.deepEqual(r1.trace.map((t) => t.tool), ["search_along_route", "add_stop"]);
  assert.deepEqual(llm.tiers, ["fast", "fast", "fast"], "search -> propose -> answer stays on the fast tier");

  const r2 = await copilot.ask("Так, додавай");
  assert.equal(r2.pendingAction, null);
  assert.equal(world.host.route!.waypointCount, 1);
  assert.match(r2.text, /Прибуття о 14:5\d/);
  // A "yes" confirmation is a single repeated tool call: fast tier.
  assert.deepEqual(llm.tiers.slice(3), ["fast", "fast"]);
});

test("independent tool calls run in parallel and ALL results return in one user message", async () => {
  const { copilot, llm } = await copilotWith([
    () => ({ tools: [
      { name: "get_route_overview", input: {} },
      { name: "compare_routes", input: {} },
    ] }),
    (v) => {
      assert.equal(v.lastToolResults.length, 2);
      const last = v.request.messages[v.request.messages.length - 1]!;
      assert.equal(last.role, "user");
      return { text: "Це найкоротший маршрут, іншого варіанту немає." };
    },
  ]);
  const reply = await copilot.ask("Чому саме цей маршрут?");
  assert.equal(reply.trace.length, 2);
  assert.deepEqual(llm.tiers, ["fast", "fast"]);
});

test("backend outage on the first call -> local deterministic answer, clearly labelled", async () => {
  const { copilot } = await copilotWith([], {}, { failAtCall: 0 });
  const reply = await copilot.ask("Що з GPS?");
  assert.equal(reply.mode, "local");
  assert.match(reply.text, /Розумний режим штурмана зараз недоступний/);
  assert.match(reply.text, /GNSS-сигнал у нормі/);
  assert.match(String(reply.degradedReason), /simulated backend outage/);
});

test("AI context sharing off -> never calls the LLM, answers locally without alarming notice", async () => {
  const { copilot, llm } = await copilotWith([], {}, { aiEnabled: false });
  const reply = await copilot.ask("Де наступний поворот?");
  assert.equal(llm.requests.length, 0);
  assert.equal(reply.mode, "local");
  assert.match(reply.text, /Наступний маневр/);
});

test("outage after tools ran: honest partial failure, not an invented answer", async () => {
  const { copilot } = await copilotWith([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"] } }] }),
  ], {}, { failAtCall: 1 });
  const reply = await copilot.ask("Знайди заправку");
  assert.equal(reply.mode, "llm");
  assert.match(reply.text, /недоступний/);
  assert.equal(reply.trace.length, 1);
});

test("tool errors reach the model as is_error results and escalate to the smart tier", async () => {
  const { copilot, llm } = await copilotWith([
    () => ({ tools: [{ name: "search_near", input: { anchor: "destination", categories: ["parking"] } }] }),
    (v) => {
      const last = v.request.messages[v.request.messages.length - 1]!;
      const block = (last.content as Row[])[0]!;
      assert.equal(block.is_error, true);
      assert.equal(v.lastToolResults[0]!.error, "place_search_failed");
      return { text: "Пошук місць зараз недоступний, тому не можу підказати парковку." };
    },
  ], { places: "failing" });
  const reply = await copilot.ask("Знайди парковку біля місця призначення");
  assert.match(reply.text, /недоступний/);
  assert.deepEqual(llm.tiers, ["fast", "smart"]);
});

test("tool budget: a model that keeps calling tools is stopped and must answer with what it has", async () => {
  const loop: ScriptStep = () => ({ tools: [{ name: "get_route_overview", input: {} }] });
  const { copilot } = await copilotWith([loop, loop, loop, loop, loop, () => ({ text: "Маршрут активний, залишилось 31 км." })], {}, { maxLlmCalls: 6 });
  const reply = await copilot.ask("Розкажи про маршрут");
  assert.equal(reply.trace.length, 4, "the 5th call's tools are refused with budget_exhausted");
  assert.equal(reply.text, "Маршрут активний, залишилось 31 км.");
});

test("refusal stop reason -> short safe reply", async () => {
  const { copilot } = await copilotWith([() => ({ text: "", stopReason: "refusal" })]);
  const reply = await copilot.ask("…");
  assert.equal(reply.text, "Я не можу допомогти з цим запитом.");
});

test("memory: earlier turns are replayed as plain text only (no stale tool payloads), newest last", async () => {
  const { copilot, llm } = await copilotWith([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["cafe"] } }] }),
    () => ({ text: "Aroma Kava через 4 кілометри." }),
    (v) => {
      const msgs = v.request.messages;
      assert.equal(msgs[0]!.content, "Де випити кави по дорозі?");
      assert.equal(msgs[1]!.content, "Aroma Kava через 4 кілометри.");
      assert.ok(!JSON.stringify(msgs.slice(0, 2)).includes("tool_use"));
      return { text: "Повторюю: Aroma Kava через 4 кілометри." };
    },
  ]);
  await copilot.ask("Де випити кави по дорозі?");
  const r = await copilot.ask("Повтори");
  assert.match(r.text, /Aroma Kava/);
  assert.equal(llm.requests.length, 3);
});

test("the model never receives coordinates — only ids, names, distances and times", async () => {
  const { copilot, llm } = await copilotWith([
    () => ({ tools: [
      { name: "search_along_route", input: { categories: ["fuel"] } },
      { name: "search_near", input: { anchor: "destination", categories: ["parking"] } },
      { name: "get_route_overview", input: {} },
    ] }),
    () => ({ text: "ok" }),
  ]);
  await copilot.ask("Заправка і парковка");
  const wire = JSON.stringify(llm.requests);
  assert.doesNotMatch(wire, /\b(50|30)\.\d{4,}/, "no lat/lon-like numbers on the wire");
});

test("UI confirm button executes the pending action without an LLM round-trip; decline clears it", async () => {
  const { copilot, llm, world } = await copilotWith([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"] } }] }),
    (v) => ({ tools: [{ name: "add_stop", input: { place_id: firstResultId(v) } }] }),
    () => ({ text: "Додати WOG?" }),
  ]);
  await copilot.ask("Заправка по дорозі");
  assert.equal(copilot.getPendingAction()?.tool, "add_stop");
  const confirmed = await copilot.confirmPendingAction();
  assert.match(confirmed.text, /Зупинку ОККО.* додано/); // first in driving order (NAVIA speaks in the neuter)
  assert.equal(world.host.route!.waypointCount, 1);
  assert.equal(llm.requests.length, 3);
  assert.equal(copilot.declinePendingAction().text, "Немає дії, яку потрібно скасувати.");
});

test("driver declines by voice -> model cancels the pending action", async () => {
  const { copilot, world } = await copilotWith([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["cafe"] } }] }),
    (v) => ({ tools: [{ name: "add_stop", input: { place_id: firstResultId(v) } }] }),
    () => ({ text: "Додати Aroma Kava?" }),
    () => ({ tools: [{ name: "cancel_pending_action", input: {} }] }),
    () => ({ text: "Добре, їдемо без зупинки." }),
  ]);
  await copilot.ask("Хочу кави");
  const r = await copilot.ask("Ні, не треба");
  assert.equal(r.pendingAction, null);
  assert.equal(world.planner.getPlan().stops.length, 0);
});

test("chooseTier: cascade rules", () => {
  const base = { callIndex: 0, distinctToolsUsed: 0, toolErrors: 0, userTextLength: 20, msSinceLastSmartTurn: null, previousTier: null } as const;
  assert.equal(chooseTier(base), "fast");
  assert.equal(chooseTier({ ...base, callIndex: 2, distinctToolsUsed: 2 }), "fast", "search -> propose -> answer stays fast");
  assert.equal(chooseTier({ ...base, callIndex: 3 }), "smart");
  assert.equal(chooseTier({ ...base, distinctToolsUsed: 3 }), "smart");
  assert.equal(chooseTier({ ...base, toolErrors: 1 }), "smart");
  assert.equal(chooseTier({ ...base, userTextLength: 200 }), "smart");
  assert.equal(chooseTier({ ...base, msSinceLastSmartTurn: 30_000 }), "fast", "no sticky smart by default");
  assert.equal(chooseTier({ ...base, msSinceLastSmartTurn: 30_000 }, { ...DEFAULT_ROUTER_POLICY, stickySmartMs: 90_000 }), "smart");
  assert.equal(chooseTier({ ...base, previousTier: "smart" }), "smart", "never downgrade within a turn");
  assert.equal(chooseTier({ ...base, callIndex: 5 }, { ...DEFAULT_ROUTER_POLICY, mode: "always_fast" }), "fast");
});

test("toSpeakable strips markdown the TTS would read aloud", () => {
  assert.equal(toSpeakable("**WOG** через 4 км\n- OKKO"), "WOG через 4 км\nOKKO");
  assert.equal(toSpeakable("WOG (p3) через 4 км"), "WOG через 4 км");
});

test("integration with DemoEngine: the co-pilot adds a stop and the simulated drive follows the new route", async () => {
  const engine = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION });
  await engine.start();
  for (let i = 0; i < 60; i++) engine.tick(1);
  const planner = new TripPlanner(engine.getRoutingProvider());
  planner.setDestination({ label: "Бориспіль", location: DEMO_DESTINATION });
  const runtime = new EngineCopilotRuntime({ host: engine, planner, places: new LocalPlaceSearchProvider(DEMO_ROUTE_POIS, "demo") });
  const llm = new ScriptedLLM([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"], limit: 1 } }] }),
    (v) => ({ tools: [{ name: "add_stop", input: { place_id: firstResultId(v) } }] }),
    () => ({ text: "Додати WOG?" }),
  ]);
  const copilot = new NaviaCopilot({ runtime, llm });
  await copilot.ask("Заправка по дорозі");
  await copilot.confirmPendingAction();
  assert.equal(engine.getRoute()!.waypointCount, 1);
  let passedStop = false;
  const wog = DEMO_ROUTE_POIS.find((p) => p.id === "demo-fuel-wog-2")!;
  for (let i = 0; i < 4000 && engine.getState().mode !== "ARRIVED"; i++) {
    engine.tick(1);
    const pos = engine.getState().position?.position;
    if (pos && planner.markVisitedNear(pos).some((s) => s.label === "WOG")) passedStop = true;
  }
  assert.ok(passedStop, `the simulated car must pass through the added stop (${wog.name})`);
  assert.equal(engine.getState().mode, "ARRIVED");
});
