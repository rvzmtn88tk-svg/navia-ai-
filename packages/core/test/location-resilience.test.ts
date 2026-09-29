// GNSS loss, tunnels, parking garages, drift, jumps, internet loss and app
// suspension — end to end through NavigationEngine({ resilient }) and the
// voice guidance the app speaks. Each test drives a deterministic car and
// feeds the engine what the phone's sensors would report (test/helpers/drive.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridGraph, straightRoadGraph, startDrive, latLon, type Tick } from "./helpers/drive";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import type { Route, RouteRequest, RoutingProvider } from "../src/route-engine";
import { haversineMeters } from "../src/geodesy";
import { PositionSmoother } from "../src/position-smoother";
import { TripPlanner } from "../src/trip-planner";
import { EngineCopilotRuntime } from "../src/copilot/runtime";
import { NaviaCopilot } from "../src/copilot/copilot";
import { LLMUnavailableError, type LLMClient } from "../src/copilot/protocol";
import { buildTripSnapshot } from "../src/copilot/trip-snapshot";
import type { NavigationState } from "../src/types";

const truthGps = () => "true" as const;
const noGps = () => null;
const spoken = (cues: { text: string }[]) => cues.map((c) => c.text).join(" | ");

test("GPS lost for 5 s: brief staleness, guidance continues, no alarm", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "route" });
  drive.run(30, { gnss: truthGps });
  const gap = drive.run(5, { gnss: noGps });
  assert.ok(gap.states.every((s) => s.positioning!.locationState === "STALE" || s.positioning!.locationState === "PRECISE" || s.positioning!.locationState === "REDUCED_ACCURACY"), gap.states.map((s) => s.positioning!.locationState).join(","));
  assert.ok(gap.states.every((s) => s.positioning!.guidance !== "none"));
  assert.ok(gap.maxErrM < 25, `err ${gap.maxErrM.toFixed(0)}`);
  assert.doesNotMatch(spoken(gap.cues), /GPS зник/);
  const back = drive.run(10, { gnss: truthGps });
  assert.equal(back.last.positioning!.gnssVerdict, "OK");
});

test("GPS lost for 30 s: dead reckoning along the route, one spoken notice, then recovery", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(25, { gnss: truthGps });
  const out = drive.run(30, { gnss: noGps });
  assert.equal(out.last.positioning!.locationState, "LOST");
  assert.equal(out.last.positioning!.source, "DEAD_RECKONING");
  assert.ok(out.maxErrM < 40, `err ${out.maxErrM.toFixed(0)}`);
  assert.equal(spoken(out.cues).match(/GPS зник/g)?.length, 1, spoken(out.cues));
  const back = drive.run(20, { gnss: truthGps });
  assert.match(spoken(back.cues), /GPS відновлено/);
  assert.equal(back.last.offRoute, false);
  assert.ok(back.errAtEndM < 20);
});

test("GPS lost for 2 min: turn announcements continue while confidence is enough; confidence falls over time", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(25, { gnss: truthGps });
  const out = drive.run(120, { gnss: noGps });
  assert.ok(out.maxErrM < 80, `err ${out.maxErrM.toFixed(0)}`);
  const conf = out.states.map((s) => s.positioning!.locationConfidence);
  assert.ok(conf[conf.length - 1]! <= conf[0]!, `confidence ${conf[0]} → ${conf[conf.length - 1]}`);
  const turnCues = out.cues.filter((c) => c.kind === "maneuver");
  assert.ok(turnCues.length >= 2, spoken(out.cues));
  assert.ok(out.states.every((s) => s.positioning!.guidance !== "exact" || (s.positioning!.uncertaintyM <= 30)));
});

test("Tunnel: GPS gone for 1.7 km, the turn after the exit is still announced, recovery without a jump", async () => {
  const graph = straightRoadGraph(3000);
  const drive = await startDrive({ graph, from: "a0", to: "dest", network: "route" });
  const inTunnel = (t: Tick) => { const x = haversineMeters(drive.truthPath[0]!, t.truth); return x > 1000 && x < 2700; };
  const smoother = new PositionSmoother();
  let maxDisplayStep = 0, prev: { lat: number; lon: number } | null = null;
  const all = drive.run(400, { gnss: (t) => (inTunnel(t) ? null : "true") });
  for (const s of all.states) {
    const p = s.position!.position;
    const shown = smoother.update(p, s.updatedAt, (s.speedMps ?? 0) * 1);
    if (prev) maxDisplayStep = Math.max(maxDisplayStep, haversineMeters(prev, shown));
    prev = shown;
  }
  const tunnelStates = all.states.filter((_, i) => i >= 100 && i < 165);
  assert.ok(tunnelStates.some((s) => s.positioning!.source === "DEAD_RECKONING"));
  assert.ok(all.cues.some((c) => c.kind === "maneuver" && /праворуч/.test(c.text)), spoken(all.cues));
  assert.ok(all.states.every((s) => !s.offRoute), "never off-route");
  assert.ok(maxDisplayStep < 25, `map marker moved ${maxDisplayStep.toFixed(0)} m in one second`);
  assert.ok(all.maxErrM < 60, `err ${all.maxErrM.toFixed(0)}`);
  assert.equal(all.last.mode, "ARRIVED");
});

test("Long tunnel with a speed change: stops giving exact distances as uncertainty grows, recovers after the exit", async () => {
  const graph = straightRoadGraph(8000);
  const drive = await startDrive({ graph, from: "a0", to: "dest", network: "route" });
  drive.run(80, { gnss: truthGps }); // 800 m at 10 m/s: cruise speed learned
  const tunnel = drive.run(480, { gnss: noGps, speed: 14, stopAtM: 7500 }); // 6.7 km in the tunnel, faster than before
  const late = tunnel.states.slice(-60);
  // After kilometres of dead reckoning it may be wrong — but then it must not claim exactness.
  // "exact" means ±30 m (1σ): allow 2σ, never more.
  tunnel.states.forEach((s, i) => {
    if (tunnel.errs[i]! > 60) assert.notEqual(s.positioning!.guidance, "exact", `exact guidance with ${tunnel.errs[i]!.toFixed(0)} m error at ${i} s`);
  });
  assert.ok(late.every((s) => s.confidenceBand !== "HIGH"));
  const exit = drive.run(60, { gnss: truthGps, speed: 10 });
  const recoveredAt = exit.states.findIndex((s, i) => exit.errs[i]! < 30 && s.positioning!.gnssVerdict === "OK");
  assert.ok(recoveredAt >= 0 && recoveredAt <= 40, `recovered after ${recoveredAt} s`);
});

test("Underground parking: no invented precise position while circling ramps without GPS; fast recovery outside", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(40, { gnss: truthGps });
  const here = drive.d;
  // 5 minutes: crawling down spiral ramps (the car turns constantly but goes nowhere on the map), no GPS.
  const garage = drive.run(300, { gnss: noGps, speed: 1.5, extraYawDps: 12, stopAtM: here });
  const lateGarage = garage.states.slice(-120);
  assert.ok(lateGarage.every((s) => s.confidenceBand !== "HIGH"), "never HIGH underground");
  const exactWhileWrong = garage.states.filter((s, i) => s.positioning!.guidance === "exact" && garage.errs[i]! > 60);
  assert.equal(exactWhileWrong.length, 0);
  const exit = drive.run(90, { gnss: truthGps });
  const recoveredAt = exit.states.findIndex((s, i) => exit.errs[i]! < 30 && s.positioning!.gnssVerdict === "OK");
  assert.ok(recoveredAt >= 0 && recoveredAt <= 45, `recovered after ${recoveredAt} s`);
  // …and once recovered it stays recovered.
  assert.ok(exit.errs.slice(recoveredAt).every((e) => e < 40), `err after recovery ${Math.max(...exit.errs.slice(recoveredAt)).toFixed(0)}`);
});

test("Urban GPS drift between buildings: stays on the road, no false off-route, reduced accuracy reported", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(20, { gnss: truthGps });
  let bx = 0, by = 0, k = 0;
  const out = drive.run(150, {
    gnss: (t) => {
      k++; bx = Math.max(-35, Math.min(35, bx + Math.sin(k * 0.37) * 6)); by = Math.max(-35, Math.min(35, by + Math.cos(k * 0.23) * 6));
      const p = latLon(t.truth, bx, by);
      return { lat: p.lat, lon: p.lon, accuracyM: 35 };
    },
  });
  assert.ok(out.states.every((s) => !s.offRoute), "no false off-route");
  assert.ok(out.maxErrM < 40, `err ${out.maxErrM.toFixed(0)}`);
  assert.ok(out.states.slice(10).every((s) => s.positioning!.locationState !== "PRECISE"));
});

test("Weak GPS (60–100 m accuracy): never reported as precise, guidance approximate at best", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(20, { gnss: truthGps });
  const out = drive.run(60, { gnss: (t) => { const p = latLon(t.truth, 25 * Math.sin(t.t), 25 * Math.cos(t.t * 0.7)); return { lat: p.lat, lon: p.lon, accuracyM: 60 + (t.t % 40) }; } });
  assert.ok(out.states.every((s) => s.positioning!.locationState !== "PRECISE"));
  assert.ok(out.states.every((s) => s.confidenceBand !== "HIGH"));
});

test("GPS position jump: one fix 300 m away is rejected — no reroute, no marker jump", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(30, { gnss: truthGps });
  const routeBefore = drive.engine.getRoute();
  let fired = false;
  const out = drive.run(20, { gnss: (t) => { if (!fired) { fired = true; const p = latLon(t.truth, 300, 0); return { lat: p.lat, lon: p.lon, accuracyM: 5 }; } return "true"; } });
  assert.ok(out.states.every((s) => !s.offRoute));
  assert.equal(drive.engine.getRoute(), routeBefore);
  let maxStep = 0;
  for (let i = 1; i < out.states.length; i++) maxStep = Math.max(maxStep, haversineMeters(out.states[i - 1]!.position!.position, out.states[i]!.position!.position));
  assert.ok(maxStep < 25, `position moved ${maxStep.toFixed(0)} m in one second`);
});

/** A routing provider that can go offline like a phone losing mobile data. */
class FlakyRouter implements RoutingProvider {
  online = true;
  constructor(private inner: RoutingProvider) {}
  route(r: RouteRequest): Promise<Route> { return this.online ? this.inner.route(r) : Promise.reject(new Error("network unavailable")); }
  match(p: Parameters<RoutingProvider["match"]>[0]) { return this.inner.match(p); }
  searchAlternatives(r: RouteRequest): Promise<Route[]> { return this.online ? this.inner.searchAlternatives(r) : Promise.reject(new Error("network unavailable")); }
}

const offlineLlm: LLMClient = { complete: () => Promise.reject(new LLMUnavailableError("network unavailable", true)) };

async function offlineSetup() {
  const graph = gridGraph();
  const router = new FlakyRouter(new DemoRoutingProvider(graph));
  const drive = await startDrive({ graph, from: "g0_0", to: "g5_5", network: "route", router });
  const planner = new TripPlanner(router);
  planner.setDestination({ label: "Офіс", location: graph.nodes.find((n) => n.id === "g5_5")!.position });
  const runtime = new EngineCopilotRuntime({ host: drive.engine, planner });
  const copilot = new NaviaCopilot({ runtime, llm: offlineLlm });
  return { drive, router, copilot, runtime };
}

test("No internet but GPS works: the active route keeps guiding; a failed reroute keeps the route; AI says it is offline", async () => {
  const { drive, router, copilot, runtime } = await offlineSetup();
  drive.run(20, { gnss: truthGps });
  router.online = false;
  drive.engine.setNetworkAvailable(false);
  const routeBefore = drive.engine.getRoute();
  await assert.rejects(drive.engine.requestRoute(drive.truth(), drive.route.geometry[drive.route.geometry.length - 1]!));
  assert.equal(drive.engine.getRoute(), routeBefore, "route kept after the reroute failed");
  const out = drive.run(60, { gnss: truthGps });
  assert.equal(out.last.networkAvailable, false);
  assert.equal(out.last.gnss, "NORMAL");
  assert.equal(out.last.positioning!.locationState, "PRECISE");
  assert.ok(out.cues.some((c) => c.kind === "maneuver"));
  assert.match(buildTripSnapshot(runtime, copilot.session), /internet=offline/);
  const reply = await copilot.ask("Куди далі?");
  assert.equal(reply.mode, "local");
  assert.match(reply.text, /недоступний/);
  assert.match(reply.text, /(праворуч|ліворуч|прямо)/);
});

test("GPS and internet lost together: dead reckoning continues and the offline co-pilot explains it truthfully", async () => {
  const { drive, router, copilot } = await offlineSetup();
  drive.run(20, { gnss: truthGps });
  router.online = false;
  drive.engine.setNetworkAvailable(false);
  const out = drive.run(40, { gnss: noGps });
  assert.equal(out.last.positioning!.source, "DEAD_RECKONING");
  assert.ok(out.maxErrM < 50);
  const reply = await copilot.ask("Що робити без GPS?");
  assert.equal(reply.mode, "local");
  assert.match(reply.text, /продовжую вести/i);
  assert.doesNotMatch(reply.text, /GPS у нормі/);
});

test("GPS returns after the car really left the route: off-route found, reroute starts from the junction ahead", async () => {
  const graph = gridGraph();
  // Route: east along row 0. Truth: turns left (north) at g0_2 while GPS is jammed.
  const drive = await startDrive({ graph, from: "g0_0", to: "g0_5", network: "graph", truthNodes: ["g0_0", "g0_1", "g0_2", "g1_2", "g2_2", "g3_2", "g4_2"] });
  drive.run(15, { gnss: truthGps });
  const out = drive.run(70, { gnss: noGps });
  const back = drive.run(15, { gnss: truthGps });
  const states: NavigationState[] = [...out.states, ...back.states];
  assert.ok(states.some((s) => s.offRoute), "off-route detected");
  const origin = drive.engine.getRerouteOrigin();
  assert.ok(origin);
  const rerouted = await drive.engine.getRoutingProvider().route({ origin: origin!, destination: graph.nodes.find((n) => n.id === "g0_5")!.position });
  drive.engine.applyRoute(rerouted);
  const after = drive.run(10, { gnss: truthGps, speed: 0 });
  assert.equal(after.last.offRoute, false);
});

test("GPS returns on the original route: no reroute, confidence back to normal", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(25, { gnss: truthGps });
  const routeBefore = drive.engine.getRoute();
  drive.run(45, { gnss: noGps });
  const back = drive.run(30, { gnss: truthGps });
  assert.equal(drive.engine.getRoute(), routeBefore);
  assert.ok(back.states.every((s) => !s.offRoute));
  assert.ok(["PRECISE", "RECOVERED", "REDUCED_ACCURACY"].includes(back.last.positioning!.locationState), back.last.positioning!.locationState);
  assert.notEqual(back.last.positioning!.guidance, "none");
});

test("App suspended for 2 minutes while driving, then foreground: the first fixes are accepted, no false spoofing alarm", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(25, { gnss: truthGps });
  drive.run(120, { gnss: truthGps, appActive: false });
  const back = drive.run(10, { gnss: truthGps });
  assert.ok(back.errAtEndM < 30, `err ${back.errAtEndM.toFixed(0)}`);
  assert.ok(back.states.every((s) => s.positioning!.locationState !== "SPOOFED"));
});

test("App suspended while parked, then foreground: position right where the car is", async () => {
  const drive = await startDrive({ graph: gridGraph(), from: "g0_0", to: "g5_5", network: "graph" });
  drive.run(25, { gnss: truthGps });
  drive.run(120, { gnss: truthGps, appActive: false, stopAtM: drive.d });
  const back = drive.run(10, { gnss: truthGps, stopAtM: drive.d });
  assert.ok(back.errAtEndM < 25, `err ${back.errAtEndM.toFixed(0)}`);
});

test("Active trip cache: a route saved before losing internet restores the plan and route after an app restart", async () => {
  const { ActiveTripCache } = await import("../src/active-trip-cache");
  const { MemoryKeyValueStore } = await import("../src/storage");
  const graph = gridGraph();
  const router = new DemoRoutingProvider(graph);
  const planner = new TripPlanner(router);
  const dest = graph.nodes.find((n) => n.id === "g5_5")!.position;
  planner.setDestination({ label: "Дім", location: dest });
  const stop = planner.addStop({ label: "АЗС", location: graph.nodes.find((n) => n.id === "g2_2")!.position }, null);
  const route = await planner.route(graph.nodes[0]!.position);
  const store = new MemoryKeyValueStore();
  const cache = new ActiveTripCache(store);
  await cache.save(planner.getPlan(), route, 1_000);
  const restoredPlanner = new TripPlanner(router);
  const cached = await cache.load(2_000);
  assert.ok(cached);
  restoredPlanner.restore(cached!.plan);
  assert.equal(restoredPlanner.getPlan().destination!.label, "Дім");
  assert.equal(restoredPlanner.getPlan().stops[0]!.id, stop.id);
  assert.equal(cached!.route.geometry.length, route.geometry.length);
  const next = restoredPlanner.addStop({ label: "Кава", location: graph.nodes[3]!.position }, null);
  assert.notEqual(next.id, stop.id, "stop ids continue after restore");
  assert.equal(await cache.load(1_000 + 13 * 3600_000), null, "yesterday's trip is not the active trip");
});

test("Voice guidance: exact, approximate and withheld distances follow the position quality", async () => {
  const { VoiceGuidance } = await import("../src/voice-guidance");
  const step = { id: "st1", roadName: "вул. Липова", maneuver: "right" as const, distanceM: 900, durationS: 90, location: { lat: 0, lon: 0 } };
  const base = {
    mode: "ACTIVE", position: null, trustedPosition: null, gnss: "NORMAL", confidence: 0.9, confidenceBand: "HIGH", speedMps: 10, headingDeg: 0,
    routeProgressM: 0, routeRemainingM: 2000, nextStep: step, nearbyLandmarks: [], offRoute: false, networkAvailable: true,
    offlineMapAvailable: false, lastTrustedFixAt: 0, updatedAt: 0,
  } as unknown as NavigationState;
  const pos = (guidance: "exact" | "approximate" | "none", locationState = "PRECISE") => ({
    source: "GNSS", gnssVerdict: "OK", gnssSuspectedSpoofing: false, uncertaintyM: 10, maneuverUncertaintyM: 10, onRouteProbability: 1,
    imuAvailable: true, secondsSinceTrustedFix: 0, locationState, guidance, locationConfidence: 0.9, lastReliablePosition: null,
  }) as NavigationState["positioning"];
  const v = new VoiceGuidance();
  assert.match(v.update({ ...base, nextManeuverDistanceM: 380, positioning: pos("exact") })[0]!.text, /^Через 400 метрів праворуч, на вул\. Липова\.$/);
  const v2 = new VoiceGuidance();
  const approx = v2.update({ ...base, nextManeuverDistanceM: 380, positioning: pos("approximate", "LOST") }).map((c) => c.text).join(" ");
  assert.match(approx, /Приблизно через 400 метрів праворуч/);
  assert.match(approx, /Звірте/);
  const v3 = new VoiceGuidance();
  const none = v3.update({ ...base, nextManeuverDistanceM: 380, positioning: pos("none", "LOST") }).map((c) => c.text).join(" ");
  assert.doesNotMatch(none, /\d+ метрів/, "no distance from a guess");
  assert.match(none, /Точна геопозиція тимчасово недоступна/);
  assert.equal(v3.update({ ...base, nextManeuverDistanceM: 300, positioning: pos("none", "LOST") }).length, 0, "said once, not every second");
});

test("Position smoother: a 60 m recovery correction glides over ~3 s; normal motion and huge corrections don't", () => {
  const s = new PositionSmoother();
  const a = { lat: 50.45, lon: 30.5 };
  s.update(a, 0);
  const moved = latLon(a, 10, 0);
  assert.ok(haversineMeters(s.update(moved, 1000, 10), moved) < 1, "normal 10 m/s motion is not smoothed");
  const corrected = latLon(moved, 60, 0);
  const shown = s.update(corrected, 2000, 0);
  const d = haversineMeters(shown, corrected);
  assert.ok(d > 20 && d < 50, `glides: ${d.toFixed(0)} m still to go`);
  const far = latLon(a, 2000, 0);
  assert.ok(haversineMeters(s.update(far, 3000, 0), far) < 1, "a 2 km relocation snaps");
});
