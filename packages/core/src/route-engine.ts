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
import { haversineMeters, initialBearing, signedTurnDeg } from "./geodesy";

export type TravelMode = "car" | "walk";

export type RouteRequest = {
  origin: LatLon;
  destination: LatLon;
  /** Defaults to "car". */
  mode?: TravelMode;
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

type RouteMeasure = { cumM: number[]; totalM: number; stepStartsM: number[] | null };
const measureCache = new WeakMap<Route, RouteMeasure>();

/** Cumulative distance along the route line, and where each maneuver sits on it. */
export function routeMeasure(route: Route): RouteMeasure {
  const cached = measureCache.get(route);
  if (cached) return cached;
  const g = route.geometry;
  const cumM = [0];
  for (let i = 1; i < g.length; i++) cumM.push(cumM[i - 1]! + haversineMeters(g[i - 1]!, g[i]!));
  const steps = route.steps;
  const onLine = steps.length > 0 && steps.every((s, i) =>
    s.geometryIndex != null && Number.isInteger(s.geometryIndex) && s.geometryIndex >= 0 && s.geometryIndex < g.length
    && (i === 0 || s.geometryIndex >= steps[i - 1]!.geometryIndex!));
  const measure = { cumM, totalM: cumM[cumM.length - 1] ?? 0, stepStartsM: onLine ? steps.map((s) => cumM[s.geometryIndex!]!) : null };
  measureCache.set(route, measure);
  return measure;
}

/**
 * Where each step's leg ends, in metres along the route line. With maneuver
 * points on the line (RouteStep.geometryIndex) this is exact; otherwise the
 * leg lengths are added up (routes built without an index, e.g. in tests).
 */
export function stepLegEndsM(route: Route): number[] {
  const m = routeMeasure(route);
  if (m.stepStartsM) {
    const starts = m.stepStartsM;
    return route.steps.map((_, i) => (i + 1 < starts.length ? starts[i + 1]! : m.totalM));
  }
  let cum = 0;
  return route.steps.map((s) => (cum += s.distanceM));
}

/** Other parts of the route closer than this to the nearest one are treated as
 * the same place (a road driven twice, both sides of a U-turn, a divided road). */
const SAME_PLACE_M = 20;
/** Metres of distance-to-line one metre of along-route jump is worth. */
const JUMP_WEIGHT = 0.5;
/** Cost of a part of the line running against the vehicle's course (the other
 * side of a U-turn on the same street). */
const AGAINST_COURSE_M = 25;

export class RouteProgressEngine {
  /**
   * Find where `currentPosition` sits along `route.geometry`, and derive
   * distance completed/remaining, ETA, current road and next maneuver from
   * that — all real, computed values (spec: "no fake 3.4km or <1min").
   *
   * `previousCompletedM` is where the vehicle was on this route a moment
   * ago. A route can pass the same place twice (a loop around a block, the
   * way back after a U-turn); without it the nearest part of the line wins
   * and the next maneuver can come from another part of the route.
   * `courseDeg` (GNSS course over ground, when moving) tells the two sides of
   * a U-turn on the same street apart: they are the same line.
   */
  computeProgress(route: Route, currentPosition: LatLon, speedMps: number | null, previousCompletedM?: number | null, courseDeg?: number | null): RouteProgress {
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

    const measure = routeMeasure(route);
    const candidates: { distM: number; alongM: number; seg: number }[] = [];
    let bestDistToRoute = Infinity;
    let bestCumAtProjection = 0;
    let cumLocalM = 0;
    for (let i = 0; i < geom.length - 1; i++) {
      const { distToSegM, alongSegM, segLenM } = projectOntoSegment(currentPosition, geom[i]!, geom[i + 1]!);
      // With maneuver points on the line, measure on the same (great-circle)
      // scale as they are; otherwise keep the leg-length scale of old routes.
      const alongM = measure.stepStartsM
        ? measure.cumM[i]! + (segLenM > 0 ? (alongSegM / segLenM) * (measure.cumM[i + 1]! - measure.cumM[i]!) : 0)
        : cumLocalM + alongSegM;
      cumLocalM += segLenM;
      candidates.push({ distM: distToSegM, alongM, seg: i });
      if (distToSegM < bestDistToRoute) {
        bestDistToRoute = distToSegM;
        bestCumAtProjection = alongM;
      }
    }
    if (previousCompletedM != null && Number.isFinite(previousCompletedM)) {
      // Where the line passes this place more than once (a loop around a
      // block, both sides of a U-turn), pick the part that continues from
      // where the vehicle just was: distance to the line plus how far along
      // the route it would have jumped (backwards counts double).
      let bestCost = Infinity;
      for (const c of candidates) {
        if (c.distM > bestDistToRoute + SAME_PLACE_M) continue;
        const jumpM = c.alongM >= previousCompletedM ? c.alongM - previousCompletedM : 2 * (previousCompletedM - c.alongM);
        let cost = c.distM + JUMP_WEIGHT * jumpM;
        if (courseDeg != null && Number.isFinite(courseDeg)
          && Math.abs(signedTurnDeg(courseDeg, initialBearing(geom[c.seg]!, geom[c.seg + 1]!))) > 100) cost += AGAINST_COURSE_M;
        if (cost < bestCost) { bestCost = cost; bestCumAtProjection = c.alongM; }
      }
    }

    const distanceCompletedM = Math.max(0, Math.min(Math.max(route.distanceM, measure.totalM), bestCumAtProjection));
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
    const legEnds = stepLegEndsM(route);
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
