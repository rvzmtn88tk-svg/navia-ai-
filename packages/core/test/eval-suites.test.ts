// Structure of the evaluation suites, and the recorded holdout sample still
// replaying through the current co-pilot (tools, state, grading).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_SUITE } from "../eval/suite/dev";
import { HOLDOUT_SUITE } from "../eval/suite/holdout";
import { SCENARIOS } from "../eval/scenarios";
import { loadTranscript, replayScenario } from "../eval/model-in-the-loop";
import { COPILOT_TOOLS } from "../src/copilot/tool-definitions";

test("Eval suites: ≥200 dev + ≥50 holdout scenarios, unique ids, every category covered, known tools only", () => {
  assert.ok(DEV_SUITE.length >= 200, `dev ${DEV_SUITE.length}`);
  assert.ok(HOLDOUT_SUITE.length >= 50, `holdout ${HOLDOUT_SUITE.length}`);
  const ids = [...SCENARIOS, ...DEV_SUITE, ...HOLDOUT_SUITE].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique across suites");
  const cats = new Set(DEV_SUITE.map((s) => s.category));
  for (const c of ["paraphrase", "slang", "typos", "short", "long", "multi_step", "reference", "change_mind", "clarify", "no_results", "api_error", "route_change", "preferences", "reminder", "gps", "unexpected", "language"]) {
    assert.ok(cats.has(c as never), `dev covers ${c}`);
  }
  assert.ok(DEV_SUITE.filter((s) => s.turns.length > 1).length >= 30, "multi-turn dialogues");
  const known = new Set(COPILOT_TOOLS.map((t) => t.name));
  for (const s of [...DEV_SUITE, ...HOLDOUT_SUITE]) for (const t of s.turns) {
    for (const name of [...(t.expectTools ?? []), ...(t.expectAnyTool ?? []), ...(t.forbidTools ?? [])]) assert.ok(known.has(name), `${s.id}: unknown tool ${name}`);
  }
  // Holdout wording must not be reused in the dev suite.
  const devTexts = new Set(DEV_SUITE.flatMap((s) => s.turns.map((t) => t.user.toLowerCase())));
  for (const s of HOLDOUT_SUITE) for (const t of s.turns) {
    if (t.user.length > 8) assert.ok(!devTexts.has(t.user.toLowerCase()), `holdout text reused in dev: ${t.user}`);
  }
});

test("Holdout model-in-the-loop sample replays and passes its checks through the current co-pilot", async () => {
  let replayed = 0;
  for (const s of HOLDOUT_SUITE) {
    const tr = loadTranscript(s.id);
    if (!tr) continue;
    const r = await replayScenario(s, tr);
    assert.equal(r.needed, null, `${s.id}: transcript incomplete`);
    const failed = r.turns.flatMap((t) => t.checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.detail ?? ""})`));
    assert.deepEqual(failed, [], s.id);
    replayed++;
  }
  assert.ok(replayed >= 50, `replayed ${replayed}`);
});
