// Render a Monte Carlo summary (run-monte-carlo.ts output) as Markdown tables.
//
//   npx tsx packages/core/sim/render-report.ts packages/core/sim/reports/mc-100k.json

import { readFileSync } from "node:fs";

type Stats = {
  scenarios: number;
  reached_destination_pct: number;
  ci95_pct: [number, number];
  median_extra_distance_pct: number | null;
  mean_wrong_turns: number;
  median_position_error_p95_m: number | null;
  confidently_wrong_pct_of_disrupted_seconds: number | null;
};
type Pair = { baseline: Stats; resilient: Stats };
type Summary = { meta: { n: number; errors: number; seconds: number; generated: string } } & Record<string, Pair | Record<string, Pair>>;

const s = JSON.parse(readFileSync(process.argv[2] ?? "packages/core/sim/reports/mc-100k.json", "utf8")) as Summary;

const f = (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const row = (label: string, p: Pair) =>
  `| ${label} | ${p.resilient.scenarios} | **${f(p.resilient.reached_destination_pct, 1)}%** [${f(p.resilient.ci95_pct[0], 1)}–${f(p.resilient.ci95_pct[1], 1)}] | ${f(p.baseline.reached_destination_pct, 1)}% | ` +
  `${f(p.resilient.confidently_wrong_pct_of_disrupted_seconds, 1)}% | ${f(p.baseline.confidently_wrong_pct_of_disrupted_seconds, 1)}% | ` +
  `${f(p.resilient.median_position_error_p95_m)} | ${f(p.baseline.median_position_error_p95_m)} | ` +
  `${f(p.resilient.mean_wrong_turns, 2)} | ${f(p.baseline.mean_wrong_turns, 2)} | ${f(p.resilient.median_extra_distance_pct)}% | ${f(p.baseline.median_extra_distance_pct)}% |`;
const head =
  "| | scenarios | reached — resilient [95% CI] | reached — baseline | confidently wrong — R | — B | p95 error m — R | — B | wrong turns — R | — B | extra distance — R | — B |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|";

const out: string[] = [];
out.push(`Run: ${s.meta.n} scenarios, ${s.meta.errors} errored, ${Math.round(s.meta.seconds)} s, ${s.meta.generated}.`, "");
out.push("### Overall", "", head, row("all", s.overall as Pair), "");
const groups: [string, string][] = [
  ["by_disruption", "By GNSS disruption"], ["by_world", "By road network"], ["by_imu", "By motion sensors"],
  ["by_sign_reading", "By driver reading street signs"], ["by_driver_error", "By driver's own mistake"], ["by_air_alert", "By air-alert label"],
];
for (const [key, title] of groups) {
  const g = s[key] as Record<string, Pair> | undefined;
  if (!g) continue;
  out.push(`### ${title}`, "", head);
  for (const [k, p] of Object.entries(g)) out.push(row(k, p));
  out.push("");
}
console.log(out.join("\n"));
