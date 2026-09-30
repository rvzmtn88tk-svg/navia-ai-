// LIVE check "one brain": questions the on-device templates used to answer
// ("де я", "що з GPS", "скільки ще", "де укриття", "мені страшно", small talk)
// now go to the co-pilot. Real model through the NAVIA proxy, real Kyiv data
// (see kyiv-world.ts). Deterministic checks over the tool trace and the reply.
//   NAVIA_BACKEND_URL=https://… NAVIA_BACKEND_TOKEN=… npx tsx packages/core/eval/one-brain-live.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kyivCopilot, loadFx, STREETS } from "./kyiv-world";
import { replyLanguage } from "../src/copilot/copilot";

const here = dirname(fileURLToPath(import.meta.url));
const METRO = loadFx("kyiv-kharkivska-pozniaky");
type R = { text: string; tools: string[]; words: number };
type Check = [string, (r: R) => boolean];
const called = (r: R, t: string) => r.tools.includes(t);
const noCoords = (r: R) => !/\d{2}\.\d{4,}/.test(r.text);
const noSafeClaim = (r: R) => !/(безпечн|безопасн|\bsafe\b)/i.test(r.text);
const approxWords = /(приблизн|приблиз|орієнтовн|десь|близько|ймовірно|скоріше|мабуть|можливо|около|примерно|вероятно|скорее|возможно|≈|about|approximately|probably)/i;
const streetWords = STREETS.map((s) => s.split(",")[0]!.replace(/^(вулиця|проспект|бульвар|провулок|площа)\s+/i, "").split(" ").slice(-1)[0]!).filter((w) => w.length > 3);
const namesStreet = (r: R) => streetWords.some((w) => r.text.includes(w.slice(0, Math.max(4, w.length - 2))));

const S: { name: string; opts: Parameters<typeof kyivCopilot>[0]; say: string; checks: Check[] }[] = [
  { name: "де я (GPS ok)", opts: { fx: METRO, atM: 3000 }, say: "де я зараз?", checks: [["where_am_i called", (r) => called(r, "where_am_i")], ["names the real street", namesStreet], ["no coordinates", noCoords]] },
  { name: "що з GPS (ok)", opts: { fx: METRO, atM: 3000 }, say: "що з GPS?", checks: [["does not claim GPS is lost", (r) => !/(втрач|пропав|нема(є)? сигнал|lost)/i.test(r.text)], ["short (≤ 35 words)", (r) => r.words <= 35]] },
  { name: "скільки ще (route)", opts: { fx: METRO, atM: 3000 }, say: "скільки ще їхати?", checks: [["gives distance or time", (r) => /(км|кілометр|километр|хв|хвил|минут)/i.test(r.text)], ["short (≤ 35 words)", (r) => r.words <= 35]] },
  { name: "укриття", opts: { fx: METRO, atM: 3000, alert: { active: false, area: "м. Київ", source: "NEPTUN" } }, say: "де найближче укриття?", checks: [["get_safety_info called", (r) => called(r, "get_safety_info")], ["never says safe", noSafeClaim], ["no coordinates", noCoords]] },
  { name: "тривога", opts: { fx: METRO, atM: 3000, alert: { active: true, area: "м. Київ", since: Date.now() - 12 * 60_000, source: "NEPTUN" } }, say: "що з тривогою?", checks: [["get_safety_info called", (r) => called(r, "get_safety_info")], ["says it is active", (r) => /(тривог|alert)/i.test(r.text) && !/(немає тривоги|тривоги немає|відбій)/i.test(r.text)], ["never says safe", noSafeClaim]] },
  { name: "мені страшно", opts: { fx: METRO, atM: 3000 }, say: "мені страшно", checks: [["short (≤ 40 words)", (r) => r.words <= 40], ["never says safe", noSafeClaim]] },
  { name: "аптека поруч", opts: { fx: METRO, atM: 3000 }, say: "де найближча аптека?", checks: [["searches the map", (r) => called(r, "search_near") || called(r, "search_along_route")], ["no coordinates", noCoords]] },
  { name: "анекдот", opts: { fx: METRO, atM: 3000 }, say: "расскажи анекдот", checks: [["short (≤ 45 words)", (r) => r.words <= 45], ["answers in Russian", (r) => replyLanguage(r.text) === "ru"]] },
  { name: "де я (GPS lost)", opts: { fx: METRO, atM: 3000, lostS: 90 }, say: "где я сейчас?", checks: [["where_am_i called", (r) => called(r, "where_am_i")], ["says it is approximate", (r) => approxWords.test(r.text)], ["no coordinates", noCoords]] },
  { name: "де я (±90 m only)", opts: { fx: METRO, atM: 3000, approxAccuracyM: 90 }, say: "де я?", checks: [["where_am_i called", (r) => called(r, "where_am_i")], ["says it is approximate", (r) => approxWords.test(r.text)]] },
];

async function main() {
  if (!process.env.NAVIA_BACKEND_URL) { console.error("Set NAVIA_BACKEND_URL and NAVIA_BACKEND_TOKEN"); process.exit(2); }
  const lines = [`# Live check: one brain (situation questions → the co-pilot)`, ``, `Run ${new Date().toISOString()} · real model through the NAVIA proxy · real Kyiv data (Bazhana Ave: OSM tiles, Valhalla route, Nominatim reverse, KMDA shelters).`, ``];
  let pass = 0, total = 0; const ms: number[] = [];
  for (const s of S) {
    const t0 = Date.now();
    const reply = await kyivCopilot(s.opts).ask(s.say);
    const dt = Date.now() - t0; ms.push(dt);
    const r: R = { text: reply.text, tools: (reply.trace ?? []).map((x) => x.tool), words: reply.text.split(/\s+/).filter(Boolean).length };
    lines.push(`## ${s.name}`, ``, `**Водій:** ${s.say}`, ``, `**NAVIA:** ${reply.text}`, ``, `Tools: ${r.tools.join(", ") || "none"} · ${(dt / 1000).toFixed(1)} s · mode ${reply.mode}`, ``);
    for (const [n, c] of s.checks) { const ok = reply.mode === "llm" && c(r); total++; if (ok) pass++; lines.push(`- ${ok ? "PASS" : "FAIL"} ${n}`); }
    lines.push(``);
  }
  ms.sort((a, b) => a - b);
  lines.splice(3, 0, `**Result: ${pass}/${total} checks pass** · p50 ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s`, ``);
  writeFileSync(join(here, "..", "..", "..", "docs", "AI_ONE_BRAIN_LIVE.md"), lines.join("\n"));
  console.log(`${pass}/${total} checks pass → docs/AI_ONE_BRAIN_LIVE.md`);
}
main().catch((e) => { console.error(e); process.exit(1); });
