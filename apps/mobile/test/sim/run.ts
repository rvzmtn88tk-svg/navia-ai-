// Navigator simulator — command line (programme 5.6):
//   npm run navigator:sim            (≥ 100 000 runs, ~1–2 min)
//   npm run navigator:sim -- 3       (3 random value sets per situation: quick)
// Writes test/reports/navigator-sim.csv (every run) and navigator-sim.md
// (statistics per category, the 5 acceptance criteria, the 150 worst cases).
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCriteria, runSimulation } from "./navigatorSimulator";

const sets = Number(process.argv[2] ?? 23);
const dir = join(__dirname, "..", "reports");
mkdirSync(dir, { recursive: true });
const csv = createWriteStream(join(dir, "navigator-sim.csv"));
const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
csv.write("id,situation,category,form,question,answer,intent,source_field,honest_flag,fail_flag,outcome,reason,latency_ms\n");

(async () => {
  const t0 = Date.now();
  const res = await runSimulation({ numericSets: sets, onRow: (r) => csv.write([r.id, r.situation, `${r.letter} ${r.category}`, r.form, r.question, r.answer, r.intent, r.sourceField, r.honest ? 1 : 0, r.fail ? 1 : 0, r.outcome, r.reason, r.latencyMs.toFixed(3)].map(esc).join(",") + "\n") });
  csv.end();
  const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(2)} %`;
  const crit = checkCriteria(res);
  const md = [
    "# NAVIA — симулятор штурмана", "", `Згенеровано \`npm run navigator:sim -- ${sets}\` за ${((Date.now() - t0) / 1000).toFixed(0)} с. Кожен прогін — рядок у navigator-sim.csv.`, "",
    `**Формула:** ${res.formula}`, `**Прогонів:** ${res.runs}`, "",
    "## Критерії приймання (частина 5.4)", "", "| Критерій | Значення | Виконано |", "|---|---|---|", ...crit.map((c) => `| ${c.name} | ${c.value} | ${c.ok ? "так" : "НІ"} |`), "",
    "## Уся вибірка", "", `- обґрунтовані: ${res.all.grounded} (${pct(res.all.grounded, res.all.total)})`, `- чесні відмови / перепитування: ${res.all.honest} (${pct(res.all.honest, res.all.total)})`, `- провали: ${res.all.fail} (${pct(res.all.fail, res.all.total)}) — ${Object.entries(res.all.byOutcome).filter(([k]) => !["grounded", "honest"].includes(k)).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
    `- затримка (CPU+wall, мс): середня ${res.all.latency.avg.toFixed(3)}, p95 ${res.all.latency.p95.toFixed(3)}, максимум ${res.all.latency.max.toFixed(3)}`,
    `- частка перепитувань (уточнювальних питань): ${(100 * res.clarifyShare).toFixed(2)} %`,
    `- довжина (2.5): відповідей не в кризі ≤ 3 речень — ${pct(res.lengthOk, res.lengthChecked)}`,
    `- криза (Б, Г, З + критичний тон): довших за 3 речення — ${pct(res.crisisLong.reduce((a, c) => a + c.long, 0), res.crisisLong.reduce((a, c) => a + c.total, 0))} (${res.crisisLong.map((c) => `${c.key}: ${pct(c.long, c.total)}`).join("; ")})`, "",
    "## По категоріях", "", "| Категорія | Формулювань | Прогонів | Обґрунтовані | Чесні | Провали | Затримка сер / p95 / max, мс |", "|---|---|---|---|---|---|---|",
    ...res.perCategory.map((c) => `| ${c.letter}. ${c.name} | ${c.variants} | ${c.stats.total} | ${pct(c.stats.grounded, c.stats.total)} | ${pct(c.stats.honest, c.stats.total)} | ${pct(c.stats.fail, c.stats.total)} | ${c.stats.latency.avg.toFixed(3)} / ${c.stats.latency.p95.toFixed(3)} / ${c.stats.latency.max.toFixed(3)} |`), "",
    `## ${res.worst.length} найгірших випадків`, "", "| # | Ситуація | Кат. | Питання | Відповідь | Флаг | Причина (автоматично) | «Чому так?» — штурман |", "|---|---|---|---|---|---|---|---|",
    ...res.worst.map((w, i) => `| ${i + 1} | ${w.situation} | ${w.letter} | ${w.question.replace(/\|/g, "/")} | ${w.answer.slice(0, 180).replace(/\|/g, "/")} | ${w.outcome} | ${w.reason.replace(/\|/g, "/")} | ${w.why.slice(0, 200).replace(/\|/g, "/")} |`), "",
  ].join("\n");
  writeFileSync(join(dir, "navigator-sim.md"), md);
  writeFileSync(join(dir, "navigator-sim-worst.json"), JSON.stringify(res.worst, null, 1));
  console.log(md.split("## По категоріях")[0]);
  for (const c of res.crisisLong) { console.log(`CRISIS ${c.key}: ${c.long}/${c.total}`); for (const e of c.examples) console.log("   ", e.slice(0, 260)); }
  console.log(res.perCategory.map((c) => `${c.letter} ${c.key}: fail ${pct(c.stats.fail, c.stats.total)}`).join("\n"));
})();
