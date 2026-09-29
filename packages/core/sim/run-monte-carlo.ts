// Monte Carlo driver for the closed-loop GNSS-denied simulation.
//
//   npx tsx packages/core/sim/run-monte-carlo.ts --n 100000 --workers 4 --out packages/core/sim/reports/mc-100k.json
//
// Scenario i is fully determined by its index (seeded), so any single case
// can be replayed with `npx tsx packages/core/sim/replay-one.ts <i>`.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScenario, runScenario, type ScenarioResult } from "./closed-loop";
import { summarize } from "./summarize";

type Row = ScenarioResult;

async function workerMain(start: number, step: number, n: number): Promise<void> {
  for (let i = start; i < n; i += step) {
    try {
      process.stdout.write(JSON.stringify({ row: await runScenario(sampleScenario(i)) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: `scenario ${i}: ${(e as Error).message}` }) + "\n");
    }
  }
}

async function main(): Promise<void> {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1]! : d; };
  const n = Number(arg("--n", "1000"));
  const workers = Number(arg("--workers", "4"));
  const out = arg("--out", "packages/core/sim/reports/mc.json");
  const t0 = Date.now();
  const rows: Row[] = [];
  const errors: string[] = [];
  await Promise.all(Array.from({ length: workers }, (_, k) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", String(k), "--step", String(workers), "--n", String(n)], { stdio: ["ignore", "pipe", "inherit"] });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const m = JSON.parse(line) as { row?: Row; error?: string };
      if (m.error) errors.push(m.error);
      if (m.row) {
        rows.push(m.row);
        if (rows.length % 1000 === 0) process.stdout.write(`\r${rows.length}/${n} scenarios, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${k} exited ${code}`))));
  })));
  process.stdout.write("\n");
  const summary = summarize(rows, { n, errors: errors.length, seconds: (Date.now() - t0) / 1000 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  // Per-scenario rows (compact) for replay/analysis, kept next to the summary.
  writeFileSync(out.replace(/\.json$/, ".rows.jsonl"), rows.map((r) => JSON.stringify({
    i: r.scenario.index, k: r.scenario.kind, d: r.scenario.disruption, imu: r.scenario.imu, alert: r.scenario.airAlert, sign: r.scenario.signReading,
    derr: r.scenario.driverError, opt: Math.round(r.optimalM),
    dis: r.resilient.disruptionS,
    // [success, wrong turns, p95 error m, confidently-wrong s, distance driven m, time s]
    b: [r.baseline.success ? 1 : 0, r.baseline.wrongTurns, Math.round(r.baseline.errP95 ?? -1), r.baseline.confidentlyWrongS, Math.round(r.baseline.distanceDrivenM), r.baseline.timeS],
    r: [r.resilient.success ? 1 : 0, r.resilient.wrongTurns, Math.round(r.resilient.errP95 ?? -1), r.resilient.confidentlyWrongS, Math.round(r.resilient.distanceDrivenM), r.resilient.timeS],
  })).join("\n") + "\n");
  if (errors.length) console.log(`${errors.length} scenarios errored, e.g. ${errors[0]}`);
  console.log(JSON.stringify(summary.overall, null, 2));
  console.log(`written ${out}`);
}

const wi = process.argv.indexOf("--worker");
if (wi >= 0) {
  const get = (k: string) => Number(process.argv[process.argv.indexOf(k) + 1]);
  void workerMain(Number(process.argv[wi + 1]), get("--step"), get("--n"));
} else {
  void main();
}
