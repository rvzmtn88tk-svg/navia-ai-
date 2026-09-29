// Acceptance run for the language model (Shturman spec, part 6): the 12
// control questions + 34 off-topic questions, each answered twice —
//   BEFORE: the on-device rules only (what the phone says without the model);
//   AFTER:  askSmart through the real NAVIA proxy (the same path as the app).
// Writes apps/mobile/test/reports/llm-eval.md: both answers word for word,
// the intent, the engine that answered and the latency of each proxy call.
//
//   NAVIA_AI_PROXY_URL=https://navia-proxy.<account>.workers.dev \
//   NAVIA_AI_APP_TOKEN=<token> npx tsx apps/mobile/scripts/evalLanguageModel.ts
//
// Without the proxy settings it stops with "BLOCKED" (exit 2): nothing is
// simulated. The "meaningful" column is a first automatic pass (an answer
// from the model that is not a refusal or a question back); a person reads
// the verbatim answers to confirm it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { askSmart, Navigator } from "../src/ai/navigator/navigator";
import { setRemoteForTests } from "../src/ai/navigator/languageEngine";
import { sevenSituations } from "../test/support/navigatorScenarios";
import { CONTROL } from "../test/support/controlQuestions";

/** Questions the rules never understood (spec part 0.1): everyday, mixed language, emotional. */
export const OFF_TOPIC: { q: string; sit: string }[] = [
  { q: "що робити якщо закінчується бензин", sit: "driving" },
  { q: "як заспокоїти дитину в укритті", sit: "alert" },
  { q: "що взяти в тривожну валізку", sit: "normal" },
  { q: "розкажи анекдот, бо я вже засинаю за кермом", sit: "driving" },
  { q: "скільки можна їхати без відпочинку", sit: "driving" },
  { q: "у мене загорілась лампочка check engine, це страшно?", sit: "driving" },
  { q: "що робити якщо пробив колесо на трасі", sit: "driving" },
  { q: "як поводитись на блокпосту", sit: "driving" },
  { q: "чи можна їхати машиною під час тривоги", sit: "alert" },
  { q: "скільки зараз коштує бензин", sit: "driving" },
  { q: "яка погода завтра у Львові", sit: "normal" },
  { q: "хто вчора виграв у футбол", sit: "normal" },
  { q: "напиши короткий вірш про дорогу", sit: "normal" },
  { q: "я дуже втомився і мені погано", sit: "driving" },
  { q: "поговори зі мною, мені самотньо в дорозі", sit: "driving" },
  { q: "як правильно тягнути машину на тросі", sit: "normal" },
  { q: "что делать если сел аккумулятор", sit: "normal" },
  { q: "как объяснить ребенку что такое тревога", sit: "alert" },
  { q: "шо робити як двигун перегрівся", sit: "driving" },
  { q: "порадь музику в дорогу", sit: "driving" },
  { q: "як економити пальне на трасі", sit: "driving" },
  { q: "What should I do if my car breaks down at night?", sit: "driving" },
  { q: "як польською сказати дякую", sit: "normal" },
  { q: "скільки буде 15 відсотків від 800", sit: "normal" },
  { q: "переклади англійською: де найближча заправка", sit: "normal" },
  { q: "у мене паніка і руки трусяться", sit: "alert" },
  { q: "що таке РЕБ і чому глушать GPS", sit: "degraded" },
  { q: "як їхати в густому тумані", sit: "driving" },
  { q: "бачу дрон над дорогою, що робити", sit: "alert" },
  { q: "що має бути в автомобільній аптечці", sit: "normal" },
  { q: "підкажи як поміняти колесо", sit: "normal" },
  { q: "хто тебе створив і як ти працюєш", sit: "normal" },
  { q: "слухай а можна мені кави за кермом кожні дві години", sit: "driving" },
  { q: "чим відрізняється відбій від кінця тривоги", sit: "alert" },
];

/** Token counts reported by the proxy for each call (for the real cost per question). */
const usages: { inputTokens: number; outputTokens: number; cacheReadTokens: number }[] = [];
// Claude Haiku 4.5 list prices, USD per million tokens (input, output, cache read) — check the current price list.
const PRICE = { input: 1, output: 5, cacheRead: 0.1 };

const REFUSAL = /недоступн|не можу визначити|відповісти на це не|Уточніть/i;

async function callProxy(url: string, token: string, question: string, facts: Record<string, unknown>) {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/understand`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-navia-app": token, "x-navia-device": "eval-script" },
    body: JSON.stringify({ question, facts }),
  });
  const body = (await res.json()) as { intent?: string; confidence?: number; answer?: string; error?: string; latencyMs?: number; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number } };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (body.usage) usages.push(body.usage);
  return body;
}

async function main(): Promise<void> {
  const url = process.env.NAVIA_AI_PROXY_URL;
  const token = process.env.NAVIA_AI_APP_TOKEN;
  if (!url || !token) {
    console.error("BLOCKED: set NAVIA_AI_PROXY_URL and NAVIA_AI_APP_TOKEN (the deployed NAVIA proxy). Nothing is simulated.");
    process.exit(2);
  }
  const sits = new Map((await sevenSituations()).map((s) => [s.key, s]));
  const latencies: number[] = [];
  let lastError: string | null = null;
  // The proxy allows 20 questions a minute per device: pace the calls.
  let lastCallAt = 0;
  setRemoteForTests(async (q, facts) => {
    const wait = lastCallAt + 3100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    const t0 = Date.now();
    try {
      const r = await callProxy(url, token, q, facts);
      latencies.push(Date.now() - t0);
      return r;
    } catch (e) {
      lastError = (e as Error).message;
      throw e;
    }
  });

  const rows: string[] = [];
  let offMeaningful = 0;
  const run = async (label: string, q: string, sit: string, before: Navigator, after: Navigator, offTopic: boolean) => {
    const s = sits.get(sit)!.snapshot;
    const b = before.ask(q, s);
    lastError = null;
    const n = latencies.length;
    const t0 = Date.now();
    const a = await askSmart(after, q, s);
    const ms = Date.now() - t0;
    const viaModel = latencies.length > n;
    const meaningful = a.engine === "llm" && !REFUSAL.test(a.text);
    if (offTopic && meaningful) offMeaningful++;
    const cell = (t: string) => t.replace(/\n/g, " ⏎ ").replace(/\|/g, "/");
    rows.push(`| ${label} | ${sits.get(sit)!.name} | ${cell(q)} | ${b.intent} | ${cell(b.text)} | ${a.intent} · ${a.engine}${lastError ? ` (${lastError})` : ""} | ${cell(a.text)} | ${viaModel ? ms : "—"} | ${offTopic ? (meaningful ? "так" : "ні") : ""} |`);
    console.log(`${label} ${a.engine} ${a.intent} ${viaModel ? `${ms} ms` : "local"} — ${a.text.slice(0, 90).replace(/\n/g, " ")}`);
  };

  const navB = new Map<string, Navigator>();
  const navA = new Map<string, Navigator>();
  const nav = (m: Map<string, Navigator>, k: string) => { const x = m.get(k) ?? new Navigator(); m.set(k, x); return x; };
  for (const c of CONTROL) await run(`K${c.n}`, c.q, c.sit, nav(navB, c.sit), nav(navA, c.sit), false);
  for (const [i, o] of OFF_TOPIC.entries()) await run(`O${i + 1}`, o.q, o.sit, new Navigator(), new Navigator(), true);
  setRemoteForTests(null);

  const sorted = [...latencies].sort((x, y) => x - y);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN);
  const summary = [
    `Proxy: ${url.replace(/\/\/([^.]+)\./, "//….")}; model calls: ${latencies.length}; latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${sorted.at(-1) ?? NaN} ms (from the machine running this script).`,
    (() => {
      if (!usages.length) return "Tokens: the proxy reported none.";
      const avg = (f: (u: (typeof usages)[number]) => number) => usages.reduce((a, u) => a + f(u), 0) / usages.length;
      const cost = avg((u) => (u.inputTokens * PRICE.input + u.outputTokens * PRICE.output + u.cacheReadTokens * PRICE.cacheRead) / 1e6);
      return `Tokens per question (average of ${usages.length}): input ${Math.round(avg((u) => u.inputTokens))}, cache read ${Math.round(avg((u) => u.cacheReadTokens))}, output ${Math.round(avg((u) => u.outputTokens))} → ≈ $${cost.toFixed(4)} per question at list prices ($${(cost * 1000).toFixed(2)} per 1000).`;
    })(),
    `Off-topic answered meaningfully (automatic first pass): ${offMeaningful}/${OFF_TOPIC.length} = ${Math.round((offMeaningful / OFF_TOPIC.length) * 100)}% (goal ≥ 90%).`,
  ];
  writeFileSync(process.env.NAVIA_EVAL_OUT ?? join(__dirname, "..", "test", "reports", "llm-eval.md"), [
    "# Language model acceptance — 12 control + 34 off-topic questions",
    "",
    `Run: ${new Date().toISOString()}`,
    "",
    ...summary.map((s) => `- ${s}`),
    "",
    "| # | Ситуація | Питання | До: інтент | До: відповідь дослівно | Після: інтент · рушій | Після: відповідь дослівно | мс | Змістовно |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
  console.log(summary.join("\n"));
}

if (require.main === module) void main();
