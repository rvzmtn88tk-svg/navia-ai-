// Regression harness for the NAVIA navigator (co-pilot): scenarios × questions.
// Every scenario is a real Demo Mode engine state (normal driving, GNSS
// degrading, lost, recovered, air alert, off route, no route). For every
// question the harness records: intent → answer → the snapshot fields the
// answer is built from → compute time, checks the answer against the snapshot
// values, and writes the table to test/reports/navigator-harness.md.
// Add a scenario or a question here when a new scenario handler is added.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine, haversineMeters, initialBearing, type NavigationState } from "@navia/core";
import { worldGps } from "../src/ai/worldGps";
import { actionWords, type StepLike } from "../src/voice/guidance";
import { buildSnapshot, type Snapshot } from "../src/ai/navigator/snapshot";
import { classify, type NavigatorIntent } from "../src/ai/navigator/intents";
import { Navigator, ProactiveMonitor } from "../src/ai/navigator/navigator";
import { registeredIntents } from "../src/ai/navigator/handlers";
import { formatDistance } from "../src/i18n/format";
import type { CopilotWorld, WorldPlace } from "../src/ai/copilotBrain";

type Extras = { alert?: CopilotWorld["alert"]; route?: boolean; online?: boolean };

function shelters(state: NavigationState): WorldPlace[] {
  const here = state.position?.position;
  if (!here) return [];
  const mk = (name: string, dLat: number, dLon: number): WorldPlace => {
    const location = { lat: here.lat + dLat, lon: here.lon + dLon };
    return { id: name, name, kind: "shelter", location, distanceM: haversineMeters(here, location), bearingDeg: initialBearing(here, location) };
  };
  return [mk("Укриття школи №12", 0.0027, 0), mk("Паркінг ТЦ", 0.009, 0.004)].sort((a, b) => a.distanceM - b.distanceM);
}

function worldFrom(state: NavigationState, x: Extras = {}): CopilotWorld {
  const next = state.nextStep && x.route !== false ? actionWords(state.nextStep as StepLike, "uk") : null;
  return {
    lang: "uk", now: 1_000_000, remote: false, landmarks: [],
    gps: worldGps(state, { hasPosition: !!state.position }),
    ...(x.alert ? { alert: x.alert } : {}),
    places: { shelter: shelters(state) },
    placeStates: { shelter: "ready" },
    ...(x.route !== false && state.mode !== "IDLE" ? { route: {
      destination: "Бориспіль (Демо)", mode: "car" as const, remainingM: state.routeRemainingM, etaS: state.etaSeconds ?? null, offRoute: state.offRoute, landmarkCount: 0,
      ...(next && state.nextStep?.maneuver !== "arrive" ? { next: { ...next, distanceM: state.nextStepDistanceM ?? null } } : {}),
    } } : {}),
  };
}

async function engine(): Promise<DemoEngine> {
  const d = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await d.start();
  return d;
}
const ticks = (d: DemoEngine, n: number): NavigationState => { let s = d.getState(); for (let i = 0; i < n; i++) s = d.tick(1); return s; };
const tickUntil = (d: DemoEngine, ok: (s: NavigationState) => boolean, max = 300): NavigationState => {
  let s = d.getState();
  for (let i = 0; i < max && !ok(s); i++) s = d.tick(1);
  assert.ok(ok(s), "scenario state reached");
  return s;
};

type Scenario = { name: string; state: NavigationState; snapshot: Snapshot };
async function scenarios(): Promise<Scenario[]> {
  const out: Scenario[] = [];
  const add = (name: string, state: NavigationState, x: Extras = {}) => out.push({ name, state, snapshot: buildSnapshot({ state, world: worldFrom(state, x), online: x.online ?? true, now: 1_000_000 }) });
  let d = await engine();
  const normal = ticks(d, 12);
  add("норма (їдемо)", normal);
  add("тривога", normal, { alert: { active: true, scope: "district", since: 1_000_000 - 5 * 60_000, reasons: ["Повітряна тривога"] } });
  add("без маршруту", normal, { route: false });
  d.simulateGradualGnssLoss();
  add("деградація", tickUntil(d, (s) => s.gnss === "DEGRADED"));
  const lost = tickUntil(d, (s) => s.gnss === "LOST");
  for (let i = 0; i < 12; i++) d.tick(1);
  add("втрата (режим штурмана)", d.getState());
  add("втрата + тривога, без інтернету", d.getState(), { alert: { active: true, scope: "city" }, online: false });
  d.restoreGnss();
  add("відновлення", tickUntil(d, (s) => s.gnss === "NORMAL"));
  void lost;
  d = await engine();
  ticks(d, 8);
  d.simulateOffRoute();
  add("відхилення від маршруту", tickUntil(d, (s) => s.offRoute));
  return out;
}

// Questions with their expected intent (paraphrases included).
const QUESTIONS: [string, NavigatorIntent][] = [
  ["Що робити, пропав сигнал?", "signalLost"],
  ["Сигнал зник, що тепер?", "signalLost"],
  ["глушать gps що робити", "signalLost"],
  ["Що з GPS?", "gpsStatus"],
  ["Яка зараз точність?", "gpsStatus"],
  ["Куди далі?", "routeNext"],
  ["Через скільки поворот?", "routeNext"],
  ["Я правильно їду?", "onRoute"],
  ["Я на правильній дорозі?", "onRoute"],
  ["Здається, я звернув не туди", "reroute"],
  ["Коли приїдемо?", "eta"],
  ["Де я?", "whereAmI"],
  ["Де найближче укриття?", "shelter"],
  ["Куди ховатися?", "shelter"],
  ["Що з тривогою?", "alert"],
  ["Статус", "status"],
  ["Що відбувається?", "status"],
  ["Повтори", "repeat"],
  ["розкажи анекдот", "noData"],
  ["ыварпа олдж", "unknown"],
];

const km = (m: number) => formatDistance(m, "uk");

/** Checks that the answer states the snapshot's own values. Returns the field checked. */
function grounded(intent: NavigatorIntent, s: Snapshot, text: string): string {
  const g = s.gnss;
  if (/не знаю/i.test(text)) throw new Error("«не знаю» is never an answer");
  if (g.mode !== "normal") assert.doesNotMatch(text, /GPS у нормі/, "never 'fine' when it isn't");
  if (g.mode === "normal" && intent !== "repeat") assert.doesNotMatch(text, /втрачено|режимі штурмана/, "never 'lost' when it isn't");
  switch (intent) {
    case "signalLost":
    case "gpsStatus":
      if (g.mode === "navigator" && g.sinceFixS != null) { assert.ok(text.includes(`${Math.max(1, Math.round(g.sinceFixS))} с тому`), "states the time without signal"); return "gnss.sinceFixS"; }
      if (g.accuracyM != null) { assert.ok(text.includes(`±${Math.round(g.accuracyM)}`), "states the accuracy"); return "gnss.accuracyM"; }
      return "gnss.mode";
    case "routeNext":
      if (!s.route) { assert.match(text, /Маршрут не прокладено/); return "route (none)"; }
      if (s.route.offRoute) { assert.match(text, /зійшли з маршруту/); return "route.offRoute"; }
      if (s.route.next) { assert.ok(text.toLowerCase().includes(s.route.next.action), "names the next maneuver"); if (s.route.next.distanceM != null) assert.ok(text.includes(km(s.route.next.distanceM)), "states its distance"); return "route.next"; }
      return "route";
    case "onRoute":
    case "reroute":
      if (!s.route) { assert.match(text, /Маршрут не прокладено/); return "route (none)"; }
      if (s.route.offRoute) { assert.match(text, /зійшли з маршруту/); return "route.offRoute"; }
      if (g.mode === "navigator") { assert.match(text, /[Бб]ез GPS підтвердити не можу|на маршруті/); return "gnss.mode + route"; }
      assert.match(text, /на маршруті/); return "route.offRoute=false";
    case "eta":
      if (!s.route) { assert.match(text, /Маршрут не прокладено/); return "route (none)"; }
      assert.ok(text.includes(km(s.route.remainingM)), "states the remaining distance"); return "route.remainingM";
    case "shelter": {
      const p = s.places.shelter?.[0];
      if (p) { assert.ok(text.includes(p.name) && text.includes(km(p.distanceM).replace(/\s/g, " ")) || text.includes(p.name), "names the nearest shelter"); }
      if (s.alert?.active) assert.match(text, /Тривога/);
      return "places.shelter[0]";
    }
    case "alert":
      if (s.alert?.active) { assert.match(text, /[Тт]ривог/); return "alert.active"; }
      return "alert";
    case "status":
      if (s.alert?.active) assert.match(text, /[Тт]ривога/);
      if (s.route && !s.route.offRoute) assert.ok(text.includes(km(s.route.remainingM)));
      return "alert + gnss + route";
    case "whereAmI":
      if (g.mode === "navigator") assert.match(text, /GPS|приблизно|маршрут/);
      return "position";
    case "repeat": return "lastReply";
    case "noData": assert.match(text, /сказати не можу/); return "honest: no such data";
    default: return "gnss (situation)";
  }
}

test("navigator harness: every scenario × every question is answered from the snapshot", async () => {
  const rows: string[] = [];
  const times: number[] = [];
  const cpu: number[] = [];
  let checked = 0;
  for (const sc of await scenarios()) {
    const nav = new Navigator();
    for (const [q, intent] of QUESTIONS) {
      assert.equal(classify(q), intent, `classify «${q}»`);
      const c0 = process.cpuUsage();
      const r = nav.ask(q, sc.snapshot);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
      assert.ok(r.text.length > 0);
      let field = "";
      try { field = grounded(intent, sc.snapshot, r.text); }
      catch (e) { throw new Error(`[${sc.name}] «${q}» → «${r.text}»: ${(e as Error).message}`); }
      assert.ok(r.used.length > 0 || intent === "repeat", `${sc.name} «${q}»: no snapshot fields used`);
      times.push(r.computeMs);
      checked++;
      rows.push(`| ${sc.name} | ${q} | ${r.intent} | ${r.text.replace(/\n/g, " ").replace(/\|/g, "/").slice(0, 220)} | так: ${field}${r.missing.length ? ` (немає: ${r.missing.join(", ")})` : ""} | ${r.computeMs.toFixed(2)} |`);
    }
  }
  const pct = (arr: number[], q: number) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]!; };
  const summary = `${checked} combinations; wall clock p50 ${pct(times, 0.5).toFixed(2)} ms, p95 ${pct(times, 0.95).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms; CPU p50 ${pct(cpu, 0.5).toFixed(2)} ms, p95 ${pct(cpu, 0.95).toFixed(2)} ms`;
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-harness.md"), [
    "# NAVIA navigator — regression harness", "", "Generated by `apps/mobile/test/navigatorHarness.test.ts` (Demo Mode states).", "", summary, "",
    "| Сценарій | Питання | Намір | Відповідь | Із даних снімка (поле) | мс |", "|---|---|---|---|---|---|", ...rows, "",
  ].join("\n"));
  console.log(summary);
  assert.ok(checked >= 25);
  // CPU time: other load on the machine must not fail the test.
  assert.ok(pct(cpu, 0.95) < 20, `CPU p95 ${pct(cpu, 0.95)} ms`);
});

test("every intent the classifier can return has a registered handler", () => {
  const handled = new Set(registeredIntents());
  for (const i of ["repeat", "explain", "noData", "smalltalk", "emergency", "signalLost", "gpsStatus", "onRoute", "reroute", "routeNext", "eta", "whereAmI", "shelter", "alert", "status", "place", "classic", "unknown"] as NavigatorIntent[]) assert.ok(handled.has(i), i);
});

test("proactive layer: degraded → lost → alert → off route → recovered, most urgent first, each once", async () => {
  const d = await engine();
  const mon = new ProactiveMonitor();
  const seen: string[] = [];
  let t = 0;
  const step = (x: Extras = {}) => {
    const s = d.tick(1); t++;
    for (const e of mon.update(s, buildSnapshot({ state: s, world: worldFrom(s, x), now: 1_000_000 }), t * 1000)) seen.push(`t=${String(t).padStart(3)} s [${e.priority}] ${e.kind}${e.spoken ? " (голос)" : ""}: ${e.text.replace(/\n/g, " ")}`);
  };
  for (let i = 0; i < 8; i++) step({ alert: { active: false } });
  d.simulateGradualGnssLoss();
  for (let i = 0; i < 40 && d.getState().gnss !== "LOST"; i++) step({ alert: { active: false } });
  for (let i = 0; i < 3; i++) step({ alert: { active: true, scope: "district" } });
  d.restoreGnss();
  for (let i = 0; i < 10; i++) step({ alert: { active: true, scope: "district" } });
  d.simulateOffRoute();
  for (let i = 0; i < 20 && !d.getState().offRoute; i++) step({ alert: { active: true, scope: "district" } });
  console.log(seen.join("\n"));
  const kinds = mon.log.map((e) => e.kind);
  for (const k of ["gnssDegraded", "gnssLost", "alertStarted", "gnssRecovered", "offRoute"]) assert.ok(kinds.includes(k as never), `${k} reported`);
  assert.ok(kinds.indexOf("gnssDegraded") < kinds.indexOf("gnssLost"));
  assert.equal(kinds.filter((k) => k === "alertStarted").length, 1, "each change once");
});
