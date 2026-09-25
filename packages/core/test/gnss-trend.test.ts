// Early warning before GNSS loss, and fast loss detection from the receiver's
// own update rhythm (not a fixed timeout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GnssTrendMonitor } from "../src/gnss-trend";
import { NavigationEngine } from "../src/navigation-engine";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { demoGraph } from "./fixtures/demo-graph";

test("trend: a clean 1 Hz stream with jitter never raises a warning", () => {
  const m = new GnssTrendMonitor();
  let t = 0;
  for (let i = 0; i < 60; i++) {
    t += 1000 + ((i * 37) % 7 - 3) * 100; // 700..1300 ms
    m.push(4 + (i % 5), t);
    const mid = m.evaluate(t + 500, true);
    assert.equal(mid.level, "stable", `false warning at fix ${i}: ${mid.reasons.join(",")}`);
  }
});

test("trend: rising accuracy is flagged as degrading before the fixes become untrusted", () => {
  const m = new GnssTrendMonitor();
  let firstWarningAccuracy: number | null = null;
  for (let i = 0; i < 20; i++) {
    const acc = 5 + i * 4; // 5 → 81 m, 4 m worse every second
    m.push(acc, i * 1000);
    const tr = m.evaluate(i * 1000 + 200, true);
    if (tr.level === "degrading" && firstWarningAccuracy == null) firstWarningAccuracy = acc;
  }
  assert.ok(firstWarningAccuracy != null && firstWarningAccuracy < 40, `first warning at ±${firstWarningAccuracy} m (untrusted is ±80 m)`);
});

test("trend: first missed fix → degrading (~2 s), ≈3 missed → lost (~3 s), while moving", () => {
  const m = new GnssTrendMonitor();
  for (let i = 0; i <= 10; i++) m.push(5, i * 1000);
  const last = 10_000;
  assert.equal(m.evaluate(last + 1200, true).level, "stable");
  const overdue = m.evaluate(last + 2200, true);
  assert.equal(overdue.level, "degrading");
  assert.deepEqual(overdue.reasons, ["fix_overdue"]);
  assert.equal(m.evaluate(last + 3100, true).level, "lost");
});

test("trend: a slower receiver rhythm (2 s) scales the thresholds", () => {
  const m = new GnssTrendMonitor();
  for (let i = 0; i <= 8; i++) m.push(6, i * 2000);
  const last = 16_000;
  assert.equal(m.evaluate(last + 3000, true).level, "stable");
  assert.equal(m.evaluate(last + 4500, true).level, "degrading");
  assert.equal(m.evaluate(last + 6500, true).level, "lost");
});

test("trend: standing still, silence is not a warning", () => {
  const m = new GnssTrendMonitor();
  for (let i = 0; i <= 5; i++) m.push(5, i * 1000);
  assert.equal(m.evaluate(25_000, false).level, "stable");
});

test("engine: moving at 15 m/s, the loss is reported ~3 s after the last fix (was ~9 s)", async () => {
  const engine = new NavigationEngine({ routingProvider: new DemoRoutingProvider(demoGraph) });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  let lat = 50.4501, lon = 30.5234;
  for (let i = 0; i <= 10; i++) {
    lon += 0.00021; // ≈15 m east per second
    engine.pushGnssSample({ lat, lon, timestamp: i * 1000, accuracyM: 5, speedMps: 15, headingDeg: 90 }, i * 1000);
    engine.tick(i * 1000);
  }
  const lastFix = 10_000;
  let warnedAt: number | null = null, lostAt: number | null = null;
  for (let t = lastFix + 100; t <= lastFix + 12_000; t += 100) {
    const s = engine.tick(t);
    if (warnedAt == null && (s.gnssTrend?.level === "degrading" || s.gnss === "DEGRADED")) warnedAt = t;
    if (lostAt == null && s.gnss === "LOST") lostAt = t;
  }
  assert.ok(warnedAt != null && lostAt != null && warnedAt < lostAt, `warned at +${(warnedAt ?? 0) - lastFix} ms, lost at +${(lostAt ?? 0) - lastFix} ms`);
  assert.ok(lostAt! - lastFix <= 3_500, `lost reported +${lostAt! - lastFix} ms after the last fix (≈${Math.round((lostAt! - lastFix) / 1000 * 15)} m at 54 km/h)`);
});

test("engine: gradual degradation shows the warning while GNSS is still usable, before any loss", async () => {
  const engine = new NavigationEngine({ routingProvider: new DemoRoutingProvider(demoGraph) });
  await engine.requestRoute({ lat: 50.4501, lon: 30.5234 }, { lat: 50.4501, lon: 30.5366 });
  let lon = 30.5234;
  let warned: { t: number; gnss: string } | null = null;
  let lostAt: number | null = null;
  // Accuracy worsens 5 → 45 m over 10 s, fixes then thin out (2 s, 3 s), then stop.
  const times = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15].map((s) => s * 1000);
  let next = 0;
  for (let t = 0; t <= 22_000; t += 250) {
    // Fixes arrive in real time order, interleaved with the engine clock.
    while (next < times.length && times[next]! <= t) {
      lon += 0.0002;
      const at = times[next]!;
      engine.pushGnssSample({ lat: 50.4501, lon, timestamp: at, accuracyM: Math.min(45, 5 + next * 4), speedMps: 12, headingDeg: 90 }, at);
      next++;
    }
    const s = engine.tick(t);
    if (!warned && s.gnssTrend?.level === "degrading") warned = { t, gnss: s.gnss };
    if (lostAt == null && s.gnss === "LOST" && t > 0) lostAt = t;
  }
  assert.ok(warned, "a warning was raised");
  assert.ok(lostAt != null && warned!.t < lostAt, `warning at ${warned!.t} ms, loss at ${lostAt} ms`);
});

test("trend: starting to move after standing still is not 'fixes slowing'", () => {
  const m = new GnssTrendMonitor();
  // Standing: iOS sends a fix every ~15 s.
  for (let i = 0; i < 5; i++) m.push(5, i * 15_000, true);
  // Driving off: 1 Hz.
  let t = 4 * 15_000;
  for (let i = 1; i <= 6; i++) { t += 1000; m.push(5, t, false); assert.equal(m.evaluate(t + 300, true).level, "stable", `false warning ${i} s after moving off`); }
  assert.ok(m.expectedIntervalMs() <= 1000, `rhythm learnt from moving fixes: ${m.expectedIntervalMs()} ms`);
});

test("engine: a cached, older fix replayed by the OS does not flip GNSS to unstable", async () => {
  const engine = new NavigationEngine({ routingProvider: new DemoRoutingProvider(demoGraph) });
  let lon = 30.5234;
  for (let i = 0; i <= 5; i++) { lon += 0.00014; engine.pushGnssSample({ lat: 50.4501, lon, timestamp: i * 1000, accuracyM: 5, speedMps: 10, headingDeg: 90 }, i * 1000); engine.tick(i * 1000); }
  // Replay of an older fix (e.g. getCurrentPosition returning its cache).
  engine.pushGnssSample({ lat: 50.4501, lon: lon - 0.0003, timestamp: 4_300, accuracyM: 65, speedMps: 10, headingDeg: 90 }, 5_400);
  assert.equal(engine.tick(5_400).gnss, "NORMAL");
});
