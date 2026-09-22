// POIEngine — the POI database spec section 15 asks for, backing
// LandmarkEngine's queries. A small real in-memory index over whatever POIs
// are loaded (from the demo dataset now; from the offline POI index built by
// scripts/data once that pipeline has actually run — see DATA_PIPELINE.md
// and LIMITATIONS.md).

import type { LatLon } from "./types";
import type { POI, LandmarkCategory } from "./landmark-engine";
import { haversineMeters } from "./geodesy";

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
    return this.pois
      .map((p) => ({ poi: p, distanceM: haversineMeters(center, p.location) }))
      .filter((x) => x.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .map((x) => x.poi);
  }

  searchByName(query: string): POI[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.pois.filter((p) => p.name.toLowerCase().includes(q) || (p.brand?.toLowerCase().includes(q) ?? false));
  }
}
