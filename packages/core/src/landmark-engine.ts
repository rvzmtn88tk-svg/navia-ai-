// LandmarkEngine — spec section 15 ("POI / LANDMARK ENGINE").
//
// Implements the relevance formula exactly as given (an unweighted sum —
// the spec gives explicit coefficients for other formulas, e.g. confidence
// and GNSS anomaly, but writes this one as a plain sum):
//   relevance = routeProximity + maneuverProximity + visibility
//             + semanticImportance + sideOfRoadMatch
//
// Also implements the worked "Я бачу WOG. Це моя заправка?" example
// end-to-end: filters POIs by name/brand, keeps only ones that are actually
// ahead on the route corridor (computed from real route geometry via
// RouteProgressEngine's projection, not guessed), scores the survivors, and
// answers confidently only when one candidate is a clear winner — otherwise
// it says it can't reliably tell, exactly as the spec's two example replies
// do. "Answer only if data supports it."

import type { LatLon, Landmark, RouteStep } from "./types";
import { haversineMeters } from "./geodesy";
import type { Route } from "./route-engine";
import { RouteProgressEngine } from "./route-engine";

export type LandmarkCategory =
  | "fuel"
  | "supermarket"
  | "pharmacy"
  | "hospital"
  | "bridge"
  | "railway_crossing"
  | "major_intersection"
  | "shopping_centre"
  | "school"
  | "church"
  | "parking"
  | "government_building"
  | "recognizable_landmark";

export type POI = {
  id: string;
  name: string;
  brand?: string;
  category: LandmarkCategory;
  location: LatLon;
};

export type LandmarkRelevanceInputs = {
  routeProximity: number; // 0..1, 1 = right on the route corridor
  maneuverProximity: number; // 0..1, 1 = right at the upcoming maneuver point
  visibility: number; // 0..1
  semanticImportance: number; // 0..1, by category
  sideOfRoadMatch: number; // 0..1
};

export function scoreLandmarkRelevance(i: LandmarkRelevanceInputs): number {
  return (
    i.routeProximity +
    i.maneuverProximity +
    i.visibility +
    i.semanticImportance +
    i.sideOfRoadMatch
  );
}

// Fixed per-category importance — recognizable, safety-relevant categories
// (hospital, railway crossing) outrank incidental ones (parking).
const SEMANTIC_IMPORTANCE: Record<LandmarkCategory, number> = {
  hospital: 0.95,
  railway_crossing: 0.9,
  bridge: 0.85,
  major_intersection: 0.8,
  government_building: 0.7,
  church: 0.65,
  school: 0.65,
  shopping_centre: 0.6,
  fuel: 0.6,
  supermarket: 0.55,
  pharmacy: 0.55,
  recognizable_landmark: 0.5,
  parking: 0.4,
};

const ROUTE_CORRIDOR_M = 60; // within this distance of the route line -> routeProximity 1
const LOOKAHEAD_M = 500; // only consider POIs within this far ahead on the route
const AMBIGUITY_MARGIN = 0.3; // relevance-score gap required to call a single winner

export type LandmarkQueryResult =
  | {
      kind: "confirmed";
      landmark: Landmark;
      distanceM: number;
      afterManeuver: RouteStep["maneuver"] | null;
      message: string;
    }
  | { kind: "ambiguous"; candidateCount: number; message: string }
  | { kind: "no_match"; message: string };

type ScoredCandidate = {
  poi: POI;
  distanceM: number;
  distanceAlongRouteM: number;
  distanceOffRouteM: number;
  score: number;
};

export class LandmarkEngine {
  private progressEngine = new RouteProgressEngine();

  /** Rank all POIs by relevance for the current drive (spec's `relevance` formula). */
  rankNearby(pois: POI[], route: Route, currentPosition: LatLon, speedMps: number | null): ScoredCandidate[] {
    const progress = this.progressEngine.computeProgress(route, currentPosition, speedMps);
    return this.scoreCandidates(pois, route, currentPosition, progress.distanceCompletedM, progress.nextStepDistanceM)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Answer "I see <name>, is that mine?" — the spec's worked example.
   * Only confirms when exactly one candidate is a clear winner; otherwise
   * says so honestly (ambiguous or no match), never guesses.
   */
  identifyLandmarkQuery(
    pois: POI[],
    queryText: string,
    route: Route,
    currentPosition: LatLon,
    speedMps: number | null
  ): LandmarkQueryResult {
    const q = queryText.trim().toLowerCase();
    const matchingPois = pois.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.brand?.toLowerCase().includes(q) ?? false)
    );
    if (matchingPois.length === 0) {
      return { kind: "no_match", message: `Я не знайшла жодного «${queryText}» поблизу вашого маршруту.` };
    }

    const progress = this.progressEngine.computeProgress(route, currentPosition, speedMps);
    const candidates = this.scoreCandidates(matchingPois, route, currentPosition, progress.distanceCompletedM, progress.nextStepDistanceM)
      .filter((c) => c.distanceOffRouteM <= ROUTE_CORRIDOR_M && c.distanceAlongRouteM >= 0 && c.distanceAlongRouteM <= LOOKAHEAD_M)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return { kind: "no_match", message: `На вашому маршруті попереду немає «${queryText}», за даними які в мене є.` };
    }

    const best = candidates[0]!;
    const second = candidates[1];
    if (second && best.score - second.score < AMBIGUITY_MARGIN) {
      return {
        kind: "ambiguous",
        candidateCount: candidates.length,
        message: `Є декілька «${queryText}» поблизу. Я не можу надійно визначити, який саме ви бачите.`,
      };
    }

    const distanceM = Math.round(best.distanceAlongRouteM / 10) * 10;
    const afterManeuver = progress.nextStep?.maneuver ?? null;
    const maneuverPhrase = afterManeuver ? maneuverToPhrase(afterManeuver) : "прямо";
    return {
      kind: "confirmed",
      landmark: poiToLandmark(best.poi, best.distanceM),
      distanceM: best.distanceAlongRouteM,
      afterManeuver,
      message: `Так, найближчий ${best.poi.name} на вашому маршруті приблизно за ${distanceM} метрів. Після нього — ${maneuverPhrase}.`,
    };
  }

  private scoreCandidates(
    pois: POI[],
    route: Route,
    currentPosition: LatLon,
    distanceCompletedM: number,
    nextStepDistanceM: number | null
  ): ScoredCandidate[] {
    return pois.map((poi) => {
      const { distToSegM: distanceOffRouteM, alongM: distanceAlongRouteAbsoluteM } = nearestPointOnRoute(poi.location, route.geometry);
      const distanceAlongRouteM = distanceAlongRouteAbsoluteM - distanceCompletedM;
      const distanceM = haversineMeters(currentPosition, poi.location);
      const routeProximity = Math.max(0, 1 - distanceOffRouteM / ROUTE_CORRIDOR_M);
      const maneuverProximity =
        nextStepDistanceM == null
          ? 0.3
          : Math.max(0, 1 - Math.abs(distanceAlongRouteM - nextStepDistanceM) / 150);
      const visibility = 0.6; // no camera-vision occlusion data at this layer; a neutral constant
      const semanticImportance = SEMANTIC_IMPORTANCE[poi.category];
      const sideOfRoadMatch = 0.5; // no live heading-vs-POI-side comparison at this layer yet
      const score = scoreLandmarkRelevance({ routeProximity, maneuverProximity, visibility, semanticImportance, sideOfRoadMatch });
      return { poi, distanceM, distanceAlongRouteM, distanceOffRouteM, score };
    });
  }
}

function maneuverToPhrase(m: RouteStep["maneuver"]): string {
  switch (m) {
    case "left": return "ліворуч";
    case "right": return "праворуч";
    case "uturn": return "розворот";
    case "roundabout": return "круговий рух";
    case "arrive": return "ваш пункт призначення";
    case "depart": return "прямо";
    case "straight": return "прямо";
  }
}

function poiToLandmark(poi: POI, distanceM: number): Landmark {
  return {
    id: poi.id,
    name: poi.name,
    type: poi.category,
    location: poi.location,
    distanceM,
    routeRelevance: 0, // caller has the real score; this field is for downstream display only
    brand: poi.brand,
  };
}

// Local-metric nearest-point-on-polyline projection (see route-engine.ts for
// the same technique used on the hot progress-tracking path).
function nearestPointOnRoute(p: LatLon, geometry: LatLon[]): { distToSegM: number; alongM: number } {
  if (geometry.length < 2) return { distToSegM: Infinity, alongM: 0 };
  const latRad = (geometry[0]!.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(latRad);
  const toXY = (pt: LatLon, origin: LatLon) => ({
    x: (pt.lon - origin.lon) * mPerDegLon,
    y: (pt.lat - origin.lat) * mPerDegLat,
  });

  let cum = 0;
  let bestDist = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i]!, b = geometry[i + 1]!;
    const origin = a;
    const P = toXY(p, origin), A = { x: 0, y: 0 }, B = toXY(b, origin);
    const abx = B.x - A.x, aby = B.y - A.y;
    const segLenSq = abx * abx + aby * aby;
    let t = segLenSq === 0 ? 0 : ((P.x - A.x) * abx + (P.y - A.y) * aby) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = A.x + t * abx, projY = A.y + t * aby;
    const dx = P.x - projX, dy = P.y - projY;
    const distToSegM = Math.sqrt(dx * dx + dy * dy);
    const segLenM = Math.sqrt(segLenSq);
    if (distToSegM < bestDist) {
      bestDist = distToSegM;
      bestAlong = cum + t * segLenM;
    }
    cum += segLenM;
  }
  return { distToSegM: bestDist, alongM: bestAlong };
}
