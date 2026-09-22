// Real online address search — spec section 14 ("ADDRESS SEARCH"),
// implementing @navia/core's GeocoderProvider so SearchScreen can switch to
// an OfflineGeocoder later with no UI change. Calls a configurable
// Nominatim-compatible /search endpoint (config.geocoderUrl) — no hardcoded
// results, no fabricated coordinates. UNBUILT/UNTESTED — this sandbox's
// network cannot reach Nominatim or any other geocoding API (confirmed:
// see LIMITATIONS.md), so this has been reviewed against Nominatim's
// documented response shape but never actually called.
import type { GeocoderProvider, GeocodeResult } from "@navia/core";
import { config } from "../config";

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
  importance?: number;
};

// Biases results toward Kyiv + Kyiv Oblast without excluding results
// elsewhere (Nominatim's viewbox without bounded=1 is a soft bias, not a hard filter).
const KYIV_OBLAST_VIEWBOX = "29.2,51.6,32.2,49.9"; // left,top,right,bottom

export class OnlineGeocoderProvider implements GeocoderProvider {
  constructor(private baseUrl: string = config.geocoderUrl) {}

  async search(query: string, opts: { limit?: number } = {}): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(opts.limit ?? 8));
    url.searchParams.set("viewbox", KYIV_OBLAST_VIEWBOX);
    url.searchParams.set("addressdetails", "0");

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          // Nominatim's usage policy requires a real identifying User-Agent
          // or Referer — https://operations.osmfoundation.org/policies/nominatim/
          "User-Agent": "NAVIA/0.1 (navigation app; see repository README)",
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(`OnlineGeocoderProvider: network request failed (${(err as Error).message}). Endpoint: ${this.baseUrl}`);
    }

    if (!response.ok) {
      throw new Error(`OnlineGeocoderProvider: geocoding endpoint returned ${response.status} ${response.statusText}`);
    }

    const results = (await response.json()) as NominatimResult[];
    return results.map((r) => ({
      label: r.display_name,
      location: { lat: parseFloat(r.lat), lon: parseFloat(r.lon) },
      source: "online" as const,
      ...(r.importance != null ? { confidence: Math.max(0, Math.min(1, r.importance)) } : {}),
    }));
  }
}
