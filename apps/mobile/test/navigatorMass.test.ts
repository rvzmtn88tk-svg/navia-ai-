// Mass test for the NAVIA navigator: every generated question (20 categories
// × dozens of phrasings × 9 forms: slang, surzhyk, typos, emotions, cut-off)
// in each of 7 Demo Mode situations. For every answer: category, situation,
// question, answer, intent, snapshot fields used, CPU time, and flags:
//   misunderstood — the intent does not answer this need;
//   contradiction — says the opposite of the snapshot (GPS fine while lost…);
//   invented      — a distance / time that is not in the snapshot;
//   generic       — empty or the "can't tell" fallback where a need was clear.
// Writes test/reports/navigator-mass.md (statistics, weakest categories,
// 50 worst cases with the navigator's own "why" answer) and .json.
// Re-run after any change to the navigator: `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Navigator } from "../src/ai/navigator/navigator";
import { formatDistance } from "../src/i18n/format";
import type { Snapshot } from "../src/ai/navigator/snapshot";
import { allQuestions, CATEGORIES } from "./support/questionGenerator";
import { sevenSituations, type Scenario } from "./support/navigatorScenarios";

type Outcome = "grounded" | "honest" | "misunderstood" | "contradiction" | "invented" | "generic";
type Row = { cat: string; catName: string; kind: string; sit: string; q: string; a: string; intent: string; used: string[]; missing: string[]; cpuMs: number; outcome: Outcome; why: string };

/** Every distance / age the answer may state, formatted as the navigator formats them. */
function allowedNumbers(s: Snapshot): Set<string> {
  const out = new Set<string>();
  const addDist = (m: number | null | undefined) => { if (m != null && Number.isFinite(m)) out.add(formatDistance(m, "uk").replace(/\s/g, " ")); };
  addDist(s.route?.remainingM);
  addDist(s.route?.next?.distanceM);
  for (const list of Object.values(s.places)) for (const p of list ?? []) addDist(p.distanceM);
  const pm = (v: number | null | undefined) => { if (v != null) { out.add(`±${Math.max(1, Math.round(v))} м`); out.add(`${Math.max(1, Math.round(v))} м`); } };
  pm(s.gnss.accuracyM); pm(s.position.uncertaintyM);
  if (s.gnss.sinceFixS != null) { out.add(`${Math.max(1, Math.round(s.gnss.sinceFixS))} с`); out.add(`${Math.max(1, Math.round(s.gnss.sinceFixS / 60))} хв`); }
  for (const list of Object.values(s.places)) for (const p of list ?? []) out.add(`${Math.round(p.distanceM)} м`);
  return out;
}

function judge(s: Snapshot, accept: string[], cat: string, intent: string, text: string, used: string[], missing: string[]): { outcome: Outcome; why: string } {
  if (!text.trim()) return { outcome: "generic", why: "порожня відповідь" };
  if (/не знаю/i.test(text)) return { outcome: "generic", why: "«не знаю»" };
  const lower = text.toLowerCase();
  // Contradictions with the snapshot.
  if (s.gnss.mode === "navigator" && /gps у нормі/i.test(text)) return { outcome: "contradiction", why: "каже «GPS у нормі», а сигнал втрачено" };
  if (s.gnss.mode === "normal" && intent !== "explain" && /сигнал gps втрачено|режимі штурмана/i.test(text)) return { outcome: "contradiction", why: "каже «втрачено», а GPS у нормі" };
  if (s.alert?.active === false && /тривога у вашому районі — йдіть|повітряна тривога у вашому/i.test(text)) return { outcome: "contradiction", why: "каже про тривогу, якої немає" };
  if (s.alert?.active && ["alert", "status", "shelter"].includes(intent) && !/тривог/i.test(lower)) return { outcome: "contradiction", why: "тривога активна, а відповідь про неї мовчить" };
  if (!s.route && /до «/.test(text) && intent !== "explain") return { outcome: "contradiction", why: "говорить про маршрут, якого немає" };
  // Invented numbers.
  const allowed = allowedNumbers(s);
  for (const m of text.matchAll(/±?\d+(?:,\d+)?\s(?:км|м|с|хв)(?![а-яіїє])/g)) {
    const token = m[0].replace(/\s/g, " ");
    if (!allowed.has(token) && !allowed.has(token.replace(/^±/, "")) && !/хв$/.test(token)) return { outcome: "invented", why: `число «${token}» не з даних` };
  }
  if (!accept.includes(intent)) return { outcome: intent === "unknown" ? "generic" : "misunderstood", why: `розпізнано як «${intent}», треба ${accept.join("/")}` };
  if (intent === "noData" || missing.length > 0) return { outcome: "honest", why: `чесно: немає ${missing.join(", ") || "таких даних"}` };
  if (used.length === 0 && intent !== "repeat") return { outcome: "generic", why: "відповідь без даних" };
  void cat;
  return { outcome: "grounded", why: `з даних: ${used.slice(0, 4).join(", ")}` };
}

test("navigator mass test: 13 000+ generated questions × 7 situations", async () => {
  const situations: Scenario[] = await sevenSituations();
  const questions = allQuestions();
  const rows: Row[] = [];
  for (const sit of situations) {
    for (const q of questions) {
      const nav = new Navigator();
      // "Repeat" and "why" need a previous answer in the conversation.
      if (q.category.key === "repeat" || q.category.key === "explain") nav.ask("Куди далі?", sit.snapshot);
      const c0 = process.cpuUsage();
      const r = nav.ask(q.text, sit.snapshot);
      const c = process.cpuUsage(c0);
      const j = judge(sit.snapshot, q.category.accept, q.category.key, r.intent, r.text, r.used, r.missing);
      rows.push({ cat: q.category.key, catName: q.category.name, kind: q.kind, sit: sit.name, q: q.text, a: r.text.replace(/\n/g, " "), intent: r.intent, used: r.used, missing: r.missing, cpuMs: (c.user + c.system) / 1000, ...j });
    }
  }

  const n = rows.length;
  const count = (o: Outcome[]) => rows.filter((r) => o.includes(r.outcome)).length;
  const pct = (k: number) => `${((100 * k) / n).toFixed(1)} %`;
  const grounded = count(["grounded"]), honest = count(["honest"]);
  const failed = count(["misunderstood", "contradiction", "invented", "generic"]);
  const cpu = rows.map((r) => r.cpuMs).sort((a, b) => a - b);
  const avg = cpu.reduce((a, b) => a + b, 0) / cpu.length;
  const p95 = cpu[Math.floor(0.95 * (cpu.length - 1))]!;

  const byCat = CATEGORIES.map((c) => {
    const rs = rows.filter((r) => r.cat === c.key);
    const f = rs.filter((r) => !["grounded", "honest"].includes(r.outcome)).length;
    return { key: c.key, name: c.name, total: rs.length, fail: f, rate: f / rs.length };
  }).sort((a, b) => b.rate - a.rate);
  const byKind = [...new Set(rows.map((r) => r.kind))].map((k) => {
    const rs = rows.filter((r) => r.kind === k);
    return { k, total: rs.length, fail: rs.filter((r) => !["grounded", "honest"].includes(r.outcome)).length };
  });
  const byOutcome = (["grounded", "honest", "misunderstood", "generic", "contradiction", "invented"] as Outcome[]).map((o) => `${o}: ${count([o])} (${pct(count([o]))})`);

  // 50 worst: contradictions and invented facts first, then misunderstood,
  // then "can't tell"; spread over categories; with the navigator's "why".
  const rank: Record<Outcome, number> = { contradiction: 0, invented: 1, misunderstood: 2, generic: 3, honest: 9, grounded: 9 };
  const failures = rows.filter((r) => rank[r.outcome] < 9).sort((a, b) => rank[a.outcome] - rank[b.outcome]);
  const worst: Row[] = [];
  const seen = new Map<string, number>();
  for (const r of failures) { const key = `${r.cat}|${r.outcome}`; if ((seen.get(key) ?? 0) >= 4) continue; seen.set(key, (seen.get(key) ?? 0) + 1); worst.push(r); if (worst.length >= 50) break; }
  for (const r of failures) { if (worst.length >= 50) break; if (!worst.includes(r)) worst.push(r); }
  const situationsByName = new Map(situations.map((s) => [s.name, s]));
  const worstWithWhy = worst.map((r) => {
    const nav = new Navigator();
    const sn = situationsByName.get(r.sit)!.snapshot;
    nav.ask(r.q, sn);
    return { ...r, navWhy: nav.ask("чому ти так відповів?", sn).text.replace(/\n/g, " ") };
  });

  const summary = [
    `Вопросов сгенерировано: ${questions.length} (20 категорий × формулировки × 9 форм), ситуаций: ${situations.length}, прогонов: ${n}.`,
    `Ответ из реальных данных снимка: ${grounded} (${pct(grounded)})`,
    `Честный отказ / «данных нет» там, где их действительно нет: ${honest} (${pct(honest)})`,
    `Провалы: ${failed} (${pct(failed)}) — ${byOutcome.slice(2).join(", ")}`,
    `Время ответа (CPU): среднее ${avg.toFixed(2)} мс, p95 ${p95.toFixed(2)} мс, максимум ${cpu.at(-1)!.toFixed(2)} мс`,
  ];
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-mass.json"), JSON.stringify({ summary, byCat, byKind, rows }, null, 0));
  writeFileSync(join(dir, "navigator-mass.md"), [
    "# NAVIA navigator — mass test", "", "Generated by `apps/mobile/test/navigatorMass.test.ts`.", "", ...summary.map((s) => `- ${s}`), "",
    "## Провалы по категориям (слабые сверху)", "", "| Категория | Прогонов | Провалов | % |", "|---|---|---|---|",
    ...byCat.map((c) => `| ${c.name} | ${c.total} | ${c.fail} | ${(100 * c.rate).toFixed(1)} |`), "",
    "## Провалы по форме вопроса", "", "| Форма | Прогонов | Провалов | % |", "|---|---|---|---|",
    ...byKind.map((k) => `| ${k.k} | ${k.total} | ${k.fail} | ${((100 * k.fail) / k.total).toFixed(1)} |`), "",
    "## 50 худших случаев (с ответом штурмана на «чому ти так відповів?»)", "", "| # | Ситуация | Категория | Вопрос | Ответ | Флаг | Почему (автоматически) | «Чому так?» — штурман |", "|---|---|---|---|---|---|---|---|",
    ...worstWithWhy.map((r, i) => `| ${i + 1} | ${r.sit} | ${r.catName} | ${r.q} | ${r.a.slice(0, 160).replace(/\|/g, "/")} | ${r.outcome} | ${r.why} | ${r.navWhy.slice(0, 200).replace(/\|/g, "/")} |`), "",
  ].join("\n"));
  console.log(summary.join("\n"));
  console.log("weakest:", byCat.slice(0, 6).map((c) => `${c.key} ${(100 * c.rate).toFixed(1)}%`).join(", "));
  console.log("by form:", byKind.map((k) => `${k.k} ${((100 * k.fail) / k.total).toFixed(1)}%`).join(", "));
  assert.ok(n >= 10_000);
  assert.equal(count(["contradiction"]), 0, "no answer contradicts the engine state");
  assert.equal(count(["invented"]), 0, "no invented numbers");
});
