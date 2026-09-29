// Regression gate on the navigator simulator (programme 5): a smaller run
// (2 random value sets × 7 situations × 660 formulations = 9 240 runs) with
// the acceptance criteria of part 5.4, plus the persona rule (6.1): no
// self-reference in the feminine or masculine in any generated answer.
// The full ≥ 100 000-run version: `npm run navigator:sim`.
import test from "node:test";
import assert from "node:assert/strict";
import { checkCriteria, runSimulation } from "./sim/navigatorSimulator";
import { GENDERED } from "../src/ai/navigator/grounding";

test("navigator simulator: acceptance criteria and persona", async () => {
  // Unicode-aware boundaries (the first version used \b, which does not work
  // with Cyrillic in JavaScript and therefore caught nothing).
  const gendered = GENDERED;
  const offenders: string[] = [];
  const res = await runSimulation({ numericSets: 2, keepWorst: 20, onRow: (r) => { if (gendered.test(r.answer) && !/був|була тривога/.test(r.answer)) offenders.push(r.answer); } });
  for (const c of checkCriteria(res)) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.value}`);
    assert.ok(c.ok, `${c.name}: ${c.value}`);
  }
  assert.deepEqual([...new Set(offenders)].slice(0, 5), [], "no gendered self-reference");
});
