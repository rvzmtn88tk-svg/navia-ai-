// Replay one closed-loop scenario by index and print both engines' results.
//
//   npx tsx packages/core/sim/replay-one.ts 160
//   SIM_TRACE=1 npx tsx packages/core/sim/replay-one.ts 160        # per-second navigator trace
//   SIM_TRACE_TURNS=1 npx tsx packages/core/sim/replay-one.ts 160  # every wrong turn with the guidance given
//
// Scenario i is the same one the Monte Carlo run used (seeded by index).

import { sampleScenario, runScenario } from "./closed-loop";

const i = Number(process.argv[2]);
if (!Number.isInteger(i) || i < 0) {
  console.error("usage: replay-one.ts <scenario index>");
  process.exit(2);
}
const r = await runScenario(sampleScenario(i));
console.log(JSON.stringify({ scenario: r.scenario, optimalM: Math.round(r.optimalM), baseline: r.baseline, resilient: r.resilient }, null, 2));
