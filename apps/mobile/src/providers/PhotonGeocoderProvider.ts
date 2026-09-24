import type { GeocoderProvider, GeocodeResult } from "@navia/core";
import { config } from "../config";

type PhotonFeature = {
  geometry?: { coordinates?: unknown };
  properties?: {
    name?: unknown;
    housenumber?: unknown;
    street?: unknown;
    district?: unknown;
    city?: unknown;
    county?: unknown;
    state?: unknown;
    country?: unknown;
    countrycode?: unknown;
  };
};

type PhotonResponse = { features?: unknown };

const REQUEST_TIMEOUT_MS = 10_000;
const KYIV_BOUNDS = { minLon: 29.1, minLat: 49.0, maxLon: 32.3, maxLat: 51.6 };
const KYIV_CENTER = { lon: 30.5234, lat: 50.4501 };

/** Search-as-you-type geocoding for Kyiv and Kyiv Oblast using Photon/OSM. */
export class PhotonGeocoderProvider implements GeocoderProvider {
  constructor(private endpoint: string = config.autocompleteUrl) {}

  async search(query: string, opts: { limit?: number; language?: string } = {}): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    if (q.length > 250) throw new Error("PhotonGeocoderProvider: search text is too long.");

    const url = new URL(this.endpoint);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(Number.isFinite(opts.limit) ? Math.max(1, Math.min(8, Math.floor(opts.limit!))) : 8));
    // The hosted Photon demo does not currently advertise Ukrainian as an
    // output language. Omitting `lang` returns each place's local OSM name.
    if (opts.language === "en") url.searchParams.set("lang", "en");
    url.searchParams.set("countrycode", "UA");
    url.searchParams.set("bbox", `${KYIV_BOUNDS.minLon},${KYIV_BOUNDS.minLat},${KYIV_BOUNDS.maxLon},${KYIV_BOUNDS.maxLat}`);
    url.searchParams.set("lat", String(KYIV_CENTER.lat));
    url.searchParams.set("lon", String(KYIV_CENTER.lon));
    url.searchParams.set("zoom", "7");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let payload: PhotonResponse;
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      payload = await response.json() as PhotonResponse;
    } catch (error) {
      throw new Error(`PhotonGeocoderProvider: autocomplete request failed (${(error as Error).message}).`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`PhotonGeocoderProvider: service returned ${response.status} ${response.statusText}.`);
    }
    if (!payload || !Array.isArray(payload.features)) {
      throw new Error("PhotonGeocoderProvider: service returned an invalid result list.");
    }

    return (payload.features as PhotonFeature[]).flatMap((feature) => {
      const coordinates = feature.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
      const lon = Number(coordinates[0]);
      const lat = Number(coordinates[1]);
      const properties = feature.properties ?? {};
      const countryCode = asText(properties.countrycode);
      if (
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < KYIV_BOUNDS.minLat || lat > KYIV_BOUNDS.maxLat ||
        lon < KYIV_BOUNDS.minLon || lon > KYIV_BOUNDS.maxLon ||
        (countryCode && countryCode.toUpperCase() !== "UA")
      ) return [];

      const label = makeLabel(properties);
      return label ? [{ label, location: { lat, lon }, source: "online" as const }] : [];
    });
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function makeLabel(properties: NonNullable<PhotonFeature["properties"]>): string {
  const street = asText(properties.street);
  const houseNumber = asText(properties.housenumber);
  const streetLine = street && houseNumber ? `${street}, ${houseNumber}` : street || houseNumber;
  const parts = [
    asText(properties.name),
    streetLine,
    asText(properties.district),
    asText(properties.city),
    asText(properties.county),
    asText(properties.state),
    asText(properties.country),
  ];
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.toLocaleLowerCase();
    if (!part || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(", ");
}
