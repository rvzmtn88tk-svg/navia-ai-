// Deterministic route geometry for the AI co-pilot's tools.
//
// Everything an LLM must NOT estimate on its own lives here: where a place
// projects onto the route, how far ahead it is, how many minutes until the
// car gets there, which side of the road it is on, and a first-order detour
// estimate. These are pure functions of the route polyline + step
// durations — the co-pilot's tools call them and hand the model numbers,
// never the other way round.

import type { LatLon } from "./types";
import type { Route } from "./route-engine";
import { haversineMeters, initialBearing } from "./geodesy";

const M_PER_DEG_LAT = 111_320;

function toLocalXY(p: LatLon, origin: LatLon): { x: number; y: number } {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lon - origin.lon) * mPerDegLon, y: (p.lat - origin.lat) * M_PER_DEG_LAT };
}

export type PolylineProjection = {
  /** Distance along the polyline (m) from its start to the projected point. */
  alongM: number;
  /** Perpendicular distance (m) from the point to the polyline. */
  offsetM: number;
  /** Index i of the segment [i, i+1] the point projects onto. */
  segmentIndex: number;
  /** Which side of the direction of travel the point lies on. */
  side: "left" | "right" | "on_route";
  projected: LatLon;
};

/** Precomputed cumulative lengths for one polyline — reuse it for many projections. */
export class RouteGeometryIndex {
  readonly cumulativeM: number[];
  readonly lengthM: number;

  constructor(readonly geometry: LatLon[]) {
    // Segment lengths use haversine so along-route distances agree with the
    // routing providers' own distances; projection within a segment uses a
    // local planar frame (accurate at segment scale).
    const cum = [0];
    for (let i = 0; i < geometry.length - 1; i++) {
      cum.push(cum[i]! + haversineMeters(geometry[i]!, geometry[i + 1]!));
    }
    this.cumulativeM = cum;
    this.lengthM = cum[cum.length - 1] ?? 0;
  }

  /** Nearest point on the polyline to `p` (optionally restricted to alongM >= minAlongM). */
  project(p: LatLon, minAlongM = -Infinity): PolylineProjection | null {
    const g = this.geometry;
    if (g.length < 2) return null;
    let best: PolylineProjection | null = null;
    for (let i = 0; i < g.length - 1; i++) {
      if (this.cumulativeM[i + 1]! < minAlongM) continue;
      const a = g[i]!, b = g[i + 1]!;
      const P = toLocalXY(p, a), B = toLocalXY(b, a);
      const segLenSq = B.x * B.x + B.y * B.y;
      let t = segLenSq === 0 ? 0 : (P.x * B.x + P.y * B.y) / segLenSq;
      t = Math.max(0, Math.min(1, t));
      const alongM = this.cumulativeM[i]! + t * (this.cumulativeM[i + 1]! - this.cumulativeM[i]!);
      if (alongM < minAlongM) continue;
      const px = t * B.x, py = t * B.y;
      const offsetM = Math.hypot(P.x - px, P.y - py);
      if (!best || offsetM < best.offsetM) {
        // Cross product of travel direction x (point - projection): > 0 means left.
        const cross = B.x * (P.y - py) - B.y * (P.x - px);
        const side: PolylineProjection["side"] = offsetM < 8 ? "on_route" : cross > 0 ? "left" : "right";
        best = {
          alongM, offsetM, segmentIndex: i, side,
          projected: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
        };
      }
    }
    return best;
  }

  pointAt(alongM: number): LatLon {
    const g = this.geometry;
    if (g.length === 0) throw new Error("RouteGeometryIndex.pointAt: empty geometry");
    if (g.length === 1 || alongM <= 0) return g[0]!;
    if (alongM >= this.lengthM) return g[g.length - 1]!;
    let i = 0;
    while (i < g.length - 2 && this.cumulativeM[i + 1]! < alongM) i++;
    const segLen = this.cumulativeM[i + 1]! - this.cumulativeM[i]!;
    const t = segLen === 0 ? 0 : (alongM - this.cumulativeM[i]!) / segLen;
    const a = g[i]!, b = g[i + 1]!;
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  }

  /** The sub-polyline between two along-route distances (inclusive endpoints). */
  slice(fromM: number, toM: number): LatLon[] {
    const from = Math.max(0, Math.min(fromM, this.lengthM));
    const to = Math.max(from, Math.min(toM, this.lengthM));
    const out: LatLon[] = [this.pointAt(from)];
    for (let i = 0; i < this.geometry.length; i++) {
      const c = this.cumulativeM[i]!;
      if (c > from && c < to) out.push(this.geometry[i]!);
    }
    out.push(this.pointAt(to));
    return out;
  }

  bearingAt(alongM: number): number {
    const a = this.pointAt(Math.max(0, alongM - 15));
    const b = this.pointAt(Math.min(this.lengthM, alongM + 15));
    return initialBearing(a, b);
  }
}

/**
 * Time along the route, derived from the routing provider's own per-step
 * durations (Valhalla's costing, or the demo provider's). Linear within a
 * step. This is the provider's *static* estimate — no live traffic unless
 * the provider itself supplied traffic-aware durations.
 */
export class RouteTimeline {
  private stepStartM: number[] = [];
  private stepStartS: number[] = [];

  constructor(private route: Route) {
    let d = 0, t = 0;
    for (const step of route.steps) {
      this.stepStartM.push(d);
      this.stepStartS.push(t);
      d += step.distanceM;
      t += step.durationS;
    }
    this.stepStartM.push(d);
    this.stepStartS.push(t);
  }

  /** Seconds from route start to `alongM` according to the provider's durations. */
  secondsAt(alongM: number): number {
    const steps = this.route.steps;
    if (steps.length === 0) {
      return this.route.distanceM > 0 ? (this.route.durationS / this.route.distanceM) * alongM : 0;
    }
    const clamped = Math.max(0, alongM);
    for (let i = 0; i < steps.length; i++) {
      const startM = this.stepStartM[i]!, endM = this.stepStartM[i + 1]!;
      if (clamped <= endM || i === steps.length - 1) {
        const len = endM - startM;
        const frac = len > 0 ? Math.min(1, (clamped - startM) / len) : 0;
        return this.stepStartS[i]! + frac * steps[i]!.durationS;
      }
    }
    return this.stepStartS[this.stepStartS.length - 1]!;
  }

  /** Inverse of secondsAt: the along-route distance reached after `seconds` from route start. */
  distanceAtSeconds(seconds: number): number {
    const steps = this.route.steps;
    if (steps.length === 0) {
      return this.route.durationS > 0 ? (this.route.distanceM / this.route.durationS) * seconds : 0;
    }
    const s = Math.max(0, seconds);
    for (let i = 0; i < steps.length; i++) {
      const startS = this.stepStartS[i]!, endS = this.stepStartS[i + 1]!;
      if (s <= endS) {
        const dur = endS - startS;
        const frac = dur > 0 ? (s - startS) / dur : 1;
        return this.stepStartM[i]! + frac * steps[i]!.distanceM;
      }
    }
    return this.stepStartM[this.stepStartM.length - 1]!;
  }
}

/** Road-network factor applied to straight-line off-route distance (typical urban/suburban circuity). */
export const DETOUR_CIRCUITY_FACTOR = 1.4;
/** Assumed speed on the access roads to/from an off-route place (m/s, ~30 km/h). */
export const DETOUR_ACCESS_SPEED_MPS = 8.3;

/**
 * First-order detour estimate when a routed comparison is unavailable: the
 * car leaves the route at the projection point, drives to the place and
 * back. Labelled "estimated" wherever it is surfaced — it's a geometry
 * bound, not a routed figure.
 */
export function estimateDetourSeconds(offsetM: number): number {
  return (2 * offsetM * DETOUR_CIRCUITY_FACTOR) / DETOUR_ACCESS_SPEED_MPS;
}

/** Reduce a polyline to at most `maxPoints` by uniform along-distance sampling (keeps both ends). */
export function samplePolyline(index: RouteGeometryIndex, maxPoints: number, fromM = 0, toM = index.lengthM): LatLon[] {
  const span = Math.max(0, toM - fromM);
  const n = Math.max(2, Math.min(maxPoints, Math.ceil(span / 250) + 1));
  const out: LatLon[] = [];
  for (let i = 0; i < n; i++) out.push(index.pointAt(fromM + (span * i) / (n - 1)));
  return out;
}
