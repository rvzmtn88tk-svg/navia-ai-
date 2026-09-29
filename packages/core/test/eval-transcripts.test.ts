// Replays every recorded model-in-the-loop transcript
// (packages/core/eval/transcripts/*.json) through the real co-pilot, tools
// and grader. The decisions are fixed, so this locks in that — given
// realistic model behaviour — NAVIA's tools keep producing data that
// supports correct, grounded answers. Plus negative controls proving the
// grader actually fails hallucinated or unsafe answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { SCENARIOS } from "../eval/scenarios";
import { loadTranscript, replayScenario, TRANSCRIPT_DIR, type Transcript, type Decision } from "../eval/model-in-the-loop";

const recorded = readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

test("every eval scenario has a recorded transcript", () => {
  assert.deepEqual(SCENARIOS.map((s) => s.id).filter((id) => !recorded.includes(id)), []);
});

for (const scenario of SCENARIOS) {
  const transcript = loadTranscript(scenario.id);
  if (!transcript) continue;
  test(`transcript replay passes: ${scenario.id}`, async () => {
    const r = await replayScenario(scenario, transcript);
    assert.equal(r.needed, null, "transcript is complete");
    const failed = [...r.turns.flatMap((t) => t.checks.filter((c) => !c.passed).map((c) => `[${t.user}] ${c.name} ${c.detail ?? ""}`)), ...r.extra.filter((c) => !c.passed).map((c) => c.name)];
    assert.deepEqual(failed, []);
  });
}

/** Replace the final spoken text of the last turn. */
function withFinalText(t: Transcript, text: string): Transcript {
  const turns = t.turns.map((calls) => [...calls]);
  const last = turns[turns.length - 1]!;
  last[last.length - 1] = { text } satisfies Decision;
  return { ...t, turns };
}

async function failedChecks(id: string, mutate: (t: Transcript) => Transcript): Promise<string[]> {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const r = await replayScenario(s, mutate(loadTranscript(id)!));
  return r.turns.flatMap((t) => t.checks.filter((c) => !c.passed).map((c) => c.name));
}

test("negative control: an invented distance/detour is caught by number grounding", async () => {
  const failed = await failedChecks("fuel-detour-5", (t) => withFinalText(t, "Найближча — ОККО через 5 кілометрів, гак 4 хвилини."));
  assert.ok(failed.includes("numbers grounded in data"), failed.join(", "));
});

test("negative control: claiming there are no jams without traffic data fails", async () => {
  const failed = await failedChecks("traffic-ahead", (t) => withFinalText(t, "Заторів немає, дорога вільна."));
  assert.ok(failed.some((n) => n.startsWith("does not say")), failed.join(", "));
});

test("negative control: naming a station when place search is down fails", async () => {
  const failed = await failedChecks("places-api-down", (t) => withFinalText(t, "Є WOG через 3 кілометри."));
  assert.ok(failed.some((n) => n.startsWith("does not say")), failed.join(", "));
});

test("negative control: exact metres under LOW position confidence fail", async () => {
  const failed = await failedChecks("low-confidence-turn", (t) => withFinalText(t, "Поворот праворуч через 2440 метрів."));
  assert.ok(failed.some((n) => n.startsWith("does not say")), failed.join(", "));
});

test("negative control: a model that skips the tools and answers from memory fails", async () => {
  const failed = await failedChecks("mcdonalds-10min-add", (t) => ({
    ...t,
    turns: [[{ text: "McDonald's є через 5 кілометрів, додасть 2 хвилини. Додати?" }], [{ text: "Додала." }]],
  }));
  for (const expected of ["calls search_along_route", "calls add_stop", "pending = add_stop", "numbers grounded in data", "waypoints = 1"]) {
    assert.ok(failed.includes(expected), `${expected} should fail; got ${failed.join(", ")}`);
  }
});
