// Fix 4/10: unstable GPS → warning; GPS lost → navigator mode (voice + text,
// and the co-pilot knows it); GPS back → message. Driven through the real
// Demo Mode engine; every message is checked against the engine state.
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine, type NavigationState } from "@navia/core";
import { NavigatorModeTracker, modeFacts, modeMessage, navigatorModeOf, type ModeEvent } from "../src/navigation/navigatorMode";
import { gpsDetails } from "../src/engine/liveStatus";
import { worldGps } from "../src/ai/worldGps";
import { answer, detectIntent, type CopilotWorld } from "../src/ai/copilotBrain";
import { actionWords, type StepLike } from "../src/voice/guidance";

function facts(s: NavigationState) {
  const w = s.nextStep ? actionWords(s.nextStep as StepLike, "uk") : null;
  return modeFacts(s, { hasRoute: true, next: w && s.nextStep?.maneuver !== "arrive" ? { text: w.road ? `${w.action} на ${w.road}` : w.action, distanceM: s.nextStepDistanceM ?? null } : null });
}

function world(s: NavigationState): CopilotWorld {
  const w = s.nextStep ? actionWords(s.nextStep as StepLike, "uk") : null;
  return {
    lang: "uk", now: Date.now(), places: {}, landmarks: [], remote: false,
    gps: worldGps(s, { hasPosition: !!s.position }),
    route: { destination: "Бориспіль (Демо)", mode: "car", remainingM: s.routeRemainingM, etaS: s.etaSeconds ?? null, offRoute: s.offRoute, landmarkCount: 0, ...(w ? { next: { ...w, distanceM: s.nextStepDistanceM ?? null } } : {}) },
  };
}

test("Demo Mode: degradation warning → navigator mode → recovery, with a co-pilot that knows the current state", async () => {
  const demo = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await demo.start();
  const tracker = new NavigatorModeTracker();
  const log: string[] = [];
  const events: { t: number; e: ModeEvent; s: NavigationState }[] = [];
  let t = 0;
  const step = () => {
    const s = demo.tick(1);
    t++;
    const e = tracker.update(s, facts(s), "uk", t * 1000);
    if (e) { events.push({ t, e, s }); log.push(`t=${String(t).padStart(3)} s  gnss=${s.gnss.padEnd(8)} ${e.from ?? "—"} → ${e.to}  [${e.spoken ? "голос + екран" : "екран"}] ${e.text}`); }
    return s;
  };
  const ask = (q: string, s: NavigationState) => {
    const r = answer(q, world(s));
    log.push(`t=${String(t).padStart(3)} s  ШТУРМАН ← «${q}»\n          → ${r.text.split("\n")[0]}`);
    return r;
  };

  // Stage 0: normal driving.
  let s: NavigationState = demo.getState();
  for (let i = 0; i < 10; i++) s = step();
  assert.equal(s.gnss, "NORMAL");
  assert.equal(navigatorModeOf(s), "normal");
  const calm = ask("Що робити, пропав сигнал?", s);
  assert.match(calm.text, /^Зараз сигнал GPS у нормі \(±5 м\)/, "with a good signal it says so, not 'lost'");

  // Stage 1: jamming starts — the signal degrades gradually, then is lost.
  log.push(`t=${String(t).padStart(3)} s  ▶ Demo: simulateGradualGnssLoss() (РЕБ)`);
  demo.simulateGradualGnssLoss();
  let firstDegradedTick: number | null = null;
  let firstLostTick: number | null = null;
  while (firstLostTick == null && t < 200) {
    s = step();
    if (firstDegradedTick == null && (s.gnss === "DEGRADED" || s.gnssTrend?.level === "degrading")) firstDegradedTick = t;
    if (s.gnss === "LOST") firstLostTick = t;
    if (firstDegradedTick === t && firstLostTick == null) {
      const e = events.at(-1)!;
      assert.equal(e.t, t, "the warning is raised on the same tick the engine reports the degradation");
      assert.equal(e.e.kind, "degraded");
      assert.ok(e.e.spoken, "spoken");
      const acc = gpsDetails(s).accuracyM;
      if (acc != null) assert.match(e.e.text, new RegExp(`±${Math.round(acc)} м`), "the accuracy in the message is the engine's");
      const r = ask("Що з GPS?", s);
      assert.match(r.text, /слабшає|нестабільний/);
    }
  }
  assert.ok(firstDegradedTick != null && firstLostTick != null);
  assert.ok(firstDegradedTick! < firstLostTick!, `warning at t=${firstDegradedTick} s, before the loss at t=${firstLostTick} s`);

  // Stage 2: GNSS lost → navigator mode on the same tick.
  const lostEvent = events.find((x) => x.e.kind === "navigator")!;
  assert.equal(lostEvent.t, firstLostTick, "navigator mode is announced on the tick the engine reports LOST");
  assert.ok(lostEvent.e.spoken);
  assert.match(lostEvent.e.text, /^Сигнал GPS втрачено\. Режим штурмана: веду вас за маршрутом за рахунком шляху/);
  const nextNow = actionWords(lostEvent.s.nextStep as StepLike, "uk");
  assert.ok(lostEvent.e.text.includes(nextNow.action), `names the real next maneuver (${nextNow.action})`);
  for (let i = 0; i < 12; i++) s = step();
  assert.equal(s.gnss, "LOST");
  assert.equal(navigatorModeOf(s), "navigator");
  assert.equal(detectIntent("Що робити, пропав сигнал?"), "noGps");
  const lostAnswer = ask("Що робити, пропав сигнал?", s);
  const age = gpsDetails(s).lastTrustedFixAgeS!;
  assert.match(lostAnswer.text, /^Сигнал GPS втрачено/);
  assert.match(lostAnswer.text, /режимі штурмана: веду за маршрутом за рахунком шляху/);
  assert.ok(lostAnswer.text.includes(`${age} с тому`), `states the real time since the last trusted fix (${age} s)`);
  assert.ok(lostAnswer.text.includes(`Наступний маневр: ${actionWords(s.nextStep as StepLike, "uk").action}`), "names the real next maneuver");
  assert.ok(lostAnswer.actions.some((a) => a.kind === "confirmTurn"), "offers “I've turned”");
  assert.doesNotMatch(lostAnswer.text, /у нормі|стабільний/);

  // Stage 3: signal back.
  log.push(`t=${String(t).padStart(3)} s  ▶ Demo: restoreGnss()`);
  demo.restoreGnss();
  let backTick: number | null = null;
  while (backTick == null && t < 400) { s = step(); if (navigatorModeOf(s) !== "navigator") backTick = t; }
  const back = events.at(-1)!;
  assert.equal(back.t, backTick);
  assert.equal(back.e.kind, "recovered");
  assert.ok(back.e.spoken);
  assert.match(back.e.text, /^GPS відновлено \(±\d+ м\)\. Режим штурмана вимкнено/);
  for (let i = 0; i < 10; i++) s = step();
  ask("Що робити, пропав сигнал?", s);

  console.log(log.join("\n"));
  assert.deepEqual(events.map((x) => x.e.kind).filter((k, i, a) => a.indexOf(k) === i).slice(0, 3), ["degraded", "navigator", "recovered"]);
});

test("messages come from the engine facts, not fixed phrases", () => {
  const base = { gnss: "DEGRADED" as const, accuracyM: 38, uncertaintyM: null, source: "FUSED" as const, lastTrustedFixAgeS: 3, hasRoute: true };
  assert.equal(modeMessage("degraded", { ...base, reasons: "оновлення приходять рідше" }, "uk"),
    "Сигнал GPS нестабільний (точність ±38 м, оновлення приходять рідше). Маршрут збережено — якщо сигнал зникне, я поведу за ним.");
  assert.equal(modeMessage("navigator", { ...base, gnss: "LOST", accuracyM: null, uncertaintyM: 140, source: "DEAD_RECKONING", next: { text: "поверніть праворуч на вулицю Шевченка", distanceM: 400 } }, "uk"),
    "Сигнал GPS втрачено. Режим штурмана: веду вас за маршрутом за рахунком шляху, позиція приблизна (±140 м). Далі — поверніть праворуч на вулицю Шевченка, приблизно через 400 м.");
  assert.equal(modeMessage("navigator", { ...base, gnss: "LOST", hasRoute: false, lastTrustedFixAgeS: 95 }, "uk"), "Сигнал GPS втрачено. Показую останню підтверджену позицію (95 с тому).");
  assert.equal(modeMessage("recovered", { ...base, gnss: "NORMAL", accuracyM: 6 }, "uk"), "GPS відновлено (±6 м). Режим штурмана вимкнено — позицію підтверджено.");
});

test("while the signal is only degraded, the co-pilot never says it is lost (sparse fixes in between)", async () => {
  const demo = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await demo.start();
  for (let i = 0; i < 5; i++) demo.tick(1);
  demo.simulateGradualGnssLoss();
  let degradedTicks = 0;
  for (let i = 0; i < 60; i++) {
    const s = demo.tick(1);
    if (s.gnss !== "DEGRADED") continue;
    degradedTicks++;
    assert.equal(navigatorModeOf(s), "degraded");
    const r = answer("Що з GPS?", world(s));
    assert.doesNotMatch(r.text, /втрачено|режимі штурмана/, r.text);
  }
  assert.ok(degradedTicks >= 5, `${degradedTicks} degraded ticks checked`);
});

test("real NavigationEngine on a recorded Kyiv route: fixes worsen → stop (jamming) → return", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { NavigationEngine, haversineMeters, initialBearing, positionAtDistance } = await import("@navia/core");
  const { valhallaLegToRoute } = await import("../src/providers/OnlineValhallaProvider");
  const json = JSON.parse(readFileSync(join(__dirname, "fixtures/valhalla-routes/kyiv_boryspil.json"), "utf8"));
  const route = valhallaLegToRoute(json.trip.legs[0], json.trip.summary, "real");
  const engine = new NavigationEngine({ routingProvider: { route: async () => route, match: async () => ({ matchedPoints: [], roadSegmentIds: [] }), searchAlternatives: async () => [route] } });
  const g = route.geometry;
  const t0 = 1_000_000;
  const push = (sec: number, accuracyM: number) => {
    const d = sec * 12;
    const here = positionAtDistance(g, d), ahead = positionAtDistance(g, d + 12);
    engine.pushGnssSample({ lat: here.lat, lon: here.lon, timestamp: t0 + sec * 1000, accuracyM, speedMps: 12, headingDeg: haversineMeters(here, ahead) > 1 ? initialBearing(here, ahead) : null }, t0 + sec * 1000);
  };
  push(0, 5);
  await engine.requestRoute(g[0]!, g[g.length - 1]!, "car");
  const tracker = new NavigatorModeTracker();
  const log: string[] = [];
  const seen: { sec: number; e: ModeEvent; s: NavigationState }[] = [];
  for (let sec = 1; sec <= 90; sec++) {
    if (sec <= 20) push(sec, 5); // normal
    else if (sec <= 35) push(sec, 5 + (sec - 20) * 5); // jamming onset: accuracy 10 → 80 m
    else if (sec > 60) push(sec, 6); // back
    // 36–60 s: no fixes at all
    const s = engine.tick(t0 + sec * 1000);
    const e = tracker.update(s, facts(s), "uk", sec * 1000);
    if (e) { seen.push({ sec, e, s }); log.push(`t=${String(sec).padStart(3)} s  gnss=${s.gnss.padEnd(8)} mode=${(s.positionMode ?? "—").padEnd(14)} ${e.from ?? "—"} → ${e.to}: ${e.text}`); }
    if (sec === 50) { const r = answer("Що робити, пропав сигнал?", world(s)); log.push(`t= 50 s  ШТУРМАН ← «Що робити, пропав сигнал?»\n          → ${r.text.split("\n")[0]}`); assert.match(r.text, s.gnss === "LOST" ? /^Сигнал GPS втрачено/ : /^Сигнал GPS ненадійний/); assert.match(r.text, /режимі штурмана/); }
  }
  console.log(log.join("\n"));
  const kinds = seen.map((x) => x.e.kind);
  assert.ok(kinds.indexOf("degraded") >= 0 && kinds.indexOf("degraded") < kinds.indexOf("navigator"), `order: ${kinds.join(", ")}`);
  assert.ok(seen.find((x) => x.e.kind === "degraded")!.sec <= 35, "warned while fixes were still arriving");
  const nav = seen.find((x) => x.e.kind === "navigator")!;
  assert.match(nav.e.text, nav.s.gnss === "LOST" ? /^Сигнал GPS втрачено\. Режим штурмана/ : /^Сигнал GPS ненадійний — точки відкидаю\. Режим штурмана/, "the words match the engine's GNSS state");
  assert.ok(kinds.includes("recovered"));
  assert.ok(seen.find((x) => x.e.kind === "recovered")!.sec > 60);
});

test("starting navigation: no 'GPS lost' before the engine's first fix; a start without GPS is announced", async () => {
  const demo = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await demo.start();
  const tracker = new NavigatorModeTracker();
  const before = demo.getState();
  assert.equal(before.gnss, "LOST", "the demo engine starts with no fix yet");
  assert.equal(tracker.update(before, facts(before), "uk", 0), null, "no announcement at start");
  for (let i = 1; i <= 5; i++) { const s = demo.tick(1); assert.equal(tracker.update(s, facts(s), "uk", i * 1000), null, `t=${i}: all normal, nothing to say`); }
  const stale = new NavigatorModeTracker();
  const leftover = { ...before, gnss: "LOST" as const, lastTrustedFixAt: 5_000, updatedAt: 60_000 };
  assert.equal(stale.update(leftover, facts(leftover), "uk", 0), null, "a LOST state left from before the trip is not announced");
  const manual = new NavigatorModeTracker();
  const manualState = { ...before, positionMode: "MANUAL" as const };
  assert.equal(manual.update(manualState, facts(manualState), "uk", 0)?.kind, "navigator");
});
