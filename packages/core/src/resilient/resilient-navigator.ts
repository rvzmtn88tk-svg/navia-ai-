// ResilientNavigator — keeps guiding the car to its destination when GNSS
// is jammed, degraded or spoofed.
//
// A particle filter over the ROAD GRAPH, not over free space: every
// hypothesis is "the car is on edge E, O metres in, moving at V m/s". That
// constraint is what makes GNSS-free navigation possible with only phone
// sensors:
//   - between junctions the car can only move along the road, so the only
//     unknown is how far it has gone (speed error accumulates slowly);
//   - at junctions the gyroscope shows whether the car turned left, right or
//     went straight — hypotheses that disagree with the measured heading
//     change die out, which re-anchors the along-road position at every
//     turn and bend, and detects a turn off the route without GNSS;
//   - the accelerometer tells stopped from moving (traffic lights), the
//     largest source of along-road error.
// GNSS fixes are accepted only if they are consistent with this motion
// model (position gate, speed vs. stopped/moving, course change vs. gyro).
// Consistently inconsistent fixes are rejected as interference; when the
// estimate has drifted and GNSS is self-consistent and agrees with the
// gyro, the filter re-acquires it. Nothing is claimed with more certainty
// than the particle spread supports.

import type { LatLon, ConfidenceBand, RouteStep } from "../types";
import type { Route } from "../route-engine";
import { RoadNetwork, mapRouteToNetwork, wrapDeg, type RouteEdgeSpan } from "./road-network";

export type NavigatorGnss = {
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
  /** Course over ground, degrees; null when unknown (e.g. slow). */
  courseDeg: number | null;
};

/** Per-second motion summary from the phone IMU (see MotionPreprocessor). */
export type NavigatorMotion = {
  /** Heading rate about the vertical axis, deg/s, clockwise positive. */
  yawRateDps: number;
  /** Standard deviation of |acceleration| over the last second, m/s². */
  accelStd: number;
};

export type NavigatorInput = { t: number; gnss: NavigatorGnss | null; motion: NavigatorMotion | null };

export type GnssVerdict = "OK" | "DEGRADED" | "LOST" | "REJECTED";

export type NavigatorGuidance = {
  /** Index of the maneuver's step in route.steps. */
  stepIndex: number;
  maneuver: RouteStep["maneuver"];
  roadName: string;
  /** Best estimate of the distance to the maneuver. */
  distanceM: number;
  /** One-sigma uncertainty of that distance. */
  uncertaintyM: number;
  /** Signed turn angle of the maneuver (+ right), when the router provides bearings. */
  turnDeg: number | null;
};

export type NavigatorEstimate = {
  t: number;
  position: LatLon;
  headingDeg: number;
  speedMps: number;
  /** 1-sigma radius of the position estimate, metres. */
  uncertaintyM: number;
  onRouteProbability: number;
  routeAlongM: number | null;
  routeRemainingM: number | null;
  next: NavigatorGuidance | null;
  gnss: GnssVerdict;
  /** GNSS has been rejected as inconsistent with motion for a while — possible interference/spoofing. */
  gnssInconsistent: boolean;
  stationary: boolean;
  source: "GNSS" | "FUSED" | "DEAD_RECKONING";
  /** The car appears to have left the route (turned where the route does not). */
  offRoute: boolean;
  /** Where to reroute from when offRoute: the edge the car is most likely on. */
  offRouteEdge: { edge: number; offset: number } | null;
  band: ConfidenceBand;
  arrived: boolean;
  /** Seconds since a GNSS fix was last accepted, null if none yet. */
  secondsSinceAcceptedFix: number | null;
};

export type ResilientConfig = {
  particles: number;
  /** Heading-change window for the gyro likelihood, seconds. */
  headingWindowS: number;
  headingSigmaDeg: number;
  /** Probability that a car on the route follows the route at a junction. */
  followRouteProb: number;
  accelStdStationary: number;
  /** Rejected fixes in a row before trying to re-acquire GNSS. */
  reacquireAfter: number;
  /** Scale the heading tolerance with the size of the heading change (5° + 12%). */
  adaptiveHeadingSigma: boolean;
  /** Tighter gate for the first fixes after a GNSS outage. */
  probationAfterOutage: boolean;
  /** Reported uncertainty never below this fraction of the distance driven without GNSS. */
  drUncertaintyPerMetre: number;
  /**
   * Distrust GNSS whose position at gyro-detected turns is not at a junction
   * allowing that turn. Needs a real road graph: with a route-only network a
   * genuine turn off the route would look like a mismatch.
   */
  turnAnchoredCheck: boolean;
  seed: number;
};

const DEFAULT_CONFIG: ResilientConfig = {
  particles: 300,
  headingWindowS: 6,
  headingSigmaDeg: 14,
  followRouteProb: 0.9,
  accelStdStationary: 0.1,
  reacquireAfter: 8,
  adaptiveHeadingSigma: false,
  probationAfterOutage: true,
  drUncertaintyPerMetre: 0.03,
  turnAnchoredCheck: true,
  seed: 1,
};

/** Small deterministic PRNG so simulations and tests are reproducible. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  uniform(a: number, b: number): number { return a + (b - a) * this.next(); }
}

type Fix = { t: number; x: number; y: number; speed: number | null; course: number | null; psi: number | null };

export class ResilientNavigator {
  readonly net: RoadNetwork;
  private cfg: ResilientConfig;
  private rng: Rng;

  // particles
  private n: number;
  private edge: Int32Array;
  private off: Float64Array;
  private v: Float64Array;
  private cruise: Float64Array;
  private w: Float64Array;
  private ridx: Int32Array;
  private acc: Float64Array;
  private hist: Float64Array; // n * H ring of accumulated expected heading
  private H: number;
  private histPos = 0;
  private histCount = 0;

  // scratch for resampling
  private edge2: Int32Array; private off2: Float64Array; private v2: Float64Array; private cruise2: Float64Array;
  private ridx2: Int32Array; private acc2: Float64Array; private hist2: Float64Array;

  // route
  private route: Route | null = null;
  private spans: RouteEdgeSpan[] = [];
  private spanOfEdge = new Map<number, number>();
  private routeLen = 0;
  private stepAlong: number[] = [];
  private destination: { x: number; y: number } | null = null;

  // sensors
  private lastT: number | null = null;
  private psi = 0; // integrated measured heading (deg, unwrapped)
  private psiHist: Float64Array;
  private gyroBias = 0;
  private stationary = false;
  private stillCount = 0;
  private moveCount = 0;
  private hasMotion = false;
  private stopPriorApplied = false;
  /** Seconds the IMU has reported continuous motion. */
  private movingFor = 0;
  /** Recent gyro turn events (time, signed heading change, time of the sharpest heading change) for GNSS checks. */
  private gyroTurns: { t: number; dPsi: number; peakT: number; full?: number }[] = [];
  /** Consecutive gyro turns at which the accepted GNSS position was nowhere near a junction allowing that turn. */
  private turnMismatches = 0;
  /** GNSS is ignored until then: its positions disagreed with where the gyro says the car turned. */
  private distrustUntil = -Infinity;
  private incoming: number[][] = [];
  private incomingFor = -1;

  // GNSS integrity
  private initialized = false;
  private lastFixT = -Infinity;
  private lastAcceptedT = -Infinity;
  private rejected = 0;
  private candidates: Fix[] = [];
  private accepted: Fix[] = [];
  private inconsistentSince: number | null = null;
  private lastGnssSigma = 30;
  /** GNSS was re-acquired without gyro confirmation (no IMU): don't trust it fully for a while. */
  private unverifiedUntil = -Infinity;
  /** GNSS came back after an outage and no gyro turn has confirmed it yet. */
  private gnssUnverified = false;
  /** Distance driven since the last accepted fix (dead-reckoning distance). */
  private drDistance = 0;

  private offRouteStreak = 0;
  private gnssOffRouteStreak = 0;
  private unexplainedStreak = 0;
  private relocalizations = 0;
  private arrivedLatched = false;
  private last: NavigatorEstimate | null = null;

  constructor(net: RoadNetwork, config: Partial<ResilientConfig> = {}) {
    this.net = net;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.rng = new Rng(this.cfg.seed);
    const n = (this.n = this.cfg.particles);
    this.H = this.cfg.headingWindowS + 1;
    this.edge = new Int32Array(n); this.off = new Float64Array(n); this.v = new Float64Array(n);
    this.cruise = new Float64Array(n); this.w = new Float64Array(n); this.ridx = new Int32Array(n);
    this.acc = new Float64Array(n); this.hist = new Float64Array(n * this.H);
    this.edge2 = new Int32Array(n); this.off2 = new Float64Array(n); this.v2 = new Float64Array(n);
    this.cruise2 = new Float64Array(n); this.ridx2 = new Int32Array(n); this.acc2 = new Float64Array(n);
    this.hist2 = new Float64Array(n * this.H);
    this.psiHist = new Float64Array(this.H);
  }

  // ---------- route ----------

  /** Set (or replace, after a reroute) the route to follow. Existing hypotheses are kept. */
  setRoute(route: Route): void {
    this.route = route;
    this.spans = mapRouteToNetwork(this.net, route);
    this.spanOfEdge.clear();
    this.spans.forEach((s, i) => { if (!this.spanOfEdge.has(s.edge)) this.spanOfEdge.set(s.edge, i); });
    const last = this.spans[this.spans.length - 1];
    this.routeLen = last ? last.alongStart + (last.toOffset - last.fromOffset) : 0;
    const end = route.geometry[route.geometry.length - 1];
    this.destination = end ? this.net.toLocal(end) : null;
    // Along-route position of each maneuver, in the same metric as the particles.
    this.stepAlong = [];
    let cum = 0;
    const scale = route.distanceM > 0 ? this.routeLen / route.distanceM : 1;
    for (const s of route.steps) { this.stepAlong.push(cum * scale); cum += s.distanceM; }
    for (let i = 0; i < this.n; i++) this.ridx[i] = this.spanIndexFor(this.edge[i]!, this.off[i]!);
    this.offRouteStreak = 0;
    this.arrivedLatched = false;
  }

  getRouteSpans(): readonly RouteEdgeSpan[] { return this.spans; }

  private spanIndexFor(edge: number, off: number): number {
    const i = this.spanOfEdge.get(edge);
    if (i === undefined) return -1;
    const s = this.spans[i]!;
    return off >= s.fromOffset - 30 && off <= s.toOffset + 30 ? i : -1;
  }

  private alongOf(i: number): number {
    const r = this.ridx[i]!;
    if (r < 0) return -1;
    const s = this.spans[r]!;
    return s.alongStart + Math.min(s.toOffset, Math.max(s.fromOffset, this.off[i]!)) - s.fromOffset;
  }

  /** Start with all hypotheses at the start of the route (no GNSS yet). */
  initAtRouteStart(speedMps = 0): void {
    const s0 = this.spans[0];
    if (!s0) return;
    for (let i = 0; i < this.n; i++) {
      this.edge[i] = s0.edge; this.off[i] = s0.fromOffset + Math.abs(this.rng.normal()) * 5;
      this.v[i] = speedMps; this.cruise[i] = this.rng.uniform(7, 15); this.w[i] = 1 / this.n; this.ridx[i] = 0; this.acc[i] = 0;
    }
    this.hist.fill(0);
    this.initialized = true;
  }

  /** Spread hypotheses over road edges near (x, y) — used at start and to re-acquire GNSS. */
  private initAround(x: number, y: number, sigma: number, speed: number | null, course: number | null): void {
    const near = this.net.edgesNear(x, y, Math.max(40, 3 * sigma + 20));
    if (near.length === 0) return;
    const weights = near.map((c) => {
      let w = Math.exp(-(c.dist * c.dist) / (2 * sigma * sigma)) + 1e-6;
      if (course != null && speed != null && speed > 3) {
        const d = Math.abs(wrapDeg(this.net.edges[c.edge]!.bearing - course));
        w *= d < 45 ? 1 : d > 135 ? 0.02 : 0.2;
      }
      if (this.spanOfEdge.has(c.edge)) w *= 2;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < this.n; i++) {
      let r = this.rng.next() * total, k = 0;
      while (k < near.length - 1 && r > weights[k]!) { r -= weights[k]!; k++; }
      const c = near[k]!;
      const len = this.net.edges[c.edge]!.length;
      this.edge[i] = c.edge;
      this.off[i] = Math.max(0, Math.min(len, c.offset + this.rng.normal() * Math.min(sigma, 30)));
      this.v[i] = Math.max(0, (speed ?? this.rng.uniform(0, 12)) + this.rng.normal() * 1.5);
      this.cruise[i] = speed != null && speed > 4 ? speed : this.rng.uniform(7, 15);
      this.w[i] = 1 / this.n;
      this.ridx[i] = this.spanIndexFor(c.edge, this.off[i]!);
      this.acc[i] = this.psi;
    }
    for (let i = 0; i < this.n; i++) for (let h = 0; h < this.H; h++) this.hist[i * this.H + h] = this.psi;
    this.initialized = true;
  }

  // ---------- main step ----------

  step(input: NavigatorInput): NavigatorEstimate {
    const dt = this.lastT == null ? 1 : Math.max(0.05, Math.min(5, input.t - this.lastT));
    this.lastT = input.t;
    this.updateMotion(input.motion, dt);

    if (!this.initialized) {
      if (input.gnss && (input.gnss.accuracyM ?? 30) < 60) {
        const p = this.net.toLocal(input.gnss);
        this.initAround(p.x, p.y, Math.max(5, input.gnss.accuracyM ?? 20), input.gnss.speedMps, input.gnss.courseDeg);
        this.lastFixT = input.t;
      } else if (this.spans.length > 0) {
        this.initAtRouteStart();
      }
    } else {
      this.predict(dt);
      if (this.hasMotion && this.histCount >= this.H) this.weighByHeading();
      if (this.hasMotion) this.weighByMotionState();
    }
    if (this.hasMotion) this.recordGyroTurn(input.t);
    if (input.gnss && this.initialized) this.handleGnss(input.t, input.gnss);
    this.pushHistory();
    this.normalizeAndResample();
    this.last = this.estimate(input.t, input.gnss);
    return this.last;
  }

  getLast(): NavigatorEstimate | null { return this.last; }

  private updateMotion(m: NavigatorMotion | null, dt: number): void {
    this.hasMotion = m != null;
    if (!m) return;
    const still = m.accelStd < this.cfg.accelStdStationary;
    if (still) { this.stillCount++; this.moveCount = 0; } else { this.moveCount++; this.stillCount = 0; }
    if (!this.stationary && this.stillCount >= 2) this.stationary = true;
    if (this.stationary && this.moveCount >= 1) this.stationary = false;
    // While stopped, the true yaw rate is zero: learn the gyro bias.
    if (this.stationary && Math.abs(m.yawRateDps) < 3) this.gyroBias += 0.1 * (m.yawRateDps - this.gyroBias);
    this.psi += (m.yawRateDps - this.gyroBias) * dt;
    this.movingFor = this.stationary ? 0 : this.movingFor + dt;
  }

  /** Record a turn when the heading changed > 45° over the last window. */
  private recordGyroTurn(t: number): void {
    const H = this.H;
    if (this.histCount < H) return;
    // A turn is detected mid-way (heading change passes 45°); its full angle
    // is known once the window is centred on the sharpest change.
    const pending = this.gyroTurns[this.gyroTurns.length - 1];
    if (pending && pending.full == null && t >= pending.peakT + H / 2) {
      pending.full = this.psi - this.psiHist[(this.histPos + 1) % H]!;
      this.checkTurnAgainstGnss(t, { dPsi: pending.full, peakT: pending.peakT });
    }
    const d = this.psi - this.psiHist[(this.histPos + 1) % H]!;
    const last = this.gyroTurns[this.gyroTurns.length - 1];
    if (!(Math.abs(d) > 45 && (!last || t - last.t > H))) return;
    // When was the heading changing fastest? That is when the car was at the junction.
    let peakT = t - 0.5, peak = Math.abs(this.psi - this.psiHist[this.histPos]!);
    for (let k = 1; k < H - 1; k++) {
      const a = this.psiHist[(this.histPos - k + 1 + H) % H]!, b = this.psiHist[(this.histPos - k + H) % H]!;
      if (Math.abs(a - b) > peak) { peak = Math.abs(a - b); peakT = t - 0.5 - k; }
    }
    this.gyroTurns.push({ t, dPsi: d, peakT });
    while (this.gyroTurns.length > 20) this.gyroTurns.shift();
  }

  /** Edges arriving at each node (built lazily; the network can grow when routes add spurs). */
  private incomingEdges(node: number): number[] {
    if (this.incomingFor !== this.net.edges.length) {
      this.incoming = this.net.nodes.map(() => []);
      for (const e of this.net.edges) this.incoming[e.to]!.push(e.index);
      this.incomingFor = this.net.edges.length;
    }
    return this.incoming[node] ?? [];
  }

  /** Nodes within `radius` of (x, y) where the road allows a turn of about `dPsi` degrees. */
  private turnNodesNear(x: number, y: number, radius: number, dPsi: number): { node: number; exit: number }[] {
    const out: { node: number; exit: number }[] = [];
    for (let n = 0; n < this.net.nodes.length; n++) {
      const node = this.net.nodes[n]!;
      if (Math.abs(node.x - x) > radius || Math.abs(node.y - y) > radius || Math.hypot(node.x - x, node.y - y) > radius) continue;
      for (const ein of this.incomingEdges(n)) {
        for (const eout of this.net.out[n]!) {
          if (eout === this.net.edges[ein]!.reverse) continue;
          if (Math.abs(wrapDeg(this.net.turn(ein, eout) - dPsi)) <= 35) out.push({ node: n, exit: eout });
        }
      }
    }
    return out;
  }

  /** The GNSS fix closest in time to `when`, if one is within 2 s. */
  private fixAt(fixes: Fix[], when: number): Fix | null {
    let best: Fix | null = null;
    for (const f of fixes) if (Math.abs(f.t - when) <= 2 && (!best || Math.abs(f.t - when) < Math.abs(best.t - when))) best = f;
    return best;
  }

  /**
   * Turn-anchored integrity check. At the moment the gyro sees a turn the car
   * is at a junction that allows that turn. A spoof that drags the position
   * along or across the road — or replays an old track — puts the fix at
   * that moment somewhere without such a junction. Two such turns in a row
   * and GNSS is distrusted; the car is re-placed on the exits of junctions
   * that do fit the turn.
   */
  private checkTurnAgainstGnss(t: number, turn: { dPsi: number; peakT: number }): void {
    if (!this.cfg.turnAnchoredCheck || this.net.nodes.length === 0) return;
    // Accepted or rejected alike: a fix that isn't at the turn is evidence against GNSS.
    const fix = this.fixAt([...this.accepted, ...this.candidates], turn.peakT);
    if (!fix) return;
    const radius = Math.max(35, 3 * this.lastGnssSigma);
    if (this.turnNodesNear(fix.x, fix.y, radius, turn.dPsi).length > 0) { this.turnMismatches = 0; return; }
    if (++this.turnMismatches < 2) return;
    this.turnMismatches = 0;
    this.distrustUntil = t + 180;
    if (this.inconsistentSince == null) this.inconsistentSince = t;
    this.gnssUnverified = true;
    // If our own estimate was at a junction fitting the turn, GNSS hadn't
    // dragged it off (e.g. the fixes were already being rejected): keep it.
    const c = this.cloud();
    const back = Math.max(0, c.speed * (t - turn.peakT));
    if (this.turnNodesNear(c.x, c.y, Math.max(35, 2 * c.sigma) + back, turn.dPsi).length > 0) return;
    this.relocalizeAtTurn(turn.dPsi, t - turn.peakT);
  }

  /** Spread hypotheses over the exits of nearby junctions that fit a just-measured turn. */
  private relocalizeAtTurn(dPsi: number, sinceTurnS: number): void {
    const c = this.cloud();
    const exits = this.turnNodesNear(c.x, c.y, Math.max(600, 3 * c.sigma), dPsi);
    if (exits.length === 0) { this.relocalize(c.x, c.y, Math.max(400, 3 * c.sigma)); return; }
    this.relocalizations++;
    const H = this.H;
    for (let i = 0; i < this.n; i++) {
      const x = exits[Math.floor(this.rng.next() * exits.length)]!;
      const len = this.net.edges[x.exit]!.length;
      this.edge[i] = x.exit;
      this.off[i] = Math.max(0, Math.min(len, this.v[i]! * sinceTurnS + this.rng.normal() * 10));
      this.ridx[i] = this.spanIndexFor(x.exit, this.off[i]!);
      this.w[i] = 1 / this.n;
      this.acc[i] = this.psi;
      for (let h = 0; h < H; h++) this.hist[i * H + h] = this.psi;
    }
    this.psiHist.fill(this.psi);
    this.drDistance = Math.max(this.drDistance, 300);
  }

  private pushHistory(): void {
    const H = this.H;
    this.histPos = (this.histPos + 1) % H;
    this.psiHist[this.histPos] = this.psi;
    for (let i = 0; i < this.n; i++) this.hist[i * H + this.histPos] = this.acc[i]!;
    if (this.histCount < H) this.histCount++;
  }

  private predict(dt: number): void {
    const net = this.net;
    let vMean = 0;
    for (let i = 0; i < this.n; i++) vMean += this.w[i]! * this.v[i]!;
    this.drDistance += vMean * dt;
    for (let i = 0; i < this.n; i++) {
      let v = this.v[i]!;
      // Each hypothesis has its own cruise speed (learned from GNSS while it
      // was available, drifting slowly) and returns to it after braking for a
      // turn or pulling away from a stop.
      this.cruise[i] = Math.max(3, Math.min(40, this.cruise[i]! + this.rng.normal() * 0.08 * Math.sqrt(dt)));
      if (this.hasMotion && this.stationary) {
        v *= 0.25;
      } else {
        v += (this.cruise[i]! - v) * (1 - Math.exp(-dt / 6)) + this.rng.normal() * 0.3 * Math.sqrt(dt);
        v = Math.max(0, Math.min(42, v));
      }
      // Drivers slow down for turns: hypotheses on the route do too.
      const ri = this.ridx[i]!;
      if (ri >= 0 && ri + 1 < this.spans.length && v > 7) {
        const cur = this.spans[ri]!;
        const toTurn = cur.toOffset - this.off[i]!;
        if (toTurn < 35 && Math.abs(this.net.turn(cur.edge, this.spans[ri + 1]!.edge)) > 35) v = Math.max(5, v - 3 * dt);
      }
      this.v[i] = v;
      let e = this.edge[i]!;
      let o = this.off[i]! + v * dt + this.rng.normal() * 0.3;
      if (o < 0) o = 0;
      let guard = 0;
      while (o > net.edges[e]!.length && guard++ < 20) {
        o -= net.edges[e]!.length;
        const next = this.chooseNext(i, e);
        if (next < 0) { o = net.edges[e]!.length; this.v[i] = 0; break; }
        this.acc[i] = this.acc[i]! + net.turn(e, next);
        e = next;
      }
      this.edge[i] = e;
      this.off[i] = o;
      const r = this.ridx[i]!;
      if (r >= 0 && this.spans[r]!.edge !== e) this.ridx[i] = this.spanIndexFor(e, o);
      else if (r < 0 && this.spanOfEdge.has(e)) this.ridx[i] = this.spanIndexFor(e, o);
    }
  }

  private chooseNext(i: number, e: number): number {
    const net = this.net;
    const edge = net.edges[e]!;
    const outs = net.out[edge.to]!;
    const candidates = outs.filter((o) => o !== edge.reverse);
    if (candidates.length === 0) return outs.length > 0 ? outs[0]! : -1; // dead end: U-turn if possible
    const r = this.ridx[i]!;
    if (r >= 0 && r + 1 < this.spans.length) {
      const nextRoute = this.spans[r + 1]!.edge;
      if (candidates.includes(nextRoute) && (candidates.length === 1 || this.rng.next() < this.cfg.followRouteProb)) {
        this.ridx[i] = r + 1;
        return nextRoute;
      }
    }
    // Off-route (or deviating): prefer going straight-ish.
    let total = 0;
    const ws = candidates.map((c) => { const w = Math.exp(-Math.abs(net.turn(e, c)) / 60); total += w; return w; });
    let pick = this.rng.next() * total, k = 0;
    while (k < candidates.length - 1 && pick > ws[k]!) { pick -= ws[k]!; k++; }
    const chosen = candidates[k]!;
    this.ridx[i] = -1;
    return chosen;
  }

  private weighByHeading(): void {
    const H = this.H;
    const oldPos = (this.histPos + 1) % H; // oldest entry in the ring
    const dPsi = this.psi - this.psiHist[oldPos]!;
    // Small bends are measured about as precisely as big turns relative to
    // their size: 5° + 12% keeps gentle highway curves informative while
    // tolerating the timing smear of a 90° junction turn.
    const sigma = this.cfg.adaptiveHeadingSigma ? Math.min(this.cfg.headingSigmaDeg + 2, 5 + 0.12 * Math.abs(dPsi)) : this.cfg.headingSigmaDeg;
    let bestRaw = 0;
    for (let i = 0; i < this.n; i++) {
      const dH = this.acc[i]! - this.hist[i * H + oldPos]!;
      const err = wrapDeg(dPsi - dH);
      // Overlapping windows re-count the same turn several times: temper each tick's evidence.
      const raw = Math.exp(-(err * err) / (2 * sigma * sigma * 3));
      if (raw > bestRaw) bestRaw = raw;
      this.w[i] = this.w[i]! * (raw + 0.01);
    }
    // No hypothesis explains the measured turn: we have lost the car on the map.
    // Re-spread over every road nearby and let the gyro pick again.
    if (Math.abs(dPsi) > 35 && bestRaw < 0.05) this.unexplainedStreak++;
    else if (bestRaw > 0.3) this.unexplainedStreak = 0;
    if (this.unexplainedStreak >= 3) {
      const c = this.cloud();
      this.relocalize(c.x, c.y, Math.max(250, 3 * c.sigma));
      this.unexplainedStreak = 0;
    }
  }

  /** Uniformly re-spread hypotheses over all road edges within `radius`, keeping speeds. */
  private relocalize(x: number, y: number, radius: number): void {
    const near = this.net.edgesNear(x, y, radius);
    if (near.length === 0) return;
    this.relocalizations++;
    const H = this.H;
    for (let i = 0; i < this.n; i++) {
      const c = near[Math.floor(this.rng.next() * near.length)]!;
      this.edge[i] = c.edge;
      this.off[i] = this.rng.next() * this.net.edges[c.edge]!.length;
      this.ridx[i] = this.spanIndexFor(c.edge, this.off[i]!);
      this.w[i] = 1 / this.n;
      // Heading history restarts: the next turn decides.
      this.acc[i] = this.psi;
      for (let h = 0; h < H; h++) this.hist[i * H + h] = this.psi;
    }
    this.psiHist.fill(this.psi);
  }

  getDiagnostics(): { relocalizations: number; gyroBiasDps: number } {
    return { relocalizations: this.relocalizations, gyroBiasDps: this.gyroBias };
  }

  private weighByMotionState(): void {
    for (let i = 0; i < this.n; i++) {
      const v = this.v[i]!;
      if (this.stationary ? v > 2.5 : v < 1) this.w[i] = this.w[i]! * 0.5;
    }
    // A car that has just stopped is usually at a junction (lights, give way):
    // hypotheses mid-block become less likely. Applied once per stop.
    if (this.stationary && !this.stopPriorApplied) {
      this.stopPriorApplied = true;
      for (let i = 0; i < this.n; i++) {
        const e = this.net.edges[this.edge[i]!]!;
        const toNode = e.length - this.off[i]!;
        const atJunction = this.net.out[e.to]!.length >= 3 && toNode <= 45;
        if (!atJunction) this.w[i] = this.w[i]! * 0.35;
      }
    }
    if (!this.stationary) this.stopPriorApplied = false;
  }

  private cloud(): { x: number; y: number; sigma: number; speed: number } {
    let sw = 0, sx = 0, sy = 0, sv = 0;
    const pts: { x: number; y: number }[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const p = this.net.pointOn(this.edge[i]!, this.off[i]!);
      pts[i] = p;
      const w = this.w[i]!;
      sw += w; sx += w * p.x; sy += w * p.y; sv += w * this.v[i]!;
    }
    sw = sw || 1;
    const mx = sx / sw, my = sy / sw;
    let s2 = 0;
    for (let i = 0; i < this.n; i++) { const p = pts[i]!; s2 += this.w[i]! * ((p.x - mx) ** 2 + (p.y - my) ** 2); }
    return { x: mx, y: my, sigma: Math.sqrt(s2 / sw), speed: sv / sw };
  }

  private handleGnss(t: number, g: NavigatorGnss): void {
    const p = this.net.toLocal(g);
    const sigmaG = Math.max(4, Math.min(200, g.accuracyM ?? 25));
    this.lastGnssSigma = sigmaG;
    const fix: Fix = { t, x: p.x, y: p.y, speed: g.speedMps, course: g.courseDeg, psi: this.hasMotion ? this.psi : null };
    if (sigmaG >= 150) { this.lastFixT = t; return; } // too coarse to use at all
    const c = this.cloud();
    const dist = Math.hypot(p.x - c.x, p.y - c.y);
    const outage = t - this.lastFixT;
    if (outage >= 15) this.gnssUnverified = true;
    // First fixes after an outage are on probation: a tighter gate, so a
    // replayed/synthesised position that merely lies inside our (large)
    // dead-reckoning uncertainty doesn't get in unchallenged.
    const k = this.cfg.probationAfterOutage && this.gnssUnverified && this.accepted.length < 5 ? 2.5 : 4;
    // The particle spread can collapse onto a wrong hypothesis during a long
    // outage; the dead-reckoning floor keeps the gate honest about that.
    const sigmaEst = Math.max(c.sigma, Math.min(500, this.cfg.drUncertaintyPerMetre * this.drDistance));
    const gate = k * Math.sqrt(sigmaEst * sigmaEst + sigmaG * sigmaG) + 25;
    let consistent = dist <= gate;
    if (consistent && this.hasMotion) {
      const prev = this.accepted[this.accepted.length - 1] ?? this.candidates[this.candidates.length - 1];
      const implied = prev && t - prev.t > 0 && t - prev.t <= 3 ? Math.hypot(p.x - prev.x, p.y - prev.y) / (t - prev.t) : null;
      const gnssMoving = Math.max(g.speedMps ?? 0, implied ?? 0);
      // Phone says stopped, GNSS says driving — or phone has felt driving for a while, GNSS says parked.
      if (this.stationary && gnssMoving > 3) consistent = false;
      // Stopped for a few seconds (lights): real GNSS Doppler speed reads ~0; a drifting spoof keeps "moving".
      if (this.stationary && this.stillCount >= 3 && (g.speedMps ?? 0) > 1.2) consistent = false;
      if (this.movingFor >= 5 && (g.speedMps ?? 99) < 0.5 && (implied ?? 99) < 0.5) consistent = false;
    }
    // Compare course changes with the gyro only over the recent past: across
    // a long outage the integrated gyro has drifted and the check is noise.
    if (consistent && this.hasMotion) consistent = this.courseConsistent([...this.accepted.filter((f) => t - f.t <= 2 * this.H).slice(-this.H), fix]);
    if (t < this.distrustUntil) consistent = false;
    if (consistent) {
      const s2 = 2 * sigmaG * sigmaG;
      for (let i = 0; i < this.n; i++) {
        const q = this.net.pointOn(this.edge[i]!, this.off[i]!);
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        let l = Math.exp(-d2 / s2) + 1e-4;
        if (g.speedMps != null) l *= Math.exp(-((this.v[i]! - g.speedMps) ** 2) / (2 * 1.5 * 1.5)) + 0.05;
        this.w[i] = this.w[i]! * l;
      }
      // GNSS speed is precise: pull every hypothesis's speed toward it, so the
      // cloud keeps up with braking before turns and pulling away after stops.
      if (g.speedMps != null) {
        for (let i = 0; i < this.n; i++) {
          this.v[i] = Math.max(0, this.v[i]! + 0.6 * (g.speedMps - this.v[i]!) + this.rng.normal() * 0.3);
          // Learn cruising speed from free-flowing driving, not from braking.
          if (g.speedMps > 4 && g.speedMps > 0.8 * this.cruise[i]!) this.cruise[i] = this.cruise[i]! + 0.15 * (g.speedMps - this.cruise[i]!);
        }
      }
      const course = g.courseDeg != null && (g.speedMps ?? 0) > 3 ? g.courseDeg : null;
      this.gnssOffRouteStreak = this.fixDistanceFromRoute(p.x, p.y, course) > Math.max(30, 2.5 * sigmaG) ? this.gnssOffRouteStreak + 1 : 0;
      this.accepted.push(fix);
      if (this.accepted.length > 30) this.accepted.shift();
      if (outage >= 15) this.accepted = [fix];
      // A gyro turn seen while GNSS stayed consistent through it verifies GNSS.
      const lastTurn = this.gyroTurns[this.gyroTurns.length - 1];
      if (this.gnssUnverified && lastTurn && lastTurn.t > this.accepted[0]!.t + this.H && this.accepted.length >= this.H + 3) {
        this.gnssUnverified = false;
        this.unverifiedUntil = -Infinity;
      }
      this.drDistance = 0;
      this.candidates = [];
      this.rejected = 0;
      this.inconsistentSince = null;
      this.lastFixT = t;
      this.lastAcceptedT = t;
      return;
    }
    this.rejected++;
    this.candidates.push(fix);
    if (this.candidates.length > 30) this.candidates.shift();
    if (this.inconsistentSince == null) this.inconsistentSince = t;
    if (this.rejected < this.cfg.reacquireAfter) return;
    const verified = this.trackTrustworthy(this.candidates.slice(-this.cfg.reacquireAfter), true);
    // On a long straight road there is no turn to verify GNSS against. When
    // our own estimate is already too uncertain to guide (σ ≥ 150 m), a long,
    // self-consistent, on-road GNSS track is the better bet — but it is taken
    // as UNVERIFIED (confidence capped at LOW) until a gyro turn confirms it,
    // and the next unexplained turn throws it out again.
    const lost = sigmaEst >= 150 && this.rejected >= 30 && this.candidates.length >= 30;
    const longTrack = this.candidates.slice(-30);
    const unverifiedOk = !verified && lost && t >= this.distrustUntil && this.trackTrustworthy(longTrack, false)
      && longTrack.every((f) => this.net.edgesNear(f.x, f.y, 30).length > 0);
    if (verified || unverifiedOk) {
      // Our estimate drifted and GNSS is self-consistent (and, if verified,
      // agrees with the gyro): believe GNSS again.
      this.initAround(p.x, p.y, sigmaG, g.speedMps, g.courseDeg);
      if (!this.hasMotion || unverifiedOk) { this.unverifiedUntil = t + 120; this.gnssUnverified = true; }
      else this.gnssUnverified = false; // re-acquired on a gyro-matched turn
      this.drDistance = 0;
      this.accepted = this.candidates.slice(-this.cfg.reacquireAfter);
      this.candidates = [];
      this.rejected = 0;
      this.inconsistentSince = null;
      this.lastFixT = t;
      this.lastAcceptedT = t;
    }
  }

  /**
   * The GNSS fixes the filter has been rejecting look like a real drive
   * (self-consistent speeds, course turning with the gyro) rather than
   * interference. Used when the road network is only the route itself: a
   * real departure from the route then shows up as "rejected but plausible".
   */
  rejectedTrackPlausible(): boolean {
    if (this.rejected < 3) return false;
    const track = this.candidates.slice(-Math.min(this.cfg.reacquireAfter, this.candidates.length));
    if (!this.trackTrustworthy(track, false, false)) return false;
    // The turn that took the car off the route usually starts while fixes are
    // still being accepted: look for it across accepted + rejected fixes.
    return !this.hasMotion || this.hasGyroMatchedTurn([...this.accepted, ...this.candidates]);
  }

  /**
   * Distance from a fix to the route (all spans). With a known course, only
   * spans driven in that direction count: driving the route's road the wrong
   * way is off the route.
   */
  private fixDistanceFromRoute(x: number, y: number, courseDeg: number | null = null): number {
    let best = Infinity;
    for (const s of this.spans) {
      if (courseDeg != null && Math.abs(wrapDeg(this.net.edges[s.edge]!.bearing - courseDeg)) > 75) continue;
      const p = this.net.project(s.edge, x, y);
      if (p.dist < best) best = p.dist;
    }
    return best;
  }

  /** GNSS course changes must match the gyro's heading changes over the same interval. */
  private courseConsistent(track: Fix[]): boolean {
    const withPsi = track.filter((f) => f.psi != null && f.course != null && (f.speed ?? 0) > 4);
    if (withPsi.length < 2) return true;
    const a = withPsi[0]!, b = withPsi[withPsi.length - 1]!;
    if (b.t - a.t < 3) return true;
    const dCourse = wrapDeg(b.course! - a.course!);
    const dPsi = b.psi! - a.psi!;
    return Math.abs(wrapDeg(dCourse - dPsi)) <= 35;
  }

  /** Is a run of (rejected) fixes a plausible real track? */
  private trackTrustworthy(track: Fix[], requireGyroTurn: boolean, requireOnRoad = true): boolean {
    if (track.length < 2) return false;
    for (let k = 1; k < track.length; k++) {
      const a = track[k - 1]!, b = track[k]!;
      const dt = Math.max(0.5, b.t - a.t);
      const implied = Math.hypot(b.x - a.x, b.y - a.y) / dt;
      if (implied > 45) return false;
      const rep = b.speed ?? implied;
      if (Math.abs(implied - rep) > 6) return false;
      if (this.hasMotion && this.stationary && rep > 4) return false;
    }
    if (this.hasMotion) {
      // Course from the positions themselves must turn like the gyro does.
      const first = track[0]!, mid = track[Math.floor(track.length / 2)]!, last = track[track.length - 1]!;
      const d1 = Math.hypot(mid.x - first.x, mid.y - first.y), d2 = Math.hypot(last.x - mid.x, last.y - mid.y);
      if (d1 > 20 && d2 > 20 && first.psi != null && last.psi != null) {
        const c1 = (Math.atan2(mid.x - first.x, mid.y - first.y) * 180) / Math.PI;
        const c2 = (Math.atan2(last.x - mid.x, last.y - mid.y) * 180) / Math.PI;
        if (Math.abs(wrapDeg(wrapDeg(c2 - c1) - (last.psi - first.psi))) > 35) return false;
      }
      if (!this.courseConsistent(track)) return false;
      // Must lie on the road network.
      if (requireOnRoad && this.net.edgesNear(last.x, last.y, 40).length === 0) return false;
      // Proof of being real rather than replayed or synthesised: a turn in the
      // GNSS track at the same time and in the same direction as a gyro turn.
      if (requireGyroTurn && !(this.hasGyroMatchedTurn() && this.turnAnchored(this.candidates))) return false;
    }
    return true;
  }

  /** At the latest gyro turn covered by `track`, the track's fix is at a junction that allows that turn. */
  private turnAnchored(track: Fix[]): boolean {
    if (!this.cfg.turnAnchoredCheck || this.net.nodes.length === 0) return true;
    for (let k = this.gyroTurns.length - 1; k >= 0; k--) {
      const turn = this.gyroTurns[k]!;
      if (turn.full == null) continue;
      const fix = this.fixAt(track, turn.peakT);
      if (!fix) continue;
      return this.turnNodesNear(fix.x, fix.y, Math.max(35, 3 * this.lastGnssSigma), turn.full).length > 0;
    }
    return false;
  }

  private hasGyroMatchedTurn(track: Fix[] = this.candidates): boolean {
    for (const turn of this.gyroTurns) {
      const before = track.filter((f) => f.t >= turn.t - this.H - 4 && f.t <= turn.t - this.H + 1);
      const after = track.filter((f) => f.t >= turn.t - 1 && f.t <= turn.t + 4);
      if (before.length < 2 || after.length < 2) continue;
      const cb = this.trackCourse(before), ca = this.trackCourse(after);
      if (cb == null || ca == null) continue;
      if (Math.abs(wrapDeg(wrapDeg(ca - cb) - turn.dPsi)) <= 30) return true;
    }
    return false;
  }

  private trackCourse(fixes: Fix[]): number | null {
    const a = fixes[0]!, b = fixes[fixes.length - 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 10) return null;
    return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  }

  private normalizeAndResample(): void {
    let sw = 0;
    for (let i = 0; i < this.n; i++) sw += this.w[i]!;
    if (!(sw > 1e-280) || !Number.isFinite(sw)) {
      for (let i = 0; i < this.n; i++) this.w[i] = 1 / this.n;
      return;
    }
    let ess = 0;
    for (let i = 0; i < this.n; i++) { this.w[i] = this.w[i]! / sw; ess += this.w[i]! * this.w[i]!; }
    if (1 / ess >= this.n / 2) return;
    // Systematic resampling.
    const n = this.n, H = this.H;
    const step = 1 / n;
    let u = this.rng.next() * step, c = this.w[0]!, j = 0;
    for (let i = 0; i < n; i++) {
      while (u > c && j < n - 1) { j++; c += this.w[j]!; }
      this.edge2[i] = this.edge[j]!; this.off2[i] = this.off[j]!; this.v2[i] = this.v[j]!;
      this.cruise2[i] = this.cruise[j]!; this.ridx2[i] = this.ridx[j]!; this.acc2[i] = this.acc[j]!;
      this.hist2.set(this.hist.subarray(j * H, j * H + H), i * H);
      u += step;
    }
    [this.edge, this.edge2] = [this.edge2, this.edge];
    [this.off, this.off2] = [this.off2, this.off];
    [this.v, this.v2] = [this.v2, this.v];
    [this.cruise, this.cruise2] = [this.cruise2, this.cruise];
    [this.ridx, this.ridx2] = [this.ridx2, this.ridx];
    [this.acc, this.acc2] = [this.acc2, this.acc];
    [this.hist, this.hist2] = [this.hist2, this.hist];
    for (let i = 0; i < n; i++) {
      this.w[i] = 1 / n;
      // Roughening keeps diversity in speed and position.
      this.v[i] = Math.max(0, this.v[i]! + this.rng.normal() * 0.2);
      this.off[i] = Math.max(0, this.off[i]! + this.rng.normal() * 1);
    }
  }

  private estimate(t: number, g: NavigatorGnss | null): NavigatorEstimate {
    const net = this.net;
    // Route mass and along-route estimate.
    let onW = 0, sa = 0;
    for (let i = 0; i < this.n; i++) {
      const a = this.alongOf(i);
      if (a >= 0) { onW += this.w[i]!; sa += this.w[i]! * a; }
    }
    const along = onW > 0 ? sa / onW : null;
    let pos: { x: number; y: number };
    let heading = 0;
    let bestEdge = -1, bestOff = 0;
    if (along != null && onW >= 0.5) {
      pos = this.routePoint(along);
      heading = this.routeHeading(along);
    } else {
      // Most likely edge off the route.
      const mass = new Map<number, number>();
      for (let i = 0; i < this.n; i++) mass.set(this.edge[i]!, (mass.get(this.edge[i]!) ?? 0) + this.w[i]!);
      let bm = -1;
      for (const [e, m] of mass) if (m > bm) { bm = m; bestEdge = e; }
      let so = 0, sw = 0;
      for (let i = 0; i < this.n; i++) if (this.edge[i] === bestEdge) { so += this.w[i]! * this.off[i]!; sw += this.w[i]!; }
      bestOff = sw > 0 ? so / sw : 0;
      pos = net.pointOn(bestEdge, bestOff);
      heading = net.edges[bestEdge]!.bearing;
    }
    let s2 = 0, sv = 0;
    for (let i = 0; i < this.n; i++) {
      const q = net.pointOn(this.edge[i]!, this.off[i]!);
      s2 += this.w[i]! * ((q.x - pos.x) ** 2 + (q.y - pos.y) ** 2);
      sv += this.w[i]! * this.v[i]!;
    }
    // Dead-reckoning honesty floor: ~3% of the distance driven without an
    // accepted fix, whatever the particle spread says.
    const sigma = Math.max(Math.sqrt(s2), Math.min(500, this.cfg.drUncertaintyPerMetre * this.drDistance));

    const fixAge = t - this.lastFixT;
    let gnss: GnssVerdict;
    if (this.rejected >= 3) gnss = "REJECTED";
    else if (!g || fixAge > 3 || this.lastGnssSigma >= 150) gnss = "LOST";
    else if (this.lastGnssSigma > 20) gnss = "DEGRADED";
    else gnss = "OK";
    const gnssInconsistent = this.inconsistentSince != null && t - this.inconsistentSince >= 5;

    // Off-route. With trusted GNSS: fixes away from the route for 5 s (like
    // OffRouteDetector). Without: most of the probability mass has left the
    // route for 5 s — the gyro saw turns the route does not have.
    const gnssTracking = gnss === "OK" || gnss === "DEGRADED";
    if (this.spans.length > 0 && (gnssTracking ? this.gnssOffRouteStreak > 0 && onW < 0.5 : onW < 0.3)) this.offRouteStreak++;
    else this.offRouteStreak = 0;
    const offRoute = this.offRouteStreak >= 5 && (!gnssTracking || this.gnssOffRouteStreak >= 5);
    if (offRoute && bestEdge < 0) {
      const mass = new Map<number, number>();
      for (let i = 0; i < this.n; i++) if (this.ridx[i]! < 0) mass.set(this.edge[i]!, (mass.get(this.edge[i]!) ?? 0) + this.w[i]!);
      let bm = -1;
      for (const [e, m] of mass) if (m > bm) { bm = m; bestEdge = e; }
      let so = 0, sw = 0;
      for (let i = 0; i < this.n; i++) if (this.edge[i] === bestEdge) { so += this.w[i]! * this.off[i]!; sw += this.w[i]!; }
      bestOff = sw > 0 ? so / sw : 0;
    }

    let band: ConfidenceBand;
    const trackingGnss = gnssTracking;
    if (sigma <= 20 && gnss === "OK") band = "HIGH";
    else if (sigma <= (trackingGnss ? 50 : 35)) band = "MEDIUM";
    else if (sigma <= 150) band = "LOW";
    else band = "UNKNOWN";
    if (offRoute && band === "HIGH") band = "MEDIUM";
    if (this.gnssUnverified && band === "HIGH") band = "MEDIUM";
    if (this.gnssUnverified && !this.hasMotion && band === "MEDIUM") band = "LOW";
    // Without motion sensors a jump back to GNSS can't be verified (spoof vs. real): stay cautious.
    if (t < this.unverifiedUntil && (band === "HIGH" || band === "MEDIUM")) band = "LOW";

    let next: NavigatorGuidance | null = null;
    if (this.route && along != null) {
      for (let k = 1; k < this.route.steps.length; k++) {
        const a = this.stepAlong[k]!;
        if (a > along - 5) {
          const step = this.route.steps[k]!;
          const turnDeg = step.bearingBefore != null && step.bearingAfter != null ? wrapDeg(step.bearingAfter - step.bearingBefore) : null;
          next = { stepIndex: k, maneuver: step.maneuver, roadName: step.roadName, distanceM: Math.max(0, a - along), uncertaintyM: sigma, turnDeg };
          break;
        }
      }
    }
    const remaining = along != null ? Math.max(0, this.routeLen - along) : null;
    if (!this.arrivedLatched && remaining != null && onW >= 0.6) {
      // Close enough given our uncertainty — or parked (IMU still) within 2σ of it.
      if (remaining <= Math.max(25, sigma) && sigma <= 60) this.arrivedLatched = true;
      else if (this.hasMotion && this.stationary && this.stillCount >= 5 && remaining <= Math.max(40, 2 * sigma) && sigma <= 100) this.arrivedLatched = true;
    }

    const source: NavigatorEstimate["source"] = gnss === "OK" ? "GNSS" : trackingGnss ? "FUSED" : "DEAD_RECKONING";
    return {
      t,
      position: net.toLatLon(pos.x, pos.y),
      headingDeg: heading,
      speedMps: sv,
      uncertaintyM: sigma,
      onRouteProbability: onW,
      routeAlongM: along,
      routeRemainingM: remaining,
      next,
      gnss,
      gnssInconsistent,
      stationary: this.stationary,
      source,
      offRoute,
      offRouteEdge: offRoute && bestEdge >= 0 ? { edge: bestEdge, offset: bestOff } : null,
      band,
      arrived: this.arrivedLatched,
      secondsSinceAcceptedFix: Number.isFinite(this.lastAcceptedT) ? t - this.lastAcceptedT : null,
    };
  }

  private routePoint(along: number): { x: number; y: number } {
    for (const s of this.spans) {
      const len = s.toOffset - s.fromOffset;
      if (along <= s.alongStart + len) return this.net.pointOn(s.edge, s.fromOffset + Math.max(0, along - s.alongStart));
    }
    const last = this.spans[this.spans.length - 1]!;
    return this.net.pointOn(last.edge, last.toOffset);
  }

  private routeHeading(along: number): number {
    for (const s of this.spans) {
      if (along <= s.alongStart + (s.toOffset - s.fromOffset)) return this.net.edges[s.edge]!.bearing;
    }
    return this.net.edges[this.spans[this.spans.length - 1]!.edge]!.bearing;
  }
}
