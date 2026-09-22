// GeocoderProvider — spec section 14 ("ADDRESS SEARCH"). Mirrors
// RoutingProvider's pattern (route-engine.ts): a single interface so the UI
// never depends on a concrete geocoding backend, and OnlineGeocoder /
// OfflineGeocoder are swappable without touching SearchScreen. Every result
// must self-report where it came from (spec section 40).

import type { LatLon } from "./types";

export type GeocodeResult = {
  label: string;
  location: LatLon;
  source: "online" | "offline" | "demo";
  /** 0..1 if the backend provides one; omitted (not faked as 1) when it doesn't. */
  confidence?: number;
};

export interface GeocoderProvider {
  search(query: string, opts?: { limit?: number }): Promise<GeocodeResult[]>;
}

/** A fixed, named-place search over a small in-memory list — used only by
 * Demo Mode (never the app's default geocoder), so a demo destination can be
 * picked without a network call. Every result is tagged `source: "demo"`. */
export class DemoGeocoderProvider implements GeocoderProvider {
  constructor(private places: { label: string; location: LatLon }[]) {}

  async search(query: string, opts: { limit?: number } = {}): Promise<GeocodeResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const limit = opts.limit ?? 5;
    return this.places
      .filter((p) => p.label.toLowerCase().includes(q))
      .slice(0, limit)
      .map((p) => ({ label: p.label, location: p.location, source: "demo" as const }));
  }
}
