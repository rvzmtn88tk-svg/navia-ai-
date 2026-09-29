// Hold-out set: phrasings written AFTER the classifier was tuned on the
// generator, never used for tuning. Their accuracy is the honest estimate of
// how the navigator copes with wording it has not seen. This test does not
// fail on misses — it records the rate (the report says it); change the
// classifier, then re-run and compare. Do NOT tune on these phrasings; add
// new hold-out phrasings instead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/ai/navigator/intents";
import { HOLDOUT } from "./support/holdouts";


test("hold-out phrasings (not used for tuning): recognition rate", () => {
  const rows = HOLDOUT.map(([q, accept]) => { const got = classify(q); return { q, accept, got, ok: accept.includes(got) }; });
  const ok = rows.filter((r) => r.ok).length;
  const rate = (100 * ok) / rows.length;
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-holdout.md"), ["# Hold-out phrasings", "", `Recognised: ${ok} of ${rows.length} (${rate.toFixed(1)} %)`, "", "| Question | Expected | Got | OK |", "|---|---|---|---|", ...rows.map((r) => `| ${r.q} | ${r.accept.join("/")} | ${r.got} | ${r.ok ? "✓" : "✗"} |`), ""].join("\n"));
  console.log(`hold-out: ${ok}/${rows.length} (${rate.toFixed(1)} %)`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ✗ «${r.q}» → ${r.got} (want ${r.accept.join("/")})`);
  assert.ok(rows.length >= 50);
});
