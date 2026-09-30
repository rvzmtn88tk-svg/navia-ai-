// The live-eval grader's number-grounding check, and that every eval
// scenario's world builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNumbers, ungroundedNumbers, gradeTurn } from "../eval/grader";
import { SCENARIOS } from "../eval/scenarios";
import { buildWorld } from "../eval/world";
import type { CopilotReply } from "../src/copilot/copilot";

test("extractNumbers: decimals with comma or dot, clock times split", () => {
  assert.deepEqual(extractNumbers("WOG через 16 км, гак 0,2 хв, прибуття о 14:48"), [16, 0.2, 14, 48]);
});

test("ungroundedNumbers: spoken rounding and m<->km are fine, invented figures are caught", () => {
  const corpus = [{ ahead_km: 16, detour_min: 2.8, distance_m: 250, arrival: "14:48" }, "remaining: 31 km, 48 min"];
  assert.deepEqual(ungroundedNumbers("McDonald's через 16 кілометрів, плюс 3 хвилини, прибуття о 14:48", corpus), []);
  assert.deepEqual(ungroundedNumbers("Парковка за 0,25 км від місця призначення", corpus), []);
  assert.deepEqual(ungroundedNumbers("Є два варіанти", corpus), []);
  assert.deepEqual(ungroundedNumbers("Заправка через 7 км, гак 12 хвилин", corpus), ["7 km", "12 min"]);
  assert.deepEqual(ungroundedNumbers("Прибуття о 15:10", corpus), ["15:10"]);
});

test("ungroundedNumbers: units must match — '5 km' is not excused by the driver saying '5 minutes'", () => {
  const corpus = ["гак не більше 5 хвилин", { ahead_km: 7, detour_min: 0.5 }];
  assert.deepEqual(ungroundedNumbers("ОККО через 5 кілометрів", corpus), ["5 km"]);
  assert.deepEqual(ungroundedNumbers("гак не більше 5 хвилин", corpus), []);
  assert.deepEqual(ungroundedNumbers("через 2,4 кілометра", [{ in_m: 2440 }]), []);
  assert.deepEqual(ungroundedNumbers("швидкість 60 км/год", ["speed: 60 km/h"]), []);
});

test("gradeTurn: flags ungrounded numbers, wrong tools and pending state", () => {
  const reply: CopilotReply = {
    text: "WOG через 9 км.", mode: "llm", pendingAction: null, tiers: ["fast"], models: ["m"], latencyMs: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    trace: [{ tool: "search_along_route", input: { categories: ["fuel"] }, isError: false, result: { results: [{ ahead_km: 16 }] }, ms: 1 }],
  };
  const checks = gradeTurn({ user: "x", expectTools: ["search_along_route"], expectPending: "add_stop" }, reply, { waypoints: 0, groundingCorpus: [reply.trace[0]!.result] });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.passed]));
  assert.equal(byName["calls search_along_route"], true);
  assert.equal(byName["pending = add_stop"], false);
  assert.equal(byName["numbers grounded in data"], false);
});

test("every eval scenario builds its world", async () => {
  assert.ok(SCENARIOS.length >= 20);
  const ids = new Set<string>();
  for (const s of SCENARIOS) {
    assert.ok(!ids.has(s.id), `duplicate scenario id ${s.id}`);
    ids.add(s.id);
    const w = await buildWorld(s.world);
    assert.ok(w.runtime);
  }
  const categories = new Set(SCENARIOS.map((s) => s.category));
  for (const c of ["normal", "multi_step", "ambiguous", "api_error", "no_results", "route_change", "long_dialog", "safety"]) {
    assert.ok(categories.has(c as never), `category ${c} covered`);
  }
});
