// Evaluates the language engine on the hold-out sets A, B, C (phrasings never
// used for tuning): the same routing as the phone (askSmart) — a confident
// on-device answer stays local, the rest goes to Claude with the phone's
// facts. Needs ANTHROPIC_API_KEY in the environment (never in the app):
//   ANTHROPIC_API_KEY=… npx tsx functions/scripts/evalUnderstand.ts
import Anthropic from "@anthropic-ai/sdk";
import { understand as understandLlm, UNDERSTAND_MODEL } from "../src/understand";
import { understand as understandLocal } from "../../apps/mobile/src/ai/navigator/intents";
import { LOCAL_SURE } from "../../apps/mobile/src/ai/navigator/navigator";
import { factsFor } from "../../apps/mobile/src/ai/navigator/languageEngine";
import { sevenSituations } from "../../apps/mobile/test/support/navigatorScenarios";
import { HOLDOUT, HOLDOUT_B } from "../../apps/mobile/test/support/holdouts";
import { HOLDOUT_C } from "../../apps/mobile/test/support/holdoutC";

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("BLOCKED: ANTHROPIC_API_KEY is not set — the language model cannot be evaluated. On-device rules only.");
    process.exit(2);
  }
  const client = new Anthropic();
  const snap = (await sevenSituations()).find((s) => s.key === "driving")!.snapshot;
  const facts = factsFor(snap, null);
  const lat: number[] = [];
  for (const [name, set] of [["A", HOLDOUT], ["B", HOLDOUT_B], ["C", HOLDOUT_C]] as const) {
    let ok = 0, local = 0;
    const misses: string[] = [];
    for (const [q, accept] of set as [string, string[]][]) {
      const u = understandLocal(q);
      let intent: string = u.intent;
      if (!(u.confidence >= LOCAL_SURE && u.intent !== "unknown" && u.intent !== "clarify")) {
        const t0 = Date.now();
        intent = (await understandLlm(client, q, facts)).intent;
        lat.push(Date.now() - t0);
      } else local++;
      if (accept.includes(intent)) ok++; else misses.push(`«${q}» → ${intent} (want ${accept.join("/")})`);
    }
    console.log(`hold-out ${name}: ${ok}/${set.length} (${(100 * ok / set.length).toFixed(1)} %) — ${local} answered on the phone, ${set.length - local} by ${UNDERSTAND_MODEL}`);
    for (const m of misses) console.log("   ✗", m);
  }
  lat.sort((a, b) => a - b);
  if (lat.length) console.log(`server round trip (from this Mac): median ${lat[Math.floor(lat.length / 2)]} ms, p95 ${lat[Math.floor(0.95 * (lat.length - 1))]} ms`);
})();
