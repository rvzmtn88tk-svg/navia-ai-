// Programme 0 / 2.4 "timeliness": a proactive message is produced on the same
// state update (tick) as the change — GNSS degraded, lost, back; air alert
// start; off route — never a tick later.
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine } from "@navia/core";
import { ProactiveMonitor } from "../src/ai/navigator/navigator";
import { buildSnapshot } from "../src/ai/navigator/snapshot";
import { NOW, worldFrom } from "./support/navigatorScenarios";
import { navigatorModeOf } from "../src/navigation/navigatorMode";

async function engine() {
  const d = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await d.start();
  return d;
}

test("GNSS degraded → navigator mode → recovered: each reported on the tick of the change", async () => {
  // The announced state is the navigator mode (normal / degraded / navigator):
  // after the signal returns the engine keeps dead reckoning until GNSS is
  // confirmed (spoofing guard) — "recovered" is said when the position really
  // comes from GNSS again, on that very tick.
  const d = await engine();
  const m = new ProactiveMonitor();
  // First look (before the trip's first fix) is not a change: start from tick 1.
  const first = d.tick(1);
  m.update(first, buildSnapshot({ state: first, world: worldFrom(first), now: NOW }), NOW);
  let prev = navigatorModeOf(first);
  const seen: string[] = [];
  const want = { degraded: "gnssDegraded", navigator: "gnssLost", normal: "gnssRecovered" } as const;
  const step = () => {
    const st = d.tick(1);
    const ev = m.update(st, buildSnapshot({ state: st, world: worldFrom(st), now: NOW }), NOW);
    const mode = navigatorModeOf(st);
    if (mode !== prev) {
      const kinds = ev.map((e) => e.kind);
      const expected = prev === "navigator" ? "gnssRecovered" : prev === "degraded" && mode === "normal" ? "gnssStable" : want[mode];
      assert.ok(kinds.includes(expected), `${prev}→${mode}: got [${kinds}] on the same tick`);
      seen.push(`${prev}→${mode}: ${kinds.join(",")}`);
      prev = mode;
    }
  };
  for (let i = 0; i < 8; i++) step();
  d.simulateGradualGnssLoss();
  for (let i = 0; i < 60; i++) step();
  d.restoreGnss();
  for (let i = 0; i < 60; i++) step();
  console.log(seen.join("\n"));
  assert.ok(seen.length >= 2);
});

test("air alert start: reported on the first snapshot where it is active", async () => {
  const d = await engine();
  const m = new ProactiveMonitor();
  const st = d.tick(1);
  assert.equal(m.update(st, buildSnapshot({ state: st, world: worldFrom(st, { alert: { active: false } }), now: NOW }), NOW).length, 0);
  const st2 = d.tick(1);
  const ev = m.update(st2, buildSnapshot({ state: st2, world: worldFrom(st2, { alert: { active: true, scope: "district", since: NOW } }), now: NOW }), NOW);
  assert.equal(ev[0]?.kind, "alertStarted");
  assert.equal(ev[0]?.priority, 100, "most urgent");
});

test("off route: reported on the tick the engine flags it", async () => {
  const d = await engine();
  const m = new ProactiveMonitor();
  for (let i = 0; i < 6; i++) { const st = d.tick(1); m.update(st, buildSnapshot({ state: st, world: worldFrom(st), now: NOW }), NOW); }
  d.simulateOffRoute();
  for (let i = 0; i < 60; i++) {
    const st = d.tick(1);
    const ev = m.update(st, buildSnapshot({ state: st, world: worldFrom(st), now: NOW }), NOW);
    if (st.offRoute) { assert.ok(ev.some((e) => e.kind === "offRoute"), "same tick"); return; }
  }
  assert.fail("off route never flagged");
});
