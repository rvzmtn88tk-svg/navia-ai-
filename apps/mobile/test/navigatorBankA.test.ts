// All 4,900 rows of the spec's question bank (Appendix A) through the phone's
// own navigator — no language model: the intent must be one that answers the
// question, in every situation, with a non-empty answer. Writes
// reports/navigator-bank-A.md (accuracy by category, how many are sure
// enough to answer without the model, and every miss).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Navigator, LOCAL_SURE } from "../src/ai/navigator/navigator";
import { understand } from "../src/ai/navigator/intents";
import { sevenSituations } from "./support/navigatorScenarios";
import { BANK_A, BANK_SITUATIONS, bankStyles } from "./support/bankA";

test("question bank A: 4,900 rows answered by the right scenario", async () => {
  const sits = new Map((await sevenSituations()).map((s) => [s.key, s]));
  const byCat = new Map<string, { ok: number; sure: number; n: number }>();
  const misses = new Map<string, string>();
  let rows = 0, ok = 0, sure = 0;
  for (const [cat, base, , allowed] of BANK_A) {
    for (const q of bankStyles(base)) {
      const u = understand(q);
      for (const [, key] of BANK_SITUATIONS) {
        const r = new Navigator().ask(q, sits.get(key)!.snapshot);
        rows++;
        const c = byCat.get(cat) ?? { ok: 0, sure: 0, n: 0 };
        c.n++;
        assert.ok(r.text.trim().length > 0, `empty answer: ${q} [${key}]`);
        if (allowed.includes(r.intent)) { ok++; c.ok++; if (u.confidence >= LOCAL_SURE) { sure++; c.sure++; } }
        else if (!misses.has(q)) misses.set(q, `${cat}: «${q}» → ${r.intent} (${u.confidence.toFixed(2)}), expected ${allowed.join("/")}`);
        byCat.set(cat, c);
      }
    }
  }
  assert.equal(rows, 4900);
  const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
  writeFileSync(join(__dirname, "reports", "navigator-bank-A.md"), [
    "# Question bank A (spec appendix) — on-device navigator, no language model",
    "",
    `Rows: ${rows}. Right scenario: ${ok} (${pct(ok, rows)}). Right and sure enough to answer without the model (confidence ≥ ${LOCAL_SURE}): ${sure} (${pct(sure, rows)}).`,
    "",
    "| Category | Right | Sure |",
    "|---|---|---|",
    ...[...byCat].map(([c, v]) => `| ${c} | ${pct(v.ok, v.n)} | ${pct(v.sure, v.n)} |`),
    "",
    `Misses (distinct phrasings, ${misses.size}):`,
    "",
    ...[...misses.values()].map((m) => `- ${m}`),
    "",
  ].join("\n"));
  assert.ok(ok / rows >= 0.97, `right scenario ${pct(ok, rows)} (goal ≥ 97%)`);
});
