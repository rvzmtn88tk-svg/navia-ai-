import type { LatLon } from "@navia/core";

export type NearbyPlaceCategory =
  | "shelter" | "resilience" | "fuel" | "shop" | "pharmacy" | "hospital"
  | "transport" | "police" | "fire" | "atm" | "parking" | "charger"
  | "toilets" | "water" | "food" | "other";

export type NearbyPlace = {
  id: string;
  name: string;
  category: NearbyPlaceCategory;
  location: LatLon;
  address?: string;
  openingHours?: string;
  availability?: string;
  distanceM: number;
  source: "Kyiv City open data" | "OpenStreetMap";
};

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};
type OverpassResponse = { elements?: OverpassElement[] };
type ArcGISFeature = {
  geometry?: { x?: number; y?: number; coordinates?: [number, number] };
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
};
type ArcGISResponse = { features?: ArcGISFeature[]; error?: { message?: string } };

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Use Kyiv's public production GIS service. The old stage host often returned
// an empty layer, which made the official shelter and resilience points vanish.
const KYIV_GIS_BASE = "https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer";
const SEARCH_RADIUS_M = 2600;
const MAX_RESULTS = 120;
const KYIV_GIS_TIMEOUT_MS = 12_000;
let cache: { location: LatLon; at: number; optionsKey: string; places: NearbyPlace[] } | null = null;

function distanceM(a: LatLon, b: LatLon): number {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function classify(tags: Record<string, string>): NearbyPlaceCategory | null {
  if (tags.amenity === "shelter" || tags.emergency === "assembly_point" || tags.shelter_type) return "shelter";
  if (tags.amenity === "social_facility" && /warming|shelter/i.test(tags.social_facility ?? "")) return "resilience";
  if (tags.power_supply === "point" || tags.amenity === "community_centre") return "resilience";
  if (tags.amenity === "fuel") return "fuel";
  if (tags.amenity === "pharmacy" || tags.shop === "chemist") return "pharmacy";
  if (["hospital", "clinic", "doctors"].includes(tags.amenity ?? "")) return "hospital";
  if (["bus_station", "ferry_terminal"].includes(tags.amenity ?? "") || tags.public_transport === "station" || ["station", "subway_entrance", "tram_stop"].includes(tags.railway ?? "")) return "transport";
  if (tags.amenity === "police") return "police";
  if (tags.amenity === "fire_station") return "fire";
  if (tags.amenity === "atm" || tags.amenity === "bank") return "atm";
  if (tags.amenity === "parking") return "parking";
  if (tags.amenity === "charging_station") return "charger";
  if (tags.amenity === "toilets") return "toilets";
  if (tags.amenity === "drinking_water") return "water";
  if (["restaurant", "cafe", "fast_food", "food_court"].includes(tags.amenity ?? "")) return "food";
  if (["supermarket", "convenience", "mall", "department_store", "marketplace"].includes(tags.shop ?? "")) return "shop";
  return null;
}

function placeName(tags: Record<string, string>, category: NearbyPlaceCategory): string {
  const named = tags["name:uk"] ?? tags.name ?? tags.brand ?? tags.operator;
  if (named) return named;
  switch (category) {
    case "shelter": return "Укриття · OpenStreetMap";
    case "resilience": return "Пункт допомоги · OpenStreetMap";
    case "fuel": return "АЗС";
    case "shop": return "Магазин";
    case "pharmacy": return "Аптека";
    case "hospital": return "Медичний заклад";
    case "transport": return "Транспорт";
    case "police": return "Поліція";
    case "fire": return "Пожежна частина";
    case "atm": return "Банк або банкомат";
    case "parking": return "Паркування";
    case "charger": return "Зарядна станція";
    case "toilets": return "Громадська вбиральня";
    case "water": return "Питна вода";
    case "food": return "Заклад харчування";
    default: return "Місце поблизу";
  }
}

function parseOverpass(elements: OverpassElement[], center: LatLon): NearbyPlace[] {
  return elements.flatMap((item) => {
    if (!item.tags) return [];
    const category = classify(item.tags);
    if (!category) return [];
    const lat = item.lat ?? item.center?.lat;
    const lon = item.lon ?? item.center?.lon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const address = [item.tags["addr:street"], item.tags["addr:housenumber"]].filter(Boolean).join(" ");
    return [{
      id: `osm-${item.type}-${item.id}`,
      name: placeName(item.tags, category),
      category,
      location: { lat, lon },
      ...(address ? { address } : {}),
      ...(item.tags.opening_hours ? { openingHours: item.tags.opening_hours } : {}),
      distanceM: distanceM(center, { lat, lon }),
      source: "OpenStreetMap" as const,
    }];
  });
}

function parseKyivFeatures(features: ArcGISFeature[] | undefined, layer: "shelter" | "resilience", center: LatLon): NearbyPlace[] {
  return (features ?? []).flatMap((item, index) => {
    const lat = item.geometry?.y ?? item.geometry?.coordinates?.[1];
    const lon = item.geometry?.x ?? item.geometry?.coordinates?.[0];
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const fields = item.properties ?? item.attributes ?? {};
    const name = String(fields.name ?? fields.NAME ?? fields.name_po ?? fields.title ?? fields.TITLE ?? fields.type_building ?? fields.kind
      ?? (layer === "shelter" ? "Укриття · міські відкриті дані" : "Пункт незламності · міські відкриті дані"));
    const address = String(fields.address ?? fields.ADDRESS ?? fields.addr ?? fields.ADDR ?? "");
    const openingHours = String(fields.working_time ?? fields.timeworkf ?? fields.opening_hours ?? "");
    const availability = String(fields.availability ?? fields.invalid ?? "");
    return [{
      id: `kyiv-${layer}-${String(fields.OBJECTID ?? fields.objectid ?? index)}`,
      name,
      category: layer,
      location: { lat, lon },
      ...(address ? { address } : {}),
      ...(openingHours ? { openingHours } : {}),
      ...(availability ? { availability } : {}),
      distanceM: distanceM(center, { lat, lon }),
      source: "Kyiv City open data" as const,
    }];
  });
}

export class NearbyPlacesProvider {
  async fetchNearby(location: LatLon, options: { includeKyivOfficialData?: boolean; force?: boolean } = {}): Promise<NearbyPlace[]> {
    if (!Number.isFinite(location.lat) || location.lat < -90 || location.lat > 90 || !Number.isFinite(location.lon) || location.lon < -180 || location.lon > 180) {
      throw new Error("NearbyPlacesProvider: location must contain valid latitude/longitude coordinates.");
    }
    const optionsKey = options.includeKyivOfficialData ? "kyiv" : "osm";
    if (!options.force && cache && cache.optionsKey === optionsKey && Date.now() - cache.at < 60_000 && distanceM(location, cache.location) < 700) {
      return cache.places;
    }

    const query = `[out:json][timeout:18];(nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["amenity"~"shelter|fuel|pharmacy|hospital|clinic|doctors|bus_station|ferry_terminal|police|fire_station|atm|bank|parking|charging_station|toilets|drinking_water|restaurant|cafe|fast_food|food_court"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["emergency"="assembly_point"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["shop"~"supermarket|convenience|mall|chemist|department_store|marketplace"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["amenity"="social_facility"]["social_facility"~"shelter|warming_centre"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["power_supply"="point"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["public_transport"="station"];nwr(around:${SEARCH_RADIUS_M},${location.lat},${location.lon})["railway"~"station|subway_entrance|tram_stop"];);out center tags;`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let osmPlaces: NearbyPlace[] = [];
    let osmError: unknown = null;
    try {
      const response = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json", "User-Agent": "NAVIA/0.1 (navigation app)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenStreetMap returned HTTP ${response.status}.`);
      const data = await response.json() as OverpassResponse;
      osmPlaces = parseOverpass(data.elements ?? [], location);
    } catch (error) {
      osmError = error;
    } finally {
      clearTimeout(timeout);
    }

    let official: NearbyPlace[] = [];
    if (options.includeKyivOfficialData) {
      const [shelters, resilience] = await Promise.all([
        this.queryKyivLayer(location, 0, "shelter"),
        this.queryKyivLayer(location, 1, "resilience"),
      ]);
      official = [...shelters, ...resilience];
    }
    if (osmError && osmPlaces.length === 0 && official.length === 0) throw osmError;

    const byId = new Map<string, NearbyPlace>();
    for (const place of [...osmPlaces, ...official].sort((a, b) => a.distanceM - b.distanceM)) byId.set(place.id, place);
    const result = [...byId.values()].sort((a, b) => a.distanceM - b.distanceM).slice(0, MAX_RESULTS);
    cache = { location, at: Date.now(), optionsKey, places: result };
    return result;
  }

  private async queryKyivLayer(location: LatLon, layer: number, type: "shelter" | "resilience"): Promise<NearbyPlace[]> {
    const url = new URL(`${KYIV_GIS_BASE}/${layer}/query`);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("f", "json");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("geometry", `${location.lon},${location.lat}`);
    url.searchParams.set("geometryType", "esriGeometryPoint");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("distance", String(SEARCH_RADIUS_M));
    url.searchParams.set("units", "esriSRUnit_Meter");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KYIV_GIS_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) return [];
      const data = await response.json() as ArcGISResponse;
      if (data.error) return [];
      return parseKyivFeatures(data.features, type, location);
    } catch {
      // Keep community-map infrastructure visible if the city GIS is offline.
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
