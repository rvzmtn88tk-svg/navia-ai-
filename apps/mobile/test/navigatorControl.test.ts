// The 12 control questions (programme 1.2) on the current code, next to the
// baseline recorded before the rebuild (reports/navigator-control-BASELINE.md).
// Writes reports/navigator-control-AFTER.md. Checks the answers are about
// the question asked (intent) — the words are compared by a person.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Navigator } from "../src/ai/navigator/navigator";
import { sevenSituations } from "./support/navigatorScenarios";
import { CONTROL } from "./support/controlQuestions";

const EXPECT: Record<number, string[]> = {
  1: ["whereAmI"], 2: ["routeNext"], 3: ["routeNext"], 4: ["signalLost"], 5: ["confidence"], 6: ["shelter", "alert"], 7: ["reroute"],
  8: ["noData"], 9: ["explain"], 10: ["eta"], 11: ["emotion"], 12: ["repeat"],
};

test("control questions after the rebuild", async () => {
  const sits = new Map((await sevenSituations()).map((s) => [s.key, s]));
  const navs = new Map<string, Navigator>();
  const rows: string[] = [];
  for (const c of CONTROL) {
    const nav = navs.get(c.sit) ?? new Navigator(); navs.set(c.sit, nav);
    const r = nav.ask(c.q, sits.get(c.sit)!.snapshot);
    rows.push(`| ${c.n} | ${sits.get(c.sit)!.name} | ${c.q} | ${r.intent} (${r.confidence.toFixed(2)}) | ${r.text.replace(/\n/g, " ⏎ ").replace(/\|/g, "/")} |`);
    assert.ok(EXPECT[c.n]!.includes(r.intent), `#${c.n} «${c.q}» → ${r.intent}`);
  }
  writeFileSync(join(__dirname, "reports", "navigator-control-AFTER.md"), ["# Navigator control questions — AFTER the rebuild", "", "| # | Ситуация | Вопрос | Интент (уверенность) | Ответ дословно |", "|---|---|---|---|---|", ...rows, ""].join("\n"));
});
