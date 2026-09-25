// Demo Mode: a gradual GNSS loss (jamming onset) must raise the warning
// during degradation — well before the loss — and the loss itself must be
// reported within ~4 s of the last fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoEngine } from "../src/demo-engine";
import { DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_POIS } from "../src/demo-data";

test("demo: gradual GNSS loss → warning at the degradation stage, then loss", async () => {
  const engine = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await engine.start();
  for (let i = 0; i < 8; i++) assert.equal(engine.tick(1).gnss, "NORMAL", "healthy before the scenario");
  engine.simulateGradualGnssLoss();
  let warnAt: number | null = null, lostAt: number | null = null;
  const timeline: string[] = [];
  for (let s = 1; s <= 30; s++) {
    const st = engine.tick(1);
    timeline.push(`${s}s:${st.gnss}/${st.gnssTrend?.level}±${Math.round(st.gnssTrend?.accuracyM ?? 0)}`);
    if (warnAt == null && (st.gnss === "DEGRADED" || st.gnssTrend?.level === "degrading")) warnAt = s;
    if (lostAt == null && st.gnss === "LOST") lostAt = s;
  }
  assert.ok(warnAt != null && lostAt != null, timeline.join(" "));
  assert.ok(warnAt! < lostAt! - 5, `warning at ${warnAt}s must come well before the loss at ${lostAt}s — ${timeline.join(" ")}`);
  const lastFix = 14; // fixes stop after the one at 14 s
  assert.ok(lostAt! - lastFix <= 4, `loss reported ${lostAt! - lastFix}s after the last fix`);
});

test("demo: 'Lose GPS' is reported within ~3 s, not instantly and not minutes later", async () => {
  const engine = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await engine.start();
  for (let i = 0; i < 6; i++) engine.tick(1);
  engine.simulateGnssLoss();
  const states = [1, 2, 3, 4].map(() => engine.tick(1).gnss);
  assert.equal(states[0], "DEGRADED", "one missed fix = warning");
  assert.ok(states.includes("LOST"), `lost within 4 s: ${states.join(",")}`);
});
