// GNSS-outage bench for route dead reckoning: drives a REAL route geometry
// (Valhalla route along Mykoly Bazhana Ave, test/fixtures) with a realistic
// speed profile (slowing for turns, stops at lights), a phone IMU at 10 Hz in
// g / rad/s like expo-sensors (flat mount, vibration, gyro yaw at turns), then
// jams GNSS at a random point and measures the engine's position error every
// second against the truth. Variants switch the dead-reckoning aids on/off.
//   npx tsx packages/core/sim/outage-bench.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NavigationEngine, type NavigationEngineOptions } from "../src/navigation-engine";
import { RouteGeometryIndex } from "../src/route-geometry";
import { routeTurns } from "../src/turn-detector";
import { SpeedMemory } from "../src/speed-memory";
import { destinationPoint, haversineMeters } from "../src/geodesy";
import type { Route, RoutingProvider } from "../src/route-engine";

const here = dirname(fileURLToPath(import.meta.url));
export const BENCH_ROUTE: Route = (JSON.parse(readFileSync(join(here, "..", "test", "fixtures", "osm-kyiv-kharkivska-pozniaky.json"), "utf8")) as { routes: { route: Route }[] }).routes[0]!.route;

const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("x")), match: () => Promise.reject(new Error("x")), searchAlternatives: () => Promise.reject(new Error("x")) };

function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const n = () => { let a = 0; for (let i = 0; i < 6; i++) a += u(); return (a - 3) / Math.SQRT1_2 / Math.sqrt(2 / 6 * 3); };
  return { u, n };
}

export type Variant = {
  name: string;
  aids: NonNullable<NavigationEngineOptions["routeAids"]>;
  /** Coarse Wi-Fi/cell fixes keep arriving during the outage. */
  coarse: boolean;
  /** Speed memory trained on earlier drives of this route. */
  learned?: boolean;
};

type Truth = { t: number; m: number; v: number; headingDeg: number };

/** A drive along the route: 10 Hz truth samples. */
function drive(route: Route, seed: number): Truth[] {
  const r = rng(seed);
  const idx = new RouteGeometryIndex(route.geometry);
  const turns = routeTurns(route, idx);
  const stops = [0.25 + 0.2 * r.u(), 0.6 + 0.2 * r.u()].map((f) => ({ at: f * idx.lengthM, s: 18 + 25 * r.u(), done: false }));
  const cruise = 11 + 5 * r.u();
  const out: Truth[] = [];
  let m = 0, v = 0, t = 0, waitUntil = -1;
  while (m < idx.lengthM - 5 && t < 3600) {
    const nextTurn = turns.find((x) => x.progressM > m - 5);
    const stop = stops.find((x) => !x.done && x.at > m);
    let target = cruise;
    if (nextTurn && nextTurn.progressM - m < 90) target = Math.min(target, Math.abs(nextTurn.angleDeg) > 60 ? 5 : 8);
    if (stop && stop.at - m < 60) target = Math.min(target, Math.max(0, (stop.at - m) / 8));
    if (stop && stop.at - m < 2 && !stop.done) { stop.done = true; waitUntil = t + stop.s; }
    if (t < waitUntil) target = 0;
    v += Math.max(-3, Math.min(1.5, (target - v) * 0.8)) * 0.1;
    v = Math.max(0, v);
    m += v * 0.1; t += 0.1;
    out.push({ t, m, v, headingDeg: idx.bearingAt(Math.min(idx.lengthM, m)) });
  }
  return out;
}

export type RunResult = { errors: number[]; confidentWrong: number; seconds: number; within2Sigma: number };

export function runOutage(route: Route, seed: number, variant: Variant, memory?: SpeedMemory): RunResult {
  const r = rng(seed * 7919 + 13);
  const idx = new RouteGeometryIndex(route.geometry);
  const truth = drive(route, seed);
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false, routeAids: variant.aids, speedMemory: variant.learned ? memory ?? null : null });
  engine.applyRoute(route);
  const t0 = 1_800_000_000_000;
  const outageStartM = 700 + 1500 * r.u();
  let prevHeading = truth[0]!.headingDeg;
  const errors: number[] = [];
  let confidentWrong = 0;
  let within2Sigma = 0;
  let lastCoarseS = -10;
  for (let i = 0; i < truth.length; i++) {
    const s = truth[i]!;
    const tMs = t0 + s.t * 1000;
    // Phone IMU (flat, face up; expo-sensors units: g and rad/s).
    const dh = ((s.headingDeg - prevHeading + 540) % 360) - 180;
    prevHeading = s.headingDeg;
    const yawDps = dh / 0.1;
    const vib = s.v > 0.3 ? 0.03 : 0.002;
    engine.pushImuSample({ timestamp: tMs, accelX: r.n() * vib, accelY: r.n() * vib, accelZ: -1 + r.n() * vib, gyroX: r.n() * 0.004, gyroY: r.n() * 0.004, gyroZ: -(yawDps * Math.PI) / 180 + r.n() * 0.004 });
    const whole = Math.abs(s.t - Math.round(s.t)) < 0.05;
    if (!whole) continue;
    const pos = idx.pointAt(s.m);
    const out = s.m >= outageStartM;
    if (!out) {
      const p = destinationPoint(pos, 360 * r.u(), Math.abs(r.n()) * 3);
      engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: tMs, accuracyM: 5, speedMps: s.v, headingDeg: s.v > 1 ? s.headingDeg : null }, tMs);
    } else if (variant.coarse && s.t - lastCoarseS >= 4) {
      lastCoarseS = s.t;
      const acc = 60 + 190 * r.u();
      const p = destinationPoint(pos, 360 * r.u(), Math.abs(r.n()) * acc * 0.6);
      engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: tMs, accuracyM: acc, speedMps: null, headingDeg: null }, tMs);
    }
    const st = engine.tick(tMs);
    if (out && st.position) {
      const e = haversineMeters(st.position.position, pos);
      errors.push(e);
      if (e > 100 && (st.confidenceBand === "HIGH" || st.confidenceBand === "MEDIUM")) confidentWrong++;
      if (st.positionUncertaintyM != null && e <= 2 * st.positionUncertaintyM) within2Sigma++;
    }
  }
  return { errors, confidentWrong, seconds: errors.length, within2Sigma };
}

/** Speed memory from a few earlier GNSS drives of the route (different seeds). */
export function trainedMemory(route: Route, drives = 3): SpeedMemory {
  const mem = new SpeedMemory();
  const idx = new RouteGeometryIndex(route.geometry);
  for (let d = 0; d < drives; d++) {
    for (const s of drive(route, 1000 + d)) if (Math.abs(s.t - Math.round(s.t)) < 0.05) mem.learn(idx.pointAt(s.m), s.v, s.headingDeg, 1_800_000_000_000 + s.t * 1000);
  }
  return mem;
}

export const VARIANTS: Variant[] = [
  { name: "baseline (speed × time only)", aids: { coarseFixes: false, turns: false, structures: false }, coarse: false },
  { name: "+ gyro turns", aids: { coarseFixes: false, turns: true, structures: false }, coarse: false },
  { name: "+ learned speed", aids: { coarseFixes: false, turns: false, structures: false }, coarse: false, learned: true },
  { name: "+ Wi-Fi/cell coarse fixes", aids: { coarseFixes: true, turns: false, structures: false }, coarse: true },
  { name: "all aids, no Wi-Fi", aids: { coarseFixes: true, turns: true, structures: true }, coarse: false, learned: true },
  { name: "all aids + Wi-Fi", aids: { coarseFixes: true, turns: true, structures: true }, coarse: true, learned: true },
];

export function summarize(results: RunResult[]): { p50: number; p90: number; mean: number; confidentWrongShare: number; honestShare: number } {
  const all = results.flatMap((r) => r.errors).sort((a, b) => a - b);
  const q = (p: number) => Math.round(all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? NaN);
  const secs = results.reduce((a, r) => a + r.seconds, 0);
  return {
    p50: q(0.5), p90: q(0.9), mean: Math.round(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)),
    confidentWrongShare: Math.round((1000 * results.reduce((a, r) => a + r.confidentWrong, 0)) / Math.max(1, secs)) / 10,
    /** Share of time the real error was within 2× the uncertainty the engine reported. */
    honestShare: Math.round((1000 * results.reduce((a, r) => a + r.within2Sigma, 0)) / Math.max(1, secs)) / 10,
  };
}

if (process.argv[1] && process.argv[1].endsWith("outage-bench.ts")) {
  const seeds = Array.from({ length: Number(process.argv[2] ?? 12) }, (_, i) => i + 1);
  const mem = trainedMemory(BENCH_ROUTE);
  console.log(`route ${Math.round(BENCH_ROUTE.distanceM)} m, ${routeTurns(BENCH_ROUTE).length} turns, ${seeds.length} drives per variant`);
  console.log("| variant | error p50 | p90 | mean | confident & >100 m | error within 2σ |");
  console.log("|---|---|---|---|---|---|");
  for (const v of VARIANTS) {
    const s = summarize(seeds.map((seed) => runOutage(BENCH_ROUTE, seed, v, mem)));
    console.log(`| ${v.name} | ${s.p50} m | ${s.p90} m | ${s.mean} m | ${s.confidentWrongShare}% | ${s.honestShare}% |`);
  }
}
