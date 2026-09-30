// Place search for the AI co-pilot — "find fuel along my route", "parking
// near the destination", "a McDonald's that adds at most 10 minutes".
//
// PlaceSearchProvider is the one interface the co-pilot's tools depend on,
// mirroring RoutingProvider/GeocoderProvider: the tools never know whether
// places come from the offline POI index, the demo fixture, or live OSM
// (Overpass). Every returned POI carries `source`, and the provider itself
// reports its source, so the AI can say where a result came from and never
// passes demo data off as real (spec section 40).

import type { LatLon } from "./types";
import type { POI, LandmarkCategory } from "./landmark-engine";
import { haversineMeters } from "./geodesy";
import { RouteGeometryIndex } from "./route-geometry";

export type PlaceSearchSource = "osm-online" | "offline-index" | "demo";

export type PlaceFilter = {
  /** Any of these categories (empty/omitted = any category). */
  categories?: LandmarkCategory[];
  /** Name/brand spellings to match (any of them), e.g. ["McDonald's", "Макдональдз"]. */
  nameVariants?: string[];
};

export interface PlaceSearchProvider {
  readonly source: PlaceSearchSource;
  /** Places within `bufferM` of the polyline. */
  searchAlongPolyline(polyline: LatLon[], bufferM: number, filter: PlaceFilter, limit?: number): Promise<POI[]>;
  /** Places within `radiusM` of `center`, nearest first. */
  searchAround(center: LatLon, radiusM: number, filter: PlaceFilter, limit?: number): Promise<POI[]>;
}

/** Lowercase, strip apostrophes/punctuation/whitespace — so "McDonald's" matches "mcdonalds". */
export function normalizePlaceName(s: string): string {
  let lower = s.toLowerCase();
  // String.prototype.normalize can be missing on JS engines built without Intl.
  try { lower = lower.normalize("NFKD"); } catch { /* keep as is */ }
  return lower
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`"«»().,\-\s_]/g, "");
}

export function matchesFilter(poi: POI, filter: PlaceFilter): boolean {
  if (filter.categories && filter.categories.length > 0 && !filter.categories.includes(poi.category)) return false;
  const variants = (filter.nameVariants ?? []).map(normalizePlaceName).filter((v) => v.length > 0);
  if (variants.length === 0) return true;
  const hay = [poi.name, poi.brand ?? ""].map(normalizePlaceName);
  return variants.some((v) => hay.some((h) => h.includes(v)));
}

/**
 * Search over an in-memory POI list — the offline POI index built by
 * scripts/data (source "offline-index"), or the shipped demo fixture
 * (source "demo"). Pure geometry, no network.
 */
export class LocalPlaceSearchProvider implements PlaceSearchProvider {
  constructor(private pois: readonly POI[], readonly source: PlaceSearchSource) {}

  async searchAlongPolyline(polyline: LatLon[], bufferM: number, filter: PlaceFilter, limit = 50): Promise<POI[]> {
    if (polyline.length === 0) return [];
    const index = polyline.length >= 2 ? new RouteGeometryIndex(polyline) : null;
    return this.pois
      .filter((p) => matchesFilter(p, filter))
      .map((p) => ({ p, d: index ? index.project(p.location)?.offsetM ?? Infinity : haversineMeters(polyline[0]!, p.location) }))
      .filter((x) => x.d <= bufferM)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => ({ ...x.p, source: x.p.source ?? this.sourceForRecords() }));
  }

  async searchAround(center: LatLon, radiusM: number, filter: PlaceFilter, limit = 50): Promise<POI[]> {
    return this.pois
      .filter((p) => matchesFilter(p, filter))
      .map((p) => ({ p, d: haversineMeters(center, p.location) }))
      .filter((x) => x.d <= radiusM)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => ({ ...x.p, source: x.p.source ?? this.sourceForRecords() }));
  }

  private sourceForRecords(): POI["source"] {
    return this.source;
  }
}

// --- OSM Overpass (online) ---

/** OSM tag selectors per category. Categories with no sensible OSM search tag are omitted. */
export const OSM_CATEGORY_SELECTORS: Partial<Record<LandmarkCategory, string[]>> = {
  fuel: ['["amenity"="fuel"]'],
  restaurant: ['["amenity"="restaurant"]'],
  cafe: ['["amenity"="cafe"]'],
  fast_food: ['["amenity"="fast_food"]'],
  parking: ['["amenity"="parking"]'],
  ev_charging: ['["amenity"="charging_station"]'],
  pharmacy: ['["amenity"="pharmacy"]'],
  hospital: ['["amenity"="hospital"]'],
  supermarket: ['["shop"="supermarket"]'],
  shopping_centre: ['["shop"="mall"]'],
  toilets: ['["amenity"="toilets"]'],
  hotel: ['["tourism"="hotel"]', '["tourism"="motel"]'],
  atm: ['["amenity"="atm"]'],
  car_wash: ['["amenity"="car_wash"]'],
  car_repair: ['["shop"="car_repair"]'],
};

function categoryFromTags(tags: Record<string, string>): LandmarkCategory | null {
  for (const [category, selectors] of Object.entries(OSM_CATEGORY_SELECTORS) as [LandmarkCategory, string[]][]) {
    for (const sel of selectors) {
      const m = /^\["(.+)"="(.+)"\]$/.exec(sel);
      if (m && tags[m[1]!] === m[2]) return category;
    }
  }
  return null;
}

/** Escape a user/model-supplied string for an Overpass (POSIX ERE) regex inside a double-quoted literal. */
export function overpassRegexLiteral(variants: string[]): string {
  const parts = variants
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => v.replace(/[.[\]()*+?{}|^$\\]/g, "\\\\$&").replace(/["]/g, "").replace(/[’'`]/g, ".?"));
  return parts.join("|");
}

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string; json(): Promise<unknown>;
}>;

export type OverpassOptions = {
  endpoint: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Max polyline vertices sent in an `around` filter (Overpass query-size limit). */
  maxPolylinePoints?: number;
};

/**
 * Live OSM place search through an Overpass API endpoint. Real data, no API
 * key; public instances are rate-limited — self-host for production. Fails
 * loudly (throws) on network/HTTP errors; the co-pilot tool turns that into
 * an explicit "place search unavailable" result instead of an empty list
 * that would read as "nothing there".
 */
export class OverpassPlaceSearchProvider implements PlaceSearchProvider {
  readonly source = "osm-online" as const;
  private fetchImpl: FetchLike;

  constructor(private options: OverpassOptions) {
    const f = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("OverpassPlaceSearchProvider: no fetch implementation available");
    this.fetchImpl = f;
  }

  buildQuery(areaFilter: string, filter: PlaceFilter, limit: number): string {
    const categories = filter.categories && filter.categories.length > 0 ? filter.categories : null;
    const nameRegex = overpassRegexLiteral(filter.nameVariants ?? []);
    const nameClauses = nameRegex ? [`["name"~"${nameRegex}",i]`, `["brand"~"${nameRegex}",i]`] : [""];
    const statements: string[] = [];
    if (categories) {
      for (const c of categories) {
        for (const sel of OSM_CATEGORY_SELECTORS[c] ?? []) {
          for (const nc of nameClauses) statements.push(`nwr${sel}${nc}${areaFilter};`);
        }
      }
    } else if (nameRegex) {
      for (const nc of nameClauses) statements.push(`nwr${nc}${areaFilter};`);
    }
    if (statements.length === 0) throw new Error("OverpassPlaceSearchProvider: filter needs a searchable category or a name");
    return `[out:json][timeout:15];(${statements.join("")});out center tags ${Math.max(1, Math.min(200, limit))};`;
  }

  async searchAlongPolyline(polyline: LatLon[], bufferM: number, filter: PlaceFilter, limit = 60): Promise<POI[]> {
    if (polyline.length === 0) return [];
    const pts = polyline.length > 1 ? downsample(polyline, this.options.maxPolylinePoints ?? 80) : polyline;
    const coords = pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(",");
    const query = this.buildQuery(`(around:${Math.round(bufferM)},${coords})`, filter, limit);
    return this.run(query, filter);
  }

  async searchAround(center: LatLon, radiusM: number, filter: PlaceFilter, limit = 60): Promise<POI[]> {
    const query = this.buildQuery(`(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lon.toFixed(5)})`, filter, limit);
    const pois = await this.run(query, filter);
    return pois.sort((a, b) => haversineMeters(center, a.location) - haversineMeters(center, b.location));
  }

  private async run(query: string, filter: PlaceFilter): Promise<POI[]> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000) : null;
    let json: { elements?: OverpassElement[] } | null;
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: `data=${encodeURIComponent(query)}`,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`Overpass returned ${response.status} ${response.statusText}`);
      json = (await response.json()) as { elements?: OverpassElement[] } | null;
    } catch (err) {
      throw new Error(`OverpassPlaceSearchProvider: request failed (${(err as Error).message}). Endpoint: ${this.options.endpoint}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const out: POI[] = [];
    for (const el of json?.elements ?? []) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      const tags = el.tags ?? {};
      if (lat == null || lon == null) continue;
      const category = categoryFromTags(tags) ?? filter.categories?.[0] ?? null;
      if (!category) continue;
      const name = tags["name:uk"] ?? tags.name ?? tags.brand;
      if (!name) continue; // an unnamed amenity can't be referred to by voice
      out.push({
        id: `osm:${el.type[0]}${el.id}`,
        name,
        ...(tags.brand ? { brand: tags.brand } : {}),
        category,
        location: { lat, lon },
        ...(tags.opening_hours ? { openingHours: tags.opening_hours } : {}),
        ...(tags.cuisine ? { cuisine: tags.cuisine } : {}),
        source: "osm-online",
      });
    }
    return out;
  }
}

function downsample(points: LatLon[], max: number): LatLon[] {
  if (points.length <= max) return points;
  const index = new RouteGeometryIndex(points);
  const out: LatLon[] = [];
  for (let i = 0; i < max; i++) out.push(index.pointAt((index.lengthM * i) / (max - 1)));
  return out;
}

// --- opening_hours ---

const DAY_CODES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

function parseDaySpec(spec: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (p === "PH" || p === "SH") continue; // holidays: not modelled, ignored
    const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(p);
    if (range) {
      const a = DAY_CODES.indexOf(range[1] as (typeof DAY_CODES)[number]);
      const b = DAY_CODES.indexOf(range[2] as (typeof DAY_CODES)[number]);
      if (a < 0 || b < 0) return null;
      // OSM weeks start on Monday: Mo-Su wraps through Sunday.
      for (let d = a, n = 0; n < 7; d = (d + 1) % 7, n++) { days.add(d); if (d === b) break; }
      continue;
    }
    const single = DAY_CODES.indexOf(p as (typeof DAY_CODES)[number]);
    if (single < 0) return null;
    days.add(single);
  }
  return days;
}

function parseTimeRanges(spec: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!m) return null;
    ranges.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  return ranges;
}

/**
 * Is a place open at `at` (device-local time), per its raw OSM
 * `opening_hours`? Supports the common subset ("24/7", "Mo-Fr 08:00-20:00;
 * Sa 09:00-14:00", comma-separated ranges, "off", past-midnight ranges).
 * Returns null — "unknown" — for anything else rather than guessing.
 */
export function evaluateOpeningHours(value: string | undefined, at: Date): boolean | null {
  if (!value) return null;
  const v = value.trim();
  if (v === "24/7") return true;
  const day = at.getDay();
  const prevDay = (day + 6) % 7;
  const minute = at.getHours() * 60 + at.getMinutes();
  let result: boolean | null = null;
  let anyRuleMatchedToday = false;
  for (const rawRule of v.split(";")) {
    const rule = rawRule.trim();
    if (!rule) continue;
    const m = /^(?:([A-Za-z,\- ]+?)\s+)?(off|closed|24\/7|[\d:,\- ]+)$/.exec(rule);
    if (!m) return null;
    const daySpec = m[1]?.trim();
    const days = daySpec ? parseDaySpec(daySpec.replace(/\s+/g, "")) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const timeSpec = m[2]!.trim();
    if (timeSpec === "off" || timeSpec === "closed") {
      if (days.has(day)) { result = false; anyRuleMatchedToday = true; }
      continue;
    }
    if (timeSpec === "24/7") {
      if (days.has(day)) { result = true; anyRuleMatchedToday = true; }
      continue;
    }
    const ranges = parseTimeRanges(timeSpec.replace(/\s+/g, ""));
    if (!ranges) return null;
    let open = false;
    for (const [start, end] of ranges) {
      if (end > start) {
        if (days.has(day) && minute >= start && minute < end) open = true;
      } else {
        // Crosses midnight: today's evening part, or the spill-over from yesterday.
        if (days.has(day) && minute >= start) open = true;
        if (days.has(prevDay) && minute < end) open = true;
      }
    }
    if (days.has(day)) { anyRuleMatchedToday = true; result = open; }
    else if (open) result = true; // yesterday's past-midnight range still running
  }
  if (!anyRuleMatchedToday && result === null) return false; // well-formed rules, none cover today
  return result;
}
