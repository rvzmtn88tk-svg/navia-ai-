// Step 3 dialogue: a Demo Mode route through all situations; at each stage
// the required questions, everyday rephrasings and no-data questions; after
// EVERY answer the navigator is asked "чому ти так відповів?". Writes
// test/reports/navigator-dialogue.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Navigator } from "../src/ai/navigator/navigator";
import { sevenSituations } from "./support/navigatorScenarios";

const PLAN: Record<string, string[]> = {
  driving: ["Куди далі?", "далеко ще?", "Я правильно їду?", "а если сигнал совсем пропадёт?", "какие пробки впереди?"],
  degraded: ["Що з GPS?", "що взагалі відбувається?", "а если я собьюсь с пути, что будет?"],
  lost: ["Що робити, пропав сигнал?", "Через скільки поворот?", "Де я?", "почему ты сейчас так ответил?", "яка погода в Борисполі?"],
  recovered: ["Статус", "як сигнал?"],
  alert: ["Де найближче укриття?", "Що з тривогою?", "Повтори", "куди бігти?"],
  offroute: ["Я на правильній дорозі?", "Здається, я звернув не туди", "Куди далі?"],
  normal: ["Коли приїдемо?", "як справи?", "яка температура на вулиці?"],
};

test("dialogue with 'why did you answer so' after every answer", async () => {
  const sits = await sevenSituations();
  const rows: string[] = [];
  let n = 0;
  for (const key of ["driving", "degraded", "lost", "recovered", "alert", "offroute", "normal"]) {
    const sit = sits.find((x) => x.key === key)!;
    const nav = new Navigator();
    for (const q of PLAN[key]!) {
      const c0 = process.cpuUsage();
      const r = nav.ask(q, sit.snapshot);
      const c = process.cpuUsage(c0);
      const why = nav.ask("чому ти так відповів?", sit.snapshot);
      assert.equal(why.intent, "explain");
      assert.doesNotMatch(r.text, /не знаю/i);
      const grounded = r.used.filter((f) => f !== "lastReply").length > 0 ? `так: ${r.used.slice(0, 4).join(", ")}` : r.intent === "repeat" ? "повтор попередньої" : "ні";
      rows.push(`| ${sit.name} | ${q} | ${r.text.replace(/\n/g, " ").replace(/\|/g, "/")} | ${why.text.replace(/\n/g, " ").replace(/\|/g, "/")} | ${grounded}${r.missing.length ? `; немає: ${r.missing.join(", ")}` : ""} | ${((c.user + c.system) / 1000).toFixed(2)} |`);
      n++;
    }
  }
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-dialogue.md"), ["# NAVIA navigator — dialogue with “why”", "", "| Ситуація | Питання | Відповідь | «Чому ти так відповів?» | З реальних даних | мс (CPU) |", "|---|---|---|---|---|---|", ...rows, ""].join("\n"));
  console.log(`${n} rows`);
  assert.ok(n >= 25);
});
