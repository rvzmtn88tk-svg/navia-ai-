// A deterministic drive for GNSS-loss tests: a car follows `truthPath` (by
// default the engine's own route) and the test decides, second by second,
// what the phone's GNSS reports; the phone's IMU is simulated at 10 Hz as raw
// samples (gyro rad/s, accelerometer g, phone flat). Everything the engine
// sees is what expo-location / expo-sensors would deliver.

import { NavigationEngine } from "../../src/navigation-engine";
import { DemoRoutingProvider, type DemoRoadGraph } from "../../src/demo-routing-provider";
import { positionAtDistance, type Route, type RoutingProvider } from "../../src/route-engine";
import { haversineMeters, initialBearing } from "../../src/geodesy";
import { RoadNetwork, wrapDeg } from "../../src/resilient/road-network";
import { Rng } from "../../src/resilient/resilient-navigator";
import { VoiceGuidance, type GuidanceCue } from "../../src/voice-guidance";
import type { LatLon, NavigationState } from "../../src/types";

const M = 111_320;

export function latLon(base: LatLon, x: number, y: number): LatLon {
  return { lat: base.lat + y / M, lon: base.lon + x / (M * Math.cos((base.lat * Math.PI) / 180)) };
}

/** A plain street grid, `n` × `n` junctions, `block` metres apart. */
export function gridGraph(n = 6, block = 200): DemoRoadGraph {
  const base = { lat: 50.45, lon: 30.5 };
  const nodes = [], edges = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) nodes.push({ id: `g${r}_${c}`, position: latLon(base, c * block, r * block) });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (c < n - 1) edges.push({ id: `h${r}_${c}`, fromId: `g${r}_${c}`, toId: `g${r}_${c + 1}`, roadName: `вул. Поперечна ${r + 1}` });
    if (r < n - 1) edges.push({ id: `v${r}_${c}`, fromId: `g${r}_${c}`, toId: `g${r + 1}_${c}`, roadName: `вул. Поздовжня ${c + 1}` });
  }
  return { nodes, edges };
}

/**
 * A straight road `lengthM` long heading east (junction every `every` m with
 * a side street), then a right turn onto a 600 m street to the destination.
 */
export function straightRoadGraph(lengthM: number, every = 500): DemoRoadGraph {
  const base = { lat: 50.4, lon: 30.6 };
  const nodes = [{ id: "a0", position: latLon(base, 0, 0) }];
  const edges = [];
  let k = 0;
  for (let x = every; x <= lengthM; x += every) {
    k++;
    nodes.push({ id: `a${k}`, position: latLon(base, x, 0) });
    edges.push({ id: `m${k}`, fromId: `a${k - 1}`, toId: `a${k}`, roadName: "просп. Тунельний" });
    nodes.push({ id: `s${k}`, position: latLon(base, x, 300) });
    edges.push({ id: `side${k}`, fromId: `a${k}`, toId: `s${k}`, roadName: `вул. Бічна ${k}` });
  }
  nodes.push({ id: "dest", position: latLon(base, k * every, -600) });
  edges.push({ id: "last", fromId: `a${k}`, toId: "dest", roadName: "вул. Кінцева" });
  return { nodes, edges };
}

export type GnssMode = "true" | null | { lat: number; lon: number; speedMps?: number; headingDeg?: number; accuracyM?: number };
export type Tick = { t: number; truth: LatLon; v: number; heading: number };

export type RunOptions = {
  gnss: (tick: Tick) => GnssMode;
  imu?: boolean;
  /** false = the app is suspended: no IMU, no ticks (GNSS ignored). */
  appActive?: boolean;
  /** Speed override (m/s) for this segment, e.g. 0 to park. */
  speed?: number;
  /** Yaw rate added (deg/s) while parked/crawling, e.g. a parking-garage ramp. */
  extraYawDps?: number;
  /** Stop at this along-path distance (m). */
  stopAtM?: number;
};

export type RunResult = { maxErrM: number; errAtEndM: number; states: NavigationState[]; truths: LatLon[]; errs: number[]; cues: GuidanceCue[]; last: NavigationState };

export class Drive {
  readonly guidance = new VoiceGuidance();
  private rng = new Rng(7);
  t = 0;
  d = 0;
  v = 0;
  heading: number;
  private turnsAt: number[] = [];

  constructor(readonly engine: NavigationEngine, readonly route: Route, readonly truthPath: LatLon[]) {
    this.heading = initialBearing(truthPath[0]!, truthPath[1]!);
    let cum = 0;
    for (const st of route.steps) { if (st.maneuver === "left" || st.maneuver === "right") this.turnsAt.push(cum); cum += st.distanceM; }
  }

  pathLength(): number {
    let s = 0;
    for (let i = 1; i < this.truthPath.length; i++) s += haversineMeters(this.truthPath[i - 1]!, this.truthPath[i]!);
    return s;
  }

  truth(): LatLon { return positionAtDistance(this.truthPath, this.d); }

  run(seconds: number, opts: RunOptions): RunResult {
    const states: NavigationState[] = [];
    const truths: LatLon[] = [];
    const errs: number[] = [];
    const cues: GuidanceCue[] = [];
    let maxErrM = 0, errAtEndM = 0;
    const L = this.pathLength();
    for (let k = 0; k < seconds; k++) {
      const end = Math.min(L, opts.stopAtM ?? L);
      const parked = this.d >= end - 0.01;
      const target = parked ? (opts.speed ?? 0) : opts.speed ?? (this.turnsAt.some((a) => Math.abs(a - this.d) < 25) ? 5 : 10);
      // A real car: at most +3 m/s² / −4 m/s².
      const v = (this.v = this.v + Math.max(-4, Math.min(3, target - this.v)));
      const before = positionAtDistance(this.truthPath, this.d);
      this.d = Math.min(end, this.d + (parked ? 0 : v));
      const truth = positionAtDistance(this.truthPath, this.d);
      const ahead = positionAtDistance(this.truthPath, Math.min(L, this.d + 1));
      const bearing = parked || haversineMeters(truth, ahead) < 0.1 ? this.heading : initialBearing(truth, ahead);
      const step = Math.max(-25, Math.min(25, wrapDeg(bearing - this.heading))) + (opts.extraYawDps ?? 0);
      this.heading = (this.heading + step + 360) % 360;
      void before;
      const active = opts.appActive !== false;
      if (active && opts.imu !== false) {
        const vib = v > 0.3 ? 0.03 : 0.002;
        for (let j = 0; j < 10; j++) {
          this.engine.pushImuSample({
            timestamp: this.t * 1000 + j * 100,
            accelX: this.rng.normal() * vib, accelY: this.rng.normal() * vib, accelZ: 1 + this.rng.normal() * vib,
            gyroX: this.rng.normal() * 0.002, gyroY: this.rng.normal() * 0.002, gyroZ: (-step * Math.PI) / 180 + this.rng.normal() * 0.002,
          });
        }
      }
      this.t += 1;
      if (!active) continue;
      const g = opts.gnss({ t: this.t, truth, v, heading: this.heading });
      if (g === "true") {
        this.engine.pushGnssSample({ lat: truth.lat + (this.rng.normal() * 3) / M, lon: truth.lon, timestamp: this.t * 1000, accuracyM: 5, speedMps: v, headingDeg: v > 2 ? this.heading : null });
      } else if (g) {
        this.engine.pushGnssSample({ lat: g.lat, lon: g.lon, timestamp: this.t * 1000, accuracyM: g.accuracyM ?? 5, speedMps: g.speedMps ?? v, headingDeg: g.headingDeg ?? (v > 2 ? this.heading : null) });
      }
      const s = this.engine.tick(this.t * 1000);
      states.push(s);
      truths.push(truth);
      cues.push(...this.guidance.update(s));
      const p = s.position?.position;
      const e = p ? haversineMeters(p, truth) : Infinity;
      errs.push(e);
      if (p) { maxErrM = Math.max(maxErrM, e); errAtEndM = e; }
    }
    return { maxErrM, errAtEndM, states, truths, errs, cues, last: this.engine.getState() };
  }
}

export async function startDrive(opts: {
  graph: DemoRoadGraph; from: string; to: string;
  /** "graph" = navigator gets the road graph; "route" = route-only network (online routes today). */
  network: "graph" | "route";
  /** Truth path by node ids (default: the route the engine plans). */
  truthNodes?: string[];
  router?: RoutingProvider;
}): Promise<Drive> {
  const router = opts.router ?? new DemoRoutingProvider(opts.graph);
  const net = RoadNetwork.fromDemoGraph(opts.graph);
  const engine = new NavigationEngine({ routingProvider: router, resilient: opts.network === "graph" ? { networkForRoute: () => net } : true });
  const pos = (id: string) => opts.graph.nodes.find((n) => n.id === id)!.position;
  const route = await engine.requestRoute(pos(opts.from), pos(opts.to));
  const truthPath = opts.truthNodes ? opts.truthNodes.map(pos) : route.geometry;
  return new Drive(engine, route, truthPath);
}
