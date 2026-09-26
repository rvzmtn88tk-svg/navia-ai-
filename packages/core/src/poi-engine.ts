// POIEngine — the POI database spec section 15 asks for, backing
// LandmarkEngine's queries. A small real in-memory index over whatever POIs
// are loaded (from the demo dataset now; from the offline POI index built by
// scripts/data once that pipeline has actually run — see DATA_PIPELINE.md
// and LIMITATIONS.md).

import type { LatLon } from "./types";
import type { POI, LandmarkCategory } from "./landmark-engine";
import { haversineMeters } from "./geodesy";

/** Anything with a position and a category (app places, core POIs, …). */
export type Locatable = { location: LatLon; category: string };

/** Floating-point slack so a point exactly on the circle counts as inside. */
const BOUNDARY_EPSILON_M = 1e-6;

/**
 * STRICT radius search: every item whose great-circle distance from `center`
 * is ≤ `radiusM` (the boundary itself is inside), optionally of one category,
 * nearest first, each with its distance. No "nearest N", no widening.
 */
export function searchByRadius<T extends Locatable>(items: readonly T[], center: LatLon, radiusM: number, category?: string): (T & { distanceM: number })[] {
  if (!Number.isFinite(radiusM) || radiusM < 0) throw new Error("searchByRadius: radius must be a non-negative number of metres");
  const out: (T & { distanceM: number })[] = [];
  for (const item of items) {
    if (category != null && item.category !== category) continue;
    const distanceM = haversineMeters(center, item.location);
    if (distanceM <= radiusM + BOUNDARY_EPSILON_M) out.push({ ...item, distanceM });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * NEAREST-FIRST search, the one method behind "nearest shelter", "resilience
 * points near me" and every category list: the great-circle distance from
 * `center` (the user's position now) is computed for each item, items are
 * sorted by it, optionally cut to `radiusM` and to the first `limit`.
 */
export function nearestFirst<T extends Locatable>(items: readonly T[], center: LatLon, options: { radiusM?: number | null; limit?: number; category?: string } = {}): (T & { distanceM: number })[] {
  const { radiusM = null, limit, category } = options;
  if (radiusM != null) return searchByRadius(items, center, radiusM, category).slice(0, limit ?? Infinity);
  const out: (T & { distanceM: number })[] = [];
  for (const item of items) {
    if (category != null && item.category !== category) continue;
    out.push({ ...item, distanceM: haversineMeters(center, item.location) });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit ?? Infinity);
}

export class POIEngine {
  private pois: POI[] = [];

  load(pois: POI[]): void {
    this.pois = pois;
  }

  add(poi: POI): void {
    this.pois.push(poi);
  }

  all(): readonly POI[] {
    return this.pois;
  }

  byCategory(category: LandmarkCategory): POI[] {
    return this.pois.filter((p) => p.category === category);
  }

  /** All POIs within `radiusM` of `center`, nearest first. */
  near(center: LatLon, radiusM: number): POI[] {
    return searchByRadius(this.pois, center, radiusM).map(({ distanceM: _d, ...poi }) => poi as POI);
  }

  /** Strict radius search, optionally within one category (see searchByRadius). */
  searchByRadius(center: LatLon, radiusM: number, category?: LandmarkCategory): (POI & { distanceM: number })[] {
    return searchByRadius(this.pois, center, radiusM, category);
  }

  searchByName(query: string): POI[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.pois.filter((p) => p.name.toLowerCase().includes(q) || (p.brand?.toLowerCase().includes(q) ?? false));
  }
}
