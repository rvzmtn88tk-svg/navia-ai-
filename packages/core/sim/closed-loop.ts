// Closed-loop GNSS-denied navigation simulation.
//
// A simulated driver who does NOT know the route drives a car through a
// road network, turning only where the navigator tells them to. The
// navigator sees only what a phone sees: GNSS fixes (normal, degraded,
// jammed or spoofed) and per-second IMU summaries (gyro yaw rate with bias
// and noise, accelerometer vibration level). A trip succeeds when the car
// physically reaches the destination. Two navigators are compared on the
// identical scenario: the existing NavigationEngine ("baseline") and the
// ResilientNavigator ("resilient").

import type { LatLon, RouteStep } from "../src/types";
import { RouteProgressEngine } from "../src/route-engine";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { NavigationEngine } from "../src/navigation-engine";
import { RoadNetwork, wrapDeg } from "../src/resilient/road-network";
import { ResilientNavigator, Rng, type NavigatorGnss, type NavigatorMotion } from "../src/resilient/resilient-navigator";
import { rerouteFromEdge } from "../src/resilient/reroute";
import { generateWorld, type SimWorld, type WorldKind } from "./world";

const TRACE = typeof process !== "undefined" && !!process.env.SIM_TRACE;
/** Experiment switch: RESILIENT_VARIANT='{"adaptiveHeadingSigma":false}' */
const VARIANT: Record<string, unknown> = typeof process !== "undefined" && process.env.RESILIENT_VARIANT ? JSON.parse(process.env.RESILIENT_VARIANT) : {};
const TRACE_TURNS = typeof process !== "undefined" && !!process.env.SIM_TRACE_TURNS;

// ---------- scenario ----------

export type Disruption =
  | "none" | "jam" | "jam_to_end" | "degraded" | "intermittent"
  | "spoof_far" | "spoof_static" | "spoof_drift_lateral" | "spoof_drift_along" | "spoof_replay" | "spoof_jumping";

export type Scenario = {
  index: number;
  seed: number;
  kind: WorldKind;
  disruption: Disruption;
  /** Spoofing preceded by a short jam (capture). */
  jamBeforeSpoof: boolean;
  disruptionStartS: number;
  /** null = lasts to the end of the trip. */
  disruptionDurationS: number | null;
  imu: boolean;
  gyroBiasDps: number;
  gyroNoiseDps: number;
  airAlert: boolean;
  /** The driver makes one wrong turn on their own during the disruption. */
  driverError: boolean;
  driverCruiseFactor: number;
  /** Chance the driver reads the street name sign at a junction (0 = night / no signs). */
  signReading: number;
};

const DISRUPTIONS: [Disruption, number][] = [
  ["none", 0.04], ["jam", 0.2], ["jam_to_end", 0.16], ["degraded", 0.08], ["intermittent", 0.06],
  ["spoof_far", 0.08], ["spoof_static", 0.07], ["spoof_drift_lateral", 0.09], ["spoof_drift_along", 0.07],
  ["spoof_replay", 0.08], ["spoof_jumping", 0.07],
];

export function sampleScenario(index: number): Scenario {
  const seed = (index * 2654435761 + 12345) >>> 0;
  const rng = new Rng(seed);
  const kr = rng.next();
  const kind: WorldKind = kr < 0.6 ? "urban" : kr < 0.8 ? "suburban" : "highway";
  let r = rng.next(), disruption: Disruption = "jam";
  for (const [d, p] of DISRUPTIONS) { if (r < p) { disruption = d; break; } r -= p; }
  const calibrated = rng.next() < 0.7; // iOS CoreMotion rotation rate is bias-compensated
  return {
    index, seed, kind, disruption,
    jamBeforeSpoof: disruption.startsWith("spoof") && rng.next() < 0.5,
    disruptionStartS: rng.uniform(25, 120),
    disruptionDurationS: disruption === "jam_to_end" ? null : rng.next() < 0.3 ? null : rng.uniform(60, 900),
    imu: rng.next() < 0.9,
    gyroBiasDps: (calibrated ? rng.uniform(-0.08, 0.08) : rng.uniform(-0.6, 0.6)),
    gyroNoiseDps: rng.uniform(0.1, 0.5),
    airAlert: rng.next() < 0.5,
    driverError: rng.next() < 0.1,
    driverCruiseFactor: rng.uniform(0.8, 1.15),
    signReading: rng.next() < 0.4 ? 0 : 0.7,
  };
}

// ---------- results ----------

export type EngineResult = {
  success: boolean;
  timeS: number;
  distanceDrivenM: number;
  wrongTurns: number;
  reroutes: number;
  errP50: number | null;
  errP95: number | null;
  errMax: number | null;
  /** Seconds (during the disruption) the navigator claimed HIGH/MEDIUM confidence while being badly wrong. */
  confidentlyWrongS: number;
  disruptionS: number;
  declaredArrival: boolean;
};

export type ScenarioResult = {
  scenario: Scenario;
  optimalM: number;
  baseline: EngineResult;
  resilient: EngineResult;
};

// ---------- engines under test ----------

type Guidance = { maneuver: RouteStep["maneuver"]; distanceM: number; turnDeg: number | null; roadName: string; uncertaintyM: number } | null;

const stepTurn = (s: RouteStep): number | null =>
  s.bearingBefore != null && s.bearingAfter != null ? wrapDeg(s.bearingAfter - s.bearingBefore) : null;

interface SimNavigator {
  init(): Promise<void>;
  step(t: number, gnss: NavigatorGnss | null, motion: NavigatorMotion | null): Promise<void>;
  guidance(): Guidance;
  position(): LatLon | null;
  confident(): "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  arrived(): boolean;
  reroutes: number;
}

class BaselineNavigator implements SimNavigator {
  private engine: NavigationEngine;
  private progress = new RouteProgressEngine();
  private lastReroute = -Infinity;
  reroutes = 0;
  constructor(private router: DemoRoutingProvider, private origin: LatLon, private destination: LatLon) {
    this.engine = new NavigationEngine({ routingProvider: router, staleAfterMs: 6000 });
  }
  async init() { await this.engine.requestRoute(this.origin, this.destination); }
  async step(t: number, g: NavigatorGnss | null) {
    if (g) this.engine.pushGnssSample({ lat: g.lat, lon: g.lon, timestamp: t * 1000, accuracyM: g.accuracyM, speedMps: g.speedMps, headingDeg: g.courseDeg });
    const s = this.engine.tick(t * 1000);
    // NavigationScreen reroutes from the engine's current position when off-route is confirmed.
    if (s.offRoute && s.position && t - this.lastReroute > 10) {
      this.lastReroute = t;
      try { await this.engine.requestRoute({ lat: s.position.position.lat, lon: s.position.position.lon }, this.destination); this.reroutes++; } catch { /* keep old */ }
    }
  }
  guidance(): Guidance {
    const s = this.engine.getState(), route = this.engine.getRoute();
    if (!route || !s.position) return null;
    const p = this.progress.computeProgress(route, s.position.position, s.speedMps);
    return p.nextStep && p.nextStepDistanceM != null ? { maneuver: p.nextStep.maneuver, distanceM: p.nextStepDistanceM, turnDeg: stepTurn(p.nextStep), roadName: p.nextStep.roadName, uncertaintyM: 0 } : null;
  }
  position() { const p = this.engine.getState().position?.position; return p ? { lat: p.lat, lon: p.lon } : null; }
  confident() { return this.engine.getState().confidenceBand; }
  arrived() { return this.engine.getState().mode === "ARRIVED"; }
}

class ResilientSim implements SimNavigator {
  private nav: ResilientNavigator;
  private lastReroute = -Infinity;
  reroutes = 0;
  constructor(private router: DemoRoutingProvider, private graphNet: RoadNetwork, private origin: LatLon, private destination: LatLon, seed: number) {
    this.nav = new ResilientNavigator(graphNet, { seed, ...VARIANT });
  }
  async init() {
    const route = await this.router.route({ origin: this.origin, destination: this.destination });
    this.nav.setRoute(route);
  }
  async step(t: number, g: NavigatorGnss | null, m: NavigatorMotion | null) {
    const est = this.nav.step({ t, gnss: g, motion: m });
    if (TRACE) {
      const nv = this.nav as unknown as { n: number; edge: Int32Array; ridx: Int32Array; w: Float64Array; spans: { edge: number }[] };
      const m = new Map<string, number>();
      for (let i = 0; i < nv.n; i++) { const k = `${nv.edge[i]}/${nv.ridx[i]}`; m.set(k, (m.get(k) ?? 0) + nv.w[i]!); }
      console.log("   parts", [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(" "), "spans", nv.spans.slice(0, 6).map((x) => x.edge).join(","));
    }
    if (TRACE) console.log(`t=${t} onW=${est.onRouteProbability.toFixed(2)} sig=${est.uncertaintyM.toFixed(0)} gnss=${est.gnss} band=${est.band} off=${est.offRoute} along=${est.routeAlongM?.toFixed(0)} next=${est.next?.maneuver}@${est.next?.distanceM.toFixed(0)} v=${est.speedMps.toFixed(1)} fix=${g ? "y" : "n"}`);
    if (est.offRoute && est.offRouteEdge && t - this.lastReroute > 8) {
      this.lastReroute = t;
      const route = await rerouteFromEdge(this.router, this.nav.net, est.offRouteEdge.edge, est.offRouteEdge.offset, this.destination);
      if (route) { this.nav.setRoute(route); this.reroutes++; }
    }
  }
  guidance(): Guidance {
    const n = this.nav.getLast()?.next;
    return n ? { maneuver: n.maneuver, distanceM: n.distanceM, turnDeg: n.turnDeg, roadName: n.roadName, uncertaintyM: n.uncertaintyM } : null;
  }
  position() { return this.nav.getLast()?.position ?? null; }
  confident() { return this.nav.getLast()?.band ?? "UNKNOWN"; }
  arrived() { return this.nav.getLast()?.arrived ?? false; }
}

// ---------- truth: car, driver, sensors ----------

function shortestDistancesTo(net: RoadNetwork, target: number): Float64Array {
  const d = new Float64Array(net.nodes.length).fill(Infinity);
  d[target] = 0;
  const done = new Uint8Array(net.nodes.length);
  // incoming edges per node
  const incoming: number[][] = net.nodes.map(() => []);
  for (const e of net.edges) incoming[e.to]!.push(e.index);
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < d.length; i++) if (!done[i] && d[i]! < best) { best = d[i]!; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const ei of incoming[u]!) { const e = net.edges[ei]!; if (d[u]! + e.length < d[e.from]!) d[e.from] = d[u]! + e.length; }
  }
  return d;
}

export async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  const rng = new Rng(sc.seed ^ 0x9e3779b9);
  const world: SimWorld = generateWorld(rng, sc.kind);
  const truthNet = RoadNetwork.fromDemoGraph(world.graph);
  const nodeIdx = new Map(truthNet.nodes.map((n, i) => [n.id, i]));
  const originNode = nodeIdx.get(world.origin)!, destNode = nodeIdx.get(world.destination)!;
  const originLL = truthNet.toLatLon(truthNet.nodes[originNode]!.x, truthNet.nodes[originNode]!.y);
  const destLL = truthNet.toLatLon(truthNet.nodes[destNode]!.x, truthNet.nodes[destNode]!.y);
  const distToDest = shortestDistancesTo(truthNet, destNode);
  const optimalM = distToDest[originNode]!;
  const router = new DemoRoutingProvider(world.graph);

  const baseline = await runEngine(sc, world, truthNet, originNode, destNode, distToDest, new BaselineNavigator(router, originLL, destLL));
  const resilient = await runEngine(sc, world, truthNet, originNode, destNode, distToDest,
    new ResilientSim(router, RoadNetwork.fromDemoGraph(world.graph), originLL, destLL, sc.seed));
  return { scenario: sc, optimalM, baseline, resilient };
}

async function runEngine(
  sc: Scenario, world: SimWorld, net: RoadNetwork, originNode: number, destNode: number, distToDest: Float64Array, nav: SimNavigator,
): Promise<EngineResult> {
  // Identical random streams for both engines: the world, the sensors and the
  // driver's habits only diverge where the navigator's instructions differ.
  const rng = new Rng(sc.seed ^ 0x51ed270b);
  await nav.init();

  // Start on the edge leaving the origin that points toward the destination.
  const outs = net.out[originNode]!;
  let edge = outs.reduce((best, e) => (net.edges[e]!.length + distToDest[net.edges[e]!.to]! < net.edges[best]!.length + distToDest[net.edges[best]!.to]! ? e : best), outs[0]!);
  let off = 0, v = 0, t = 0, heading = net.edges[edge]!.bearing, driven = 0;
  const cruiseBase = rng.uniform(world.cruise[0], world.cruise[1]) * sc.driverCruiseFactor;
  let cruise = cruiseBase, nextCruiseChange = rng.uniform(20, 60);
  let planned: number | null = null;
  let stopUntil = -1;
  let wrongTurns = 0;
  const budget = Math.max(3 * (distToDest[originNode]! / cruiseBase), distToDest[originNode]! / cruiseBase + 600);
  const errors: number[] = [];
  let confidentlyWrong = 0, disruptionS = 0;
  let driverErrorAt = sc.driverError ? sc.disruptionStartS + rng.uniform(20, 200) : Infinity;

  // GNSS error state.
  let biasX = 0, biasY = 0;
  const gnssSigma = rng.uniform(2, 6);
  const spoofDir = rng.uniform(0, 360);
  const spoofRate = rng.uniform(0.3, 3);
  const replayDelay = Math.floor(rng.uniform(15, 120));
  const far = { x: rng.uniform(-60_000, 60_000), y: rng.uniform(-60_000, 60_000) };
  const truthTrack: { x: number; y: number; v: number; h: number }[] = [];
  let jumpTarget = { x: 0, y: 0 }, nextJump = 0;
  const accelMoving = rng.uniform(0.13, 0.5), accelIdle = rng.uniform(0.02, 0.07);
  const dStart = sc.disruptionStartS;
  const dEnd = sc.disruptionDurationS == null ? Infinity : dStart + sc.disruptionDurationS;
  const jamLead = sc.jamBeforeSpoof ? rng.uniform(5, 30) : 0;
  let arrived = false;

  while (t < budget) {
    t += 1;
    // --- driver decides the next edge ~60 m before a junction ---
    const e = net.edges[edge]!;
    const toNode = e.length - off;
    if (planned == null && toNode <= 60) {
      planned = decideNext(net, edge, toNode, nav.guidance(), rng, t >= driverErrorAt, sc.signReading);
      if (t >= driverErrorAt) driverErrorAt = Infinity;
    }
    // --- speed ---
    if (t >= nextCruiseChange) { cruise = cruiseBase * rng.uniform(0.8, 1.2); nextCruiseChange = t + rng.uniform(20, 60); }
    let target = cruise;
    if (planned != null && toNode <= 40 && Math.abs(net.turn(edge, planned)) > 30) target = Math.min(target, 6);
    if (t < stopUntil) target = 0;
    v += Math.max(-3, Math.min(2, target - v));
    if (v < 0) v = 0;
    // --- move ---
    off += v;
    driven += v;
    while (off >= net.edges[edge]!.length) {
      const endNode = net.edges[edge]!.to;
      if (endNode === destNode) { arrived = true; break; }
      const nxt = planned ?? decideNext(net, edge, 0, nav.guidance(), rng, false, sc.signReading);
      planned = null;
      if (nxt < 0) { off = net.edges[edge]!.length; v = 0; break; }
      const optimalNext = distToDest[endNode]!;
      if (net.edges[nxt]!.length + distToDest[net.edges[nxt]!.to]! > optimalNext + 1) {
        wrongTurns++;
        if (TRACE_TURNS && nav instanceof ResilientSim) {
          const est = nav.position(); const pp = est ? net.toLocal(est) : null; const tp = net.pointOn(edge, net.edges[edge]!.length);
          console.log(`WRONG t=${t} node=${endNode} turn=${net.turn(edge, nxt).toFixed(0)} g=${JSON.stringify(nav.guidance())} err=${pp ? Math.hypot(pp.x - tp.x, pp.y - tp.y).toFixed(0) : "-"} band=${nav.confident()} dis=${t >= dStart && t < dEnd}`);
        }
      }
      off -= net.edges[edge]!.length;
      edge = nxt;
      if (net.out[endNode]!.length >= 3 && rng.next() < world.stopProb) { stopUntil = t + rng.uniform(5, 45); v = Math.min(v, 3); }
    }
    if (arrived) break;
    // --- true heading (rate-limited), yaw rate ---
    const tgtH = net.edges[edge]!.bearing;
    const dh = wrapDeg(tgtH - heading);
    const step = Math.max(-25, Math.min(25, dh));
    heading = (heading + step + 360) % 360;
    const yawTrue = step;
    const pos = net.pointOn(edge, off);
    truthTrack.push({ x: pos.x, y: pos.y, v, h: heading });

    // --- sensors ---
    const inDisruption = t >= dStart && t < dEnd;
    if (inDisruption && sc.disruption !== "none") disruptionS++;
    biasX = Math.max(-8, Math.min(8, biasX + rng.normal() * 0.5));
    biasY = Math.max(-8, Math.min(8, biasY + rng.normal() * 0.5));
    let gnss: NavigatorGnss | null = null;
    const normalFix = (sigma: number, acc: number, bx = biasX, by = biasY): NavigatorGnss => {
      const ll = net.toLatLon(pos.x + bx + rng.normal() * sigma, pos.y + by + rng.normal() * sigma);
      return { ...ll, accuracyM: acc, speedMps: Math.max(0, v + rng.normal() * 0.3), courseDeg: v > 2 ? (heading + rng.normal() * 3 + 360) % 360 : null };
    };
    const spoofFix = (x: number, y: number, speed: number, course: number | null): NavigatorGnss => ({
      ...net.toLatLon(x + rng.normal() * 2, y + rng.normal() * 2), accuracyM: rng.uniform(3, 8), speedMps: speed, courseDeg: course,
    });
    if (!inDisruption || sc.disruption === "none") {
      gnss = rng.next() < 0.03 ? null : normalFix(gnssSigma, gnssSigma * 1.5 + 2);
    } else {
      const since = t - dStart;
      const d = sc.disruption;
      if (d === "jam" || d === "jam_to_end") gnss = null;
      else if (d === "degraded") gnss = rng.next() < 0.1 ? null : normalFix(rng.uniform(10, 35), rng.uniform(20, 60), biasX * 5, biasY * 5);
      else if (d === "intermittent") gnss = rng.next() < 0.6 ? null : normalFix(gnssSigma * 2, gnssSigma * 3);
      else if (since < jamLead) gnss = null;
      else if (d === "spoof_far") gnss = spoofFix(far.x + Math.sin((spoofDir * Math.PI) / 180) * v * since, far.y + Math.cos((spoofDir * Math.PI) / 180) * v * since, v, spoofDir);
      else if (d === "spoof_static") gnss = spoofFix(far.x / 4, far.y / 4, 0, null);
      else if (d === "spoof_drift_lateral") {
        const k = spoofRate * (since - jamLead);
        gnss = spoofFix(pos.x + Math.sin((spoofDir * Math.PI) / 180) * k, pos.y + Math.cos((spoofDir * Math.PI) / 180) * k, v, v > 2 ? heading : null);
      } else if (d === "spoof_drift_along") {
        const k = spoofRate * (since - jamLead);
        gnss = spoofFix(pos.x + Math.sin((heading * Math.PI) / 180) * k, pos.y + Math.cos((heading * Math.PI) / 180) * k, v + spoofRate, v > 2 ? heading : null);
      } else if (d === "spoof_replay") {
        const past = truthTrack[Math.max(0, truthTrack.length - 1 - replayDelay)]!;
        gnss = spoofFix(past.x, past.y, past.v, past.v > 2 ? past.h : null);
      } else if (d === "spoof_jumping") {
        if (t >= nextJump) { jumpTarget = { x: pos.x + rng.uniform(-5000, 5000), y: pos.y + rng.uniform(-5000, 5000) }; nextJump = t + rng.uniform(10, 60); }
        gnss = spoofFix(jumpTarget.x, jumpTarget.y, rng.uniform(0, 20), rng.uniform(0, 360));
      }
    }
    let motion: NavigatorMotion | null = null;
    if (sc.imu) {
      const handling = rng.next() < 0.002; // phone picked up / bumped
      motion = {
        yawRateDps: yawTrue + sc.gyroBiasDps + rng.normal() * sc.gyroNoiseDps + (handling ? rng.normal() * 30 : 0),
        accelStd: (v < 0.3 ? accelIdle : accelMoving) * rng.uniform(0.75, 1.25) + (handling ? 1.5 : 0),
      };
    }

    if (TRACE && nav instanceof ResilientSim) console.log(`truth edge=${edge} off=${off.toFixed(0)} v=${v.toFixed(1)}`);
    await nav.step(t, gnss, motion);

    // --- metrics ---
    const est = nav.position();
    if (est) {
      const p = net.toLocal(est);
      const err = Math.hypot(p.x - pos.x, p.y - pos.y);
      errors.push(err);
      if (inDisruption && sc.disruption !== "none") {
        const band = nav.confident();
        if ((band === "HIGH" && err > 50) || (band === "MEDIUM" && err > 150)) confidentlyWrong++;
      }
    }
  }
  errors.sort((a, b) => a - b);
  const q = (p: number) => (errors.length ? errors[Math.min(errors.length - 1, Math.floor(p * errors.length))]! : null);
  return {
    success: arrived,
    timeS: t,
    distanceDrivenM: driven,
    wrongTurns,
    reroutes: nav.reroutes,
    errP50: q(0.5), errP95: q(0.95), errMax: errors.length ? errors[errors.length - 1]! : null,
    confidentlyWrongS: confidentlyWrong,
    disruptionS,
    declaredArrival: nav.arrived(),
  };
}

/**
 * The driver's choice at the junction ahead. They follow the navigator: a
 * turn instruction is executed at the junction nearest to where the
 * navigator says the maneuver is (this one, or the next one straight on).
 */
function decideNext(net: RoadNetwork, edge: number, distToNode: number, g: Guidance, rng: Rng, makeMistake: boolean, signReading: number): number {
  const e = net.edges[edge]!;
  const outs = net.out[e.to]!.filter((o) => o !== e.reverse);
  if (outs.length === 0) return net.out[e.to]!.length ? net.out[e.to]![0]! : -1;
  if (makeMistake && outs.length > 1) return outs[Math.floor(rng.next() * outs.length)]!;
  const straight = outs.reduce((b, o) => (Math.abs(net.turn(edge, o)) < Math.abs(net.turn(edge, b)) ? o : b), outs[0]!);
  const straightOk = Math.abs(net.turn(edge, straight)) < 35;
  if (g && g.maneuver !== "arrive" && g.maneuver !== "depart" && g.roadName && rng.next() < signReading) {
    // The driver reads the street sign: turn onto the named street if this
    // junction has it, in the instructed direction, and the navigator puts the
    // maneuver within reach (announced distance ± 3σ + a block).
    const announcedBeyondNode = g.distanceM - distToNode;
    if (Math.abs(announcedBeyondNode) <= 3 * g.uncertaintyM + 60) {
      const want = g.turnDeg ?? (g.maneuver === "right" ? 90 : g.maneuver === "left" ? -90 : 0);
      for (const o of outs) {
        if (net.edges[o]!.name === g.roadName && net.edges[o]!.name !== e.name && Math.abs(wrapDeg(net.turn(edge, o) - want)) <= 50) return o;
      }
      // Sign says this is not the street: don't turn here.
      if (outs.some((o) => net.edges[o]!.name !== e.name) && Math.abs(net.turn(edge, straight)) < 35) return straight;
    }
  }
  if (g && g.maneuver !== "arrive" && g.maneuver !== "depart") {
    // The instruction applies to the junction nearest to where the navigator
    // places the maneuver: this one, or the next one straight on.
    const announcedBeyondNode = g.distanceM - distToNode;
    const nextJunction = straightOk ? net.edges[straight]!.length : Infinity;
    if (Math.abs(announcedBeyondNode) <= Math.abs(announcedBeyondNode - nextJunction)) {
      // Like following an arrow on screen: take the exit whose angle best matches the instruction.
      const want = g.turnDeg ?? (g.maneuver === "right" ? 90 : g.maneuver === "left" ? -90 : g.maneuver === "uturn" ? 180 : 0);
      let best = -1, bestErr = Infinity;
      for (const o of net.out[e.to]!) {
        if (o === e.reverse && g.maneuver !== "uturn") continue;
        const err = Math.abs(wrapDeg(net.turn(edge, o) - want));
        if (err < bestErr) { best = o; bestErr = err; }
      }
      if (best >= 0 && bestErr <= 45) return best;
    }
  }
  return straight; // no instruction for this junction: carry on along the road
}
