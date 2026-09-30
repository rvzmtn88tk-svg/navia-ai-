// Replays real trip recordings (from the phone: Settings → «Записувати поїздки»,
// exported .jsonl files) through NavigationEngine with GNSS withheld or spoofed.
//   npm run replay:trips -- trips/                 print the table
//   npm run replay:trips -- trips/ --write         also write docs/REAL_TRIPS_REPORT.md
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTripRecording, replayTrip, type ReplayOptions, type ReplayResult } from "../../packages/core/src/trip-recording";

const args = process.argv.slice(2);
const write = args.includes("--write");
const inputs = args.filter((a) => !a.startsWith("--"));
if (inputs.length === 0) { console.error("usage: replay-trips <dir|file.jsonl>… [--write]"); process.exit(2); }
const files = inputs.flatMap((p) => statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".jsonl")).map((f) => join(p, f)) : [p]).sort();

const MODES: [string, ReplayOptions][] = [
  ["GPS вимкнено після 1 хв", { outages: "full" }],
  ["Провали по 2 хв", { outages: "periodic" }],
  ["Підміна +800 м", { outages: "full", spoofOffsetM: 800 }],
];

const fmt = (v: number | null, unit = "") => (v == null ? "—" : `${v}${unit}`);
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);
const rows: string[] = [];
for (const f of files) {
  let rec;
  try { rec = parseTripRecording(readFileSync(f, "utf8")); } catch (e) { console.error(`${f}: ${(e as Error).message}`); continue; }
  for (const [name, opts] of MODES) {
    const r: ReplayResult = replayTrip(rec, opts);
    rows.push(`| ${basename(f)} | ${name} | ${Math.round(r.durationS / 60)} хв | ${fmt(r.errorM.p50, " м")} | ${fmt(r.errorM.p90, " м")} | ${fmt(r.maneuverErrorP50M, " м")} (${r.maneuvers.length}) | ${pct(r.confidentErrorShare)} | ${pct(r.coverage)} |`);
  }
}
const table = [
  "| Поїздка | Режим | Тривалість | Похибка p50 | p90 | Похибка на маневрі p50 (к-сть) | «Впевнена помилка» | Позиція є |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
].join("\n");
console.log(table);
if (write) {
  const md = `# Реальні поїздки: навігація без GPS\n\nЗгенеровано \`npm run replay:trips\` ${new Date().toISOString().slice(0, 10)} з ${files.length} запис(ів).\n\n` +
    "Кожен запис (GPS 1 Гц + датчики 10 Гц + маршрут) прогнано через `NavigationEngine` застосунку: GPS прибрано або підмінено, похибку виміряно відносно справжніх фіксів (точність ≤ 25 м). «Впевнена помилка» — частка часу, коли похибка > 50 м, а навігатор показує впевненість HIGH/MEDIUM.\n\n" +
    table + "\n";
  writeFileSync(join(import.meta.dirname ?? ".", "../../docs/REAL_TRIPS_REPORT.md"), md);
  console.log("\nwritten docs/REAL_TRIPS_REPORT.md");
}
