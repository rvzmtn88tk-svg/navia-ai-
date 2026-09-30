// Conversation state, trip memory, preferences, proactive events and the
// voice loop — the machinery that lets the model resolve "the second one",
// "remove it again", "coffee first, then home". A scripted LLM plays the model
// so these test OUR code paths deterministically; how well the real model uses
// them is measured by the evaluation suite (packages/core/eval, apps/ai-backend/eval).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NaviaCopilot } from "../src/copilot/copilot";
import { ProactiveEngine } from "../src/copilot/proactive";
import { PreferenceStore } from "../src/copilot/preferences";
import { VoiceConversation, matchWakeWord } from "../src/copilot/voice-conversation";
import { executeCopilotTool } from "../src/copilot/tool-executor";
import { MemoryKeyValueStore } from "../src/storage";
import { buildWorld, WORLD_SAVED_HOME, type WorldOptions } from "../eval/world";
import { ScriptedLLM, type ScriptStep } from "./fixtures/scripted-llm";

type Row = Record<string, unknown>;

async function setup(steps: ScriptStep[], world: WorldOptions = {}) {
  const w = await buildWorld(world);
  const llm = new ScriptedLLM(steps);
  const copilot = new NaviaCopilot({ runtime: w.runtime, llm, aiEnabled: () => true });
  return { copilot, llm, w };
}

/** The id of item #n in last_results, as the model would read it from trip_state. */
function nth(tripState: string, n: number, which: "last_results" | "earlier_results" = "last_results"): string {
  const line = tripState.split("\n").find((l) => l.startsWith(which))!;
  const m = new RegExp(`#${n} ([prs]\\d+)`).exec(line);
  assert.ok(m, `no #${n} in: ${line}`);
  return m![1]!;
}

test("'Find fuel on the way' → 'the second is fine, how much time do we lose?' → 'add it' → 'no, remove it'", async () => {
  let second = "";
  const { copilot, w } = await setup([
    // 1: search
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"], limit: 3 } }] }),
    (v) => ({ text: `Є ${(v.lastToolResults[0]!.results as Row[]).map((r) => r.name).join(", ")}.` }),
    // 2: "the second" → details of #2
    (v) => { second = nth(v.tripState, 2); return { tools: [{ name: "get_place_details", input: { place_id: second } }] }; },
    (v) => { assert.equal(typeof v.lastToolResults[0]!.added_min_if_stopping, "number"); return { text: `Заїзд додасть близько ${Math.round(Number(v.lastToolResults[0]!.added_min_if_stopping))} хвилин.` }; },
    // 3: "add it" — the driver heard the impact; the focus is the second place
    (v) => { assert.match(v.tripState, new RegExp(`focus: ${second} `)); return { tools: [{ name: "add_stop", input: { place_id: second, driver_confirmed_in_this_message: true } }] }; },
    (v) => { assert.equal(v.lastToolResults[0]!.status, "done"); return { text: "Додала." }; },
    // 4: "no, remove it" — the undo is in recent_actions
    (v) => {
      const m = /recent_actions: [^\n]*\[undo: remove_stop \{"stop_id":"(s\d+)"\}\]/.exec(v.tripState);
      assert.ok(m, v.tripState);
      return { tools: [{ name: "remove_stop", input: { stop_id: m![1]! } }] };
    },
    (v) => { assert.equal(v.lastToolResults[0]!.status, "done"); return { text: "Прибрала." }; },
  ]);
  await copilot.ask("Знайди заправку по дорозі");
  await copilot.ask("Друга норм. Скільки втратимо?");
  const r3 = await copilot.ask("Добре, додавай");
  assert.equal(r3.pendingAction, null, "no second yes/no: the driver already heard the cost and ordered it");
  assert.equal(w.planner.getPlan().stops.length, 1);
  await copilot.ask("Хоча ні, прибери її");
  assert.equal(w.planner.getPlan().stops.length, 0);
});

test("An order without having heard the impact is only a proposal (the gate can't be skipped by the model alone)", async () => {
  const { copilot, w } = await setup([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"] } }] }),
    (v) => ({ tools: [{ name: "add_stop", input: { place_id: String((v.lastToolResults[0]!.results as Row[])[0]!.id), driver_confirmed_in_this_message: true } }] }),
    (v) => { assert.equal(v.lastToolResults[0]!.status, "awaiting_user_confirmation"); return { text: "Додати?" }; },
  ]);
  const r = await copilot.ask("Знайди заправку і додай");
  assert.ok(r.pendingAction);
  assert.equal(w.planner.getPlan().stops.length, 0);
});

test("'Not this one, the next' → search beyond the rejected place; results exclude it", async () => {
  let first = "";
  const { copilot } = await setup([
    () => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"], limit: 1 } }] }),
    (v) => { first = String((v.lastToolResults[0]!.results as Row[])[0]!.id); return { text: "ОККО через 7 км." }; },
    (v) => ({ tools: [{ name: "search_along_route", input: { categories: ["fuel"], limit: 1, beyond_place_id: nth(v.tripState, 1), exclude_place_ids: [nth(v.tripState, 1)] } }] }),
    (v) => {
      const res = v.lastToolResults[0]!.results as Row[];
      assert.ok(res.length === 1 && res[0]!.id !== first, JSON.stringify(res));
      assert.match(v.tripState, /earlier_results|last_results/);
      return { text: `Наступна — ${String(res[0]!.name)}.` };
    },
  ]);
  await copilot.ask("Найди заправку по дороге");
  const r = await copilot.ask("не эту, следующую");
  assert.match(r.text, /Наступна/);
});

test("A plan — 'coffee first, then home' — is proposed as one, confirmed with one yes (voice) or one tap", async () => {
  const steps: ScriptStep[] = [
    () => ({ tools: [
      { name: "search_along_route", input: { categories: ["cafe"], max_detour_minutes: 5, limit: 1 } },
      { name: "find_destination", input: { saved_place: "home" } },
    ] }),
    (v) => {
      const cafe = String((v.lastToolResults[0]!.results as Row[])[0]!.id);
      const home = String((v.lastToolResults[1]!.candidates as Row[])[0]!.id);
      return { tools: [{ name: "add_stop", input: { place_id: cafe } }, { name: "set_destination", input: { place_id: home, keep_stops: true } }] };
    },
    (v) => {
      assert.ok(v.lastToolResults.every((r) => r.status === "awaiting_user_confirmation"));
      assert.equal((v.lastToolResults[1]!.plan_so_far as string[]).length, 2);
      return { text: "Спочатку кава, потім додому. Підтвердити?" };
    },
  ];
  // Voice: "так" → the model repeats both actions.
  const voice = await setup([...steps,
    (v) => {
      assert.match(v.tripState, /pending_action: add_stop .* \+ set_destination .*one plan/);
      // The model reads the exact pending calls from trip_state and repeats them.
      const line = v.tripState.split("\n").find((l) => l.startsWith("pending_action"))!;
      const calls = [...line.matchAll(/(add_stop|set_destination) (\{[^}]*\})/g)].map((m) => ({ name: m[1]!, input: JSON.parse(m[2]!) as Row }));
      assert.equal(calls.length, 2);
      return { tools: calls };
    },
    (v) => { assert.ok(v.lastToolResults.every((r) => r.status === "done"), JSON.stringify(v.lastToolResults)); return { text: "Готово." }; },
  ], { savedPlaces: [WORLD_SAVED_HOME] });
  const r1 = await voice.copilot.ask("Заїдь спочатку за кавою, потім продовжимо додому");
  assert.match(r1.pendingAction!.summary, /потім/);
  await voice.copilot.ask("так");
  assert.equal(voice.w.planner.getPlan().stops.length, 1);
  assert.equal(voice.w.planner.getPlan().destination!.label, WORLD_SAVED_HOME.label);

  // Tap: one Confirm runs the whole plan.
  const tap = await setup(steps, { savedPlaces: [WORLD_SAVED_HOME] });
  await tap.copilot.ask("Заїдь спочатку за кавою, потім додому");
  const done = await tap.copilot.confirmPendingAction();
  assert.deepEqual(done.trace.map((t) => t.tool), ["add_stop", "set_destination"]);
  assert.equal(tap.w.planner.getPlan().stops.length, 1);
  assert.equal(tap.w.planner.getPlan().destination!.label, WORLD_SAVED_HOME.label);
});

test("Preferences: a stated habit is saved (validated, persisted), shown to the model, and applied as a default", async () => {
  const kv = new MemoryKeyValueStore();
  const prefs = new PreferenceStore(kv);
  const { copilot } = await setup([
    () => ({ tools: [{ name: "remember_preference", input: { key: "max_detour_minutes", value: 7, driver_words: "я не люблю крюки більше 7 хвилин" } }] }),
    () => ({ text: "Запам'ятала: крюк до 7 хвилин." }),
    (v) => { assert.match(v.tripState, /preferences \(driver's saved, long-term\): max_detour_minutes=7/); return { tools: [{ name: "search_along_route", input: { categories: ["cafe"] } }] }; },
    (v) => { assert.match(String(v.lastToolResults[0]!.applied_preference), /max_detour_minutes=7/); return { text: "…" }; },
  ], { preferences: prefs });
  await copilot.ask("Запам'ятай: я не люблю крюки більше 7 хвилин");
  await copilot.ask("кава десь по дорозі");
  const reloaded = new PreferenceStore(kv);
  await reloaded.load();
  assert.equal(reloaded.get("max_detour_minutes"), 7);
  const bad = await executeCopilotTool("remember_preference", { key: "favourite_colour", value: "red", driver_words: "x" }, { runtime: (await buildWorld({ preferences: prefs })).runtime, registry: copilot.registry, session: copilot.session });
  assert.equal(bad.isError, true, "unknown keys are rejected, not stored");
});

test("Reminder → proactive event handled by the model (with tools), once; anti-spam holds; SKIP stays silent", async () => {
  const { copilot, w } = await setup([
    () => ({ tools: [{ name: "set_reminder", input: { topic: "кава", after_minutes: 30, categories: ["cafe"] } }] }),
    () => ({ text: "Нагадаю за пів години." }),
    // the event
    (v) => {
      assert.match(v.userText, /<event type="reminder_due">/);
      assert.match(v.userText, /кава/);
      return { tools: [{ name: "search_along_route", input: { categories: ["cafe"], max_detour_minutes: 3, limit: 1 } }] };
    },
    (v) => ({ text: `Ви просили про каву: ${String((v.lastToolResults[0]!.results as Row[])[0]?.name ?? "поки нічого")} поруч з маршрутом.` }),
  ]);
  await copilot.ask("Нагадай про каву за пів години");
  const engine = new ProactiveEngine(copilot, w.runtime, { minIntervalMs: 60_000 });
  assert.equal(await engine.tick(), null, "not due yet");
  w.setNow(new Date(2026, 8, 29, 14, 31));
  const msg = await engine.tick();
  assert.ok(msg && /каву/.test(msg.reply.text));
  assert.equal(await engine.tick(), null, "fired once");
  assert.equal(copilot.session.reminders.length, 0);

  const quiet = await setup([
    () => ({ tools: [{ name: "set_reminder", input: { topic: "перепочити", after_minutes: 5 } }] }),
    () => ({ text: "Добре." }),
    () => ({ text: "SKIP" }),
  ]);
  await quiet.copilot.ask("Через 5 хвилин нагадай перепочити");
  quiet.w.setNow(new Date(2026, 8, 29, 14, 6));
  assert.equal(await new ProactiveEngine(quiet.copilot, quiet.w.runtime).tick(), null, "the model chose not to interrupt");
});

test("Reminder with the cloud AI unavailable: still delivered, with a real along-route search", async () => {
  const w = await buildWorld();
  const copilot = new NaviaCopilot({ runtime: w.runtime, llm: null });
  await executeCopilotTool("set_reminder", { topic: "кава", after_minutes: 10, categories: ["cafe"] }, { runtime: w.runtime, registry: copilot.registry, session: copilot.session });
  w.setNow(new Date(2026, 8, 29, 14, 11));
  const msg = await new ProactiveEngine(copilot, w.runtime).tick();
  assert.ok(msg);
  assert.equal(msg!.reply.mode, "local");
  assert.match(msg!.reply.text, /Нагадую: кава\. Найближче по дорозі: .+, через [\d.]+ км/);
});

test("Read-tool cache: the same search within a minute is served from cache and keeps the list for references", async () => {
  const w = await buildWorld();
  const copilot = new NaviaCopilot({ runtime: w.runtime, llm: null });
  const ctx = { runtime: w.runtime, registry: copilot.registry, session: copilot.session };
  const a = await executeCopilotTool("search_along_route", { categories: ["fuel"] }, ctx);
  const b = await executeCopilotTool("search_along_route", { categories: ["fuel"] }, ctx);
  assert.equal(a.content.cached, undefined);
  assert.equal(b.content.cached, true);
  assert.deepEqual((b.content.results as Row[]).map((r) => r.id), (a.content.results as Row[]).map((r) => r.id));
  assert.equal(copilot.session.recentResults.length, (a.content.results as Row[]).length);
});

test("Driving context in trip_state: stopped vs moving vs maneuver imminent", async () => {
  const { buildTripSnapshot } = await import("../src/copilot/trip-snapshot");
  const w = await buildWorld();
  const copilot = new NaviaCopilot({ runtime: w.runtime, llm: null });
  w.host.state = { ...w.host.state, speedMps: 0 };
  assert.match(buildTripSnapshot(w.runtime, copilot.session), /driving: phase=stopped .*reply_style=fuller/);
  w.host.state = { ...w.host.state, speedMps: 15, nextManeuverDistanceM: 120 };
  assert.match(buildTripSnapshot(w.runtime, copilot.session), /driving: phase=maneuver_imminent/);
  w.host.state = { ...w.host.state, speedMps: 15, nextManeuverDistanceM: 3000 };
  assert.match(buildTripSnapshot(w.runtime, copilot.session), /driving: phase=moving/);
});

test("Voice loop: wake word, follow-up without it after NAVIA asks, cabin talk ignored", async () => {
  assert.deepEqual(matchWakeWord("Навіа, знайди каву"), { matched: true, rest: "знайди каву" });
  assert.equal(matchWakeWord("Навия где заправка").matched, true, "one recognition error tolerated");
  assert.equal(matchWakeWord("Ей Navia how far").rest, "how far");
  assert.equal(matchWakeWord("навігатор тупить").matched, false);
  let t = 0;
  const asked: string[] = [];
  const said: string[] = [];
  const brain = {
    ask: async (q: string) => {
      asked.push(q);
      return q.includes("каву") ? { text: "Є Aroma Kava, +2 хв. Додати?", pendingAction: {} } : { text: "Готово.", pendingAction: null };
    },
  };
  const vc = new VoiceConversation(brain, { listen: async () => ({ stop() {} }) }, { speak: async (x) => { said.push(x); }, stop() {} }, { now: () => t });
  await vc.handleUtterance("а ти бачив вчора матч?");
  assert.equal(asked.length, 0, "not addressed to NAVIA");
  await vc.handleUtterance("Навіа, знайди каву по дорозі");
  t += 3_000;
  await vc.handleUtterance("так, додавай");
  assert.deepEqual(asked, ["знайди каву по дорозі", "так, додавай"]);
  t += 30_000;
  await vc.handleUtterance("так");
  assert.equal(asked.length, 2, "the follow-up window closed");
  await vc.handleUtterance("Навіа");
  assert.equal(said[said.length - 1], "Слухаю.");
  t += 2_000;
  await vc.handleUtterance("скільки ще їхати");
  assert.equal(asked[asked.length - 1], "скільки ще їхати");
});
