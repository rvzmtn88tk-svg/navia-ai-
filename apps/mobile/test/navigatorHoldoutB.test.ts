// Hold-out B: written after hold-out A was seen and the example bank was
// added — the clean estimate. Never tune on these; add new hold-out sets.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/ai/navigator/intents";
import { HOLDOUT_B } from "./support/holdouts";


test("hold-out B (clean): recognition rate", () => {
  const rows = HOLDOUT_B.map(([q, accept]) => { const got = classify(q); return { q, accept, got, ok: accept.includes(got) }; });
  const ok = rows.filter((r) => r.ok).length;
  const rate = (100 * ok) / rows.length;
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-holdout-b.md"), ["# Hold-out B (clean)", "", `Recognised: ${ok} of ${rows.length} (${rate.toFixed(1)} %)`, "", "| Question | Expected | Got | OK |", "|---|---|---|---|", ...rows.map((r) => `| ${r.q} | ${r.accept.join("/")} | ${r.got} | ${r.ok ? "✓" : "✗"} |`), ""].join("\n"));
  console.log(`hold-out B: ${ok}/${rows.length} (${rate.toFixed(1)} %)`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ✗ «${r.q}» → ${r.got} (want ${r.accept.join("/")})`);
  assert.ok(rows.length >= 40);
});
