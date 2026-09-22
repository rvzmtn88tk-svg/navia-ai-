// RouteEngine — spec section 11 ("ROUTING") + section 23 ("ROUTE PROGRESS").
//
// Section 11 asks for a `RoutingProvider` abstraction (route/match/
// searchAlternatives) so the UI is never wired to one specific routing
// engine, with three providers: OnlineValhallaProvider, OfflineValhallaProvider,
// DemoRoutingProvider. Only DemoRoutingProvider is implemented in this pass
// (see demo-routing-provider.ts) — the two Valhalla-backed providers need a
// running Valhalla instance / offline tile package this sandbox cannot build
// or reach (network here is restricted to package registries, see
// LIMITATIONS.md), so they are left as documented interface conformance
// points rather than faked with canned responses, per section 40 ("NO FAKE
// DATA IN PRODUCTION PATH").
//
// Section 23 asks for continuously-updated real route progress (distance
// completed/remaining, ETA, current road, next maneuver) with an explicit
// "no fake 3.4km or <1min values" requirement — RouteProgressEngine below
// computes all of these from the actual route geometry and current position,
// never from a canned string.

import type { LatLon, RouteStep } from "./types";
import { haversineMeters } from "./geodesy";

export type RouteRequest = {
  origin: LatLon;
  destination: LatLon;
};

export type Route = {
  id: string;
  steps: RouteStep[];
  /** Ordered polyline the route follows, start to finish. */
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  /** Which provider produced this route, so the UI/AI can be honest about it. */
  source: "demo" | "online-valhalla" | "offline-valhalla";
};

export type MapMatchResult = {
  matchedPoints: LatLon[];
  roadSegmentIds: (string | null)[];
};

/** Spec section 11's abstraction — UI code must depend on this, never on a concrete provider. */
export interface RoutingProvider {
  route(request: RouteRequest): Promise<Route>;
  match(points: LatLon[]): Promise<MapMatchResult>;
  searchAlternatives(request: RouteRequest): Promise<Route[]>;
}

export type RouteProgress = {
  distanceCompletedM: number;
  distanceRemainingM: number;
  etaSeconds: number;
  currentRoadName: string | null;
  currentStepIndex: number;
  nextStep: RouteStep | null;
  /** Straight-line distance from the current position to the next maneuver point. */
  nextStepDistanceM: number | null;
};

// --- local-metric helpers (equirectangular approximation; adequate at the
// scale of one road segment, and this module is on the hot per-tick path so
// it avoids the trig-heavy haversine for its inner projection loop) ---

function metersPerDegree(atLat: number) {
  const latRad = (atLat * Math.PI) / 180;
  return {
    mPerDegLat: 111_320,
    mPerDegLon: 111_320 * Math.cos(latRad),
  };
}

function toLocalXY(p: LatLon, origin: LatLon): { x: number; y: number } {
  const { mPerDegLat, mPerDegLon } = metersPerDegree(origin.lat);
  return {
    x: (p.lon - origin.lon) * mPerDegLon,
    y: (p.lat - origin.lat) * mPerDegLat,
  };
}

/** Project `p` onto segment [a,b]; returns the projected point, the distance
 * from p to that point, and how far along the segment (0..segLen meters) it lands. */
function projectOntoSegment(p: LatLon, a: LatLon, b: LatLon) {
  const origin = a;
  const P = toLocalXY(p, origin);
  const A = { x: 0, y: 0 };
  const B = toLocalXY(b, origin);
  const abx = B.x - A.x, aby = B.y - A.y;
  const segLenSq = abx * abx + aby * aby;
  let t = segLenSq === 0 ? 0 : ((P.x - A.x) * abx + (P.y - A.y) * aby) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = A.x + t * abx, projY = A.y + t * aby;
  const dx = P.x - projX, dy = P.y - projY;
  const distToSegM = Math.sqrt(dx * dx + dy * dy);
  const segLenM = Math.sqrt(segLenSq);
  return { distToSegM, alongSegM: t * segLenM, segLenM };
}

/** Minimum distance from `position` to the route's geometry line — the
 * "distance from route corridor" OffRouteDetector needs (spec section 22). */
export function distanceFromRouteCorridorM(route: Route, position: LatLon): number {
  const geom = route.geometry;
  if (geom.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < geom.length - 1; i++) {
    const { distToSegM } = projectOntoSegment(position, geom[i]!, geom[i + 1]!);
    if (distToSegM < best) best = distToSegM;
  }
  return best;
}

/** The point on `geometry` at `distanceM` along it (clamped to the ends) —
 * used to advance a simulated "ground truth" position along a route. */
export function positionAtDistance(geometry: LatLon[], distanceM: number): LatLon {
  if (geometry.length === 0) throw new Error("positionAtDistance: empty geometry");
  if (geometry.length === 1) return geometry[0]!;
  let remaining = Math.max(0, distanceM);
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i]!, b = geometry[i + 1]!;
    const segLenM = haversineMeters(a, b);
    if (remaining <= segLenM || i === geometry.length - 2) {
      const t = segLenM === 0 ? 0 : Math.max(0, Math.min(1, remaining / segLenM));
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    remaining -= segLenM;
  }
  return geometry[geometry.length - 1]!;
}

export class RouteProgressEngine {
  /**
   * Find where `currentPosition` sits along `route.geometry`, and derive
   * distance completed/remaining, ETA, current road and next maneuver from
   * that — all real, computed values (spec: "no fake 3.4km or <1min").
   */
  computeProgress(route: Route, currentPosition: LatLon, speedMps: number | null): RouteProgress {
    const geom = route.geometry;
    if (geom.length < 2) {
      return {
        distanceCompletedM: 0,
        distanceRemainingM: route.distanceM,
        etaSeconds: route.durationS,
        currentRoadName: route.steps[0]?.roadName ?? null,
        currentStepIndex: 0,
        nextStep: route.steps[0] ?? null,
        nextStepDistanceM: null,
      };
    }

    // cumulative distance to the start of each geometry segment
    let cumBeforeSegment = 0;
    let bestDistToRoute = Infinity;
    let bestCumAtProjection = 0;

    for (let i = 0; i < geom.length - 1; i++) {
      const a = geom[i]!, b = geom[i + 1]!;
      const { distToSegM, alongSegM, segLenM } = projectOntoSegment(currentPosition, a, b);
      if (distToSegM < bestDistToRoute) {
        bestDistToRoute = distToSegM;
        bestCumAtProjection = cumBeforeSegment + alongSegM;
      }
      cumBeforeSegment += segLenM;
    }

    const distanceCompletedM = Math.max(0, Math.min(route.distanceM, bestCumAtProjection));
    const distanceRemainingM = Math.max(0, route.distanceM - distanceCompletedM);

    // ETA: prefer live speed; fall back to the route's own implied average pace.
    let etaSeconds: number;
    if (speedMps != null && speedMps > 0.5) {
      etaSeconds = distanceRemainingM / speedMps;
    } else if (route.distanceM > 0) {
      etaSeconds = (route.durationS / route.distanceM) * distanceRemainingM;
    } else {
      etaSeconds = 0;
    }

    // Which leg are we on? Steps' distanceM is the leg length FROM that
    // step's maneuver point TO the next one, so the leg whose cumulative
    // end distance first exceeds distanceCompletedM is the one we're
    // currently traveling; its road is "current", and the step after it is
    // the upcoming maneuver. If we've reached/passed the very end (exactly
    // at or past the destination), no leg's end is strictly greater than
    // distanceCompletedM — fall back to the last real travel leg, so
    // `nextStep` still resolves to the synthetic zero-length "arrive" step
    // instead of null.
    let cum = 0;
    const legEnds: number[] = [];
    for (const step of route.steps) { cum += step.distanceM; legEnds.push(cum); }
    let currentStepIndex = legEnds.findIndex((end) => distanceCompletedM < end);
    if (currentStepIndex === -1) currentStepIndex = Math.max(0, route.steps.length - 2);

    const currentStep = route.steps[currentStepIndex] ?? null;
    const nextStep = route.steps[currentStepIndex + 1] ?? null;
    const nextStepDistanceM = nextStep
      ? Math.max(0, legEnds[currentStepIndex]! - distanceCompletedM)
      : null;

    return {
      distanceCompletedM,
      distanceRemainingM,
      etaSeconds,
      currentRoadName: currentStep?.roadName ?? null,
      currentStepIndex,
      nextStep,
      nextStepDistanceM,
    };
  }
}
