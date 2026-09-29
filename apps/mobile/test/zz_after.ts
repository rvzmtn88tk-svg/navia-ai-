import { Navigator } from "../src/ai/navigator/navigator";
import { sevenSituations } from "./support/navigatorScenarios";
import { CONTROL } from "./support/controlQuestions";
import { classify } from "../src/ai/navigator/intents";
import { HOLDOUT_C } from "./support/holdoutC";
(async () => {
  const sits = new Map((await sevenSituations()).map((s) => [s.key, s]));
  const navs = new Map<string, Navigator>();
  for (const c of CONTROL) {
    const nav = navs.get(c.sit) ?? new Navigator(); navs.set(c.sit, nav);
    const r = nav.ask(c.q, sits.get(c.sit)!.snapshot);
    console.log(`${c.n} [${c.sit}] ${c.q} → ${r.intent} (${r.confidence.toFixed(2)}): ${r.text.replace(/\n/g, " ⏎ ")}`);
  }
  const bad = HOLDOUT_C.filter(([q, a]) => !a.includes(classify(q)));
  console.log(`hold-out C: ${HOLDOUT_C.length - bad.length}/${HOLDOUT_C.length}`);
  for (const [q, a] of bad) console.log(`  ✗ ${q} → ${classify(q)} (want ${a.join("/")})`);
})();
