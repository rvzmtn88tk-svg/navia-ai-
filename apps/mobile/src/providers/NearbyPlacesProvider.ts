import { nearestFirst, searchByRadius, type LatLon } from "@navia/core";
import { overpass, type OverpassElement } from "./overpass";
import { MAX_RADIUS_TILES, tileCountForRadius, tilePoisNear } from "./vectorTiles";
import { bundledShelters } from "./openDataShelters";

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
  source: "Kyiv City open data" | "OpenStreetMap" | "data.gov.ua";
  /** online = fetched now; offline = from data stored on the phone; demo = demo dataset. */
  origin: PlaceOrigin;
  /** Publisher / snapshot date, shown next to the source. */
  sourceDetail?: string;
};

export type PlaceOrigin = "online" | "offline" | "demo";

/** Lazy: offline/offlinePlaces imports this module (avoid a require cycle). */
function offlinePlacesWithin(...args: Parameters<typeof import("../offline/offlinePlaces").offlinePlacesWithin>) {
  return (require("../offline/offlinePlaces") as typeof import("../offline/offlinePlaces")).offlinePlacesWithin(...args);
}

export type SearchOptions = { includeKyivOfficialData?: boolean; force?: boolean; radiusM?: number | null };
/** `unavailable`: sources that did not answer in time (the list may be partial). */
export type CategoryResult = { places: NearbyPlace[]; unavailable: string[]; usedOffline: boolean };

export type ArcGISFeature = {
  geometry?: { x?: number; y?: number; coordinates?: [number, number] };
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
};
export type ArcGISResponse = { features?: ArcGISFeature[]; error?: { message?: string } };

// Use Kyiv's public production GIS service. The old stage host often returned
// an empty layer, which made the official shelter and resilience points vanish.
export const KYIV_GIS_BASE = "https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer";
const SEARCH_RADIUS_M = 2600;
/** Official/community data within this distance counts as "found nearby":
 * then a slow OpenStreetMap is given only a short grace. */
const CLOSE_ENOUGH_M = 800;
/** How long to wait for OpenStreetMap when nothing is known nearby yet. */
const OSM_PATIENCE_MS = 15_000;

/** Kyiv city limits (bounding box) — where the city's official shelter and
 * resilience-point layers apply. Decided by position, not by the alert feed. */
export function isInKyiv(p: LatLon): boolean {
  return p.lat >= 50.21 && p.lat <= 50.59 && p.lon >= 30.24 && p.lon <= 30.83;
}

export type FetchCategory = "shelter" | "resilience" | "fuel" | "charger" | "pharmacy" | "hospital" | "atm" | "water" | "food" | "shop";

// Overpass selectors per category (kept in sync with classify()).
export const CATEGORY_QUERY: Record<FetchCategory, string[]> = {
  shelter: ['["amenity"="shelter"]["shelter_type"~"bomb|air_raid|air-raid|civil|bunker|protective|underground",i]', '["emergency"="shelter"]', '["building"="bunker"]', '["military"="bunker"]', '["name"~"укриття|сховищ|shelter",i]'],
  resilience: ['["amenity"="social_facility"]["social_facility"~"shelter|warming_centre"]', '["power_supply"="point"]', '["name"~"незламн",i]'],
  fuel: ['["amenity"="fuel"]'],
  charger: ['["amenity"="charging_station"]'],
  pharmacy: ['["amenity"="pharmacy"]', '["shop"="chemist"]'],
  hospital: ['["amenity"~"^(hospital|clinic|doctors)$"]'],
  atm: ['["amenity"~"^(atm|bank)$"]'],
  water: ['["amenity"="drinking_water"]'],
  food: ['["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]'],
  shop: ['["shop"~"^(supermarket|convenience|mall|department_store|marketplace)$"]'],
};

// First pass, then a wider pass when fewer than 3 were found (villages).
const CATEGORY_RADII: Record<FetchCategory, number[]> = {
  shelter: [3000, 15000], resilience: [3000, 15000], fuel: [6000, 20000], charger: [6000, 20000], hospital: [6000, 20000],
  pharmacy: [3000, 10000], atm: [3000, 10000], shop: [3000, 10000], water: [3000, 10000], food: [2000, 8000],
};

const TILE_CATEGORIES = new Set<FetchCategory>(["fuel", "charger", "pharmacy", "hospital", "atm", "shop", "food", "water"]);

const NOMINATIM_PHRASE: Partial<Record<FetchCategory, string>> = {
  fuel: "fuel", pharmacy: "pharmacy", hospital: "hospital", atm: "atm", shop: "supermarket", food: "cafe", charger: "charging station", water: "drinking water",
};

// Last good result per category, kept on the phone for use without network.
type SavedPlaces = { location: LatLon; at: number; places: NearbyPlace[] };
type KV = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void> };
let kv: KV | null | undefined;
function storage(): KV | null {
  if (kv !== undefined) return kv;
  try { kv = (require("expo-sqlite/kv-store") as { default: KV }).default; } catch { kv = null; }
  return kv;
}
export function setPlacesStorageForTests(store: KV | null): void {
  kv = store;
}
async function save(category: FetchCategory, location: LatLon, places: NearbyPlace[]): Promise<void> {
  const store = storage();
  if (!store || places.length === 0) return;
  await store.setItemAsync(`navia.places.${category}.v1`, JSON.stringify({ location, at: Date.now(), places } satisfies SavedPlaces)).catch(() => {});
}
async function loadSaved(category: FetchCategory, location: LatLon): Promise<NearbyPlace[] | null> {
  const store = storage();
  if (!store) return null;
  try {
    const raw = await store.getItemAsync(`navia.places.${category}.v1`);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedPlaces;
    if (Date.now() - saved.at > 14 * 86_400_000 || distanceM(saved.location, location) > 8000) return null;
    return saved.places.map((p) => ({ ...p, origin: "offline" as const, distanceM: distanceM(location, p.location) })).sort((a, b) => a.distanceM - b.distanceM);
  } catch {
    return null;
  }
}

const categoryCache = new Map<string, { location: LatLon; at: number; places: NearbyPlace[] }>();
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
  // Only protective shelters count: OSM "amenity=shelter" is mostly bus stops,
  // picnic roofs and huts, which must never be offered as a shelter.
  if (isProtectiveShelter(tags)) return "shelter";
  if (/незламн/i.test(tags.name ?? "")) return "resilience";
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

const PROTECTIVE_SHELTER = /bomb|air_raid|air-raid|civil|bunker|protective|underground/i;

const NOT_A_SHELTER = /public_transport|picnic|gazebo|lean_to|weather|field|basic_hut|sun_shelter|rock_shelter/i;

export function isProtectiveShelter(tags: Record<string, string>): boolean {
  if (tags.building === "bunker" || tags.military === "bunker" || tags.bunker_type) return true;
  if (tags.emergency === "shelter" && tags.highway !== "bus_stop" && tags.public_transport == null) return true;
  if (tags.amenity === "shelter" && PROTECTIVE_SHELTER.test(tags.shelter_type ?? "")) return true;
  // Named "Укриття"/"Сховище" features, but never a bus stop or picnic roof.
  if (/укриття|сховищ/i.test(tags.name ?? "") && !NOT_A_SHELTER.test(tags.shelter_type ?? "") && tags.highway !== "bus_stop" && tags.public_transport == null) return true;
  return false;
}

export function placeName(tags: Record<string, string>, category: NearbyPlaceCategory): string {
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

export function parseOverpass(elements: OverpassElement[], center: LatLon): NearbyPlace[] {
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
      origin: "online" as const,
    }];
  });
}

export function parseKyivFeatures(features: ArcGISFeature[] | undefined, layer: "shelter" | "resilience", center: LatLon): NearbyPlace[] {
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
      origin: "online" as const,
      sourceDetail: layer === "shelter" ? "КМДА · Укриття" : "КМДА · Пункти обігріву (незламності)",
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
    let osmPlaces: NearbyPlace[] = [];
    let osmError: unknown = null;
    try {
      osmPlaces = parseOverpass(await overpass(query), location);
    } catch (error) {
      osmError = error;
    }

    let official: NearbyPlace[] = [];
    if (options.includeKyivOfficialData) {
      const [shelters, resilience] = await Promise.all([
        this.queryKyivLayer(location, 0, "shelter"),
        this.queryKyivLayer(location, 1, "resilience"),
      ]);
      official = [...(shelters ?? []), ...(resilience ?? [])];
    }
    if (osmError && osmPlaces.length === 0 && official.length === 0) throw osmError;

    const byId = new Map<string, NearbyPlace>();
    for (const place of [...osmPlaces, ...official].sort((a, b) => a.distanceM - b.distanceM)) byId.set(place.id, place);
    const result = [...byId.values()].sort((a, b) => a.distanceM - b.distanceM).slice(0, MAX_RESULTS);
    cache = { location, at: Date.now(), optionsKey, places: result };
    return result;
  }

  /** Places of one category, nearest first. Queried on demand so a busy city
   * centre full of cafés cannot crowd out pharmacies or fuel. Villages get a
   * wider second pass; when every OSM mirror fails, Nominatim is tried, and
   * when the network is gone the last saved result for this area is used. */
  async fetchCategory(location: LatLon, category: FetchCategory, options: SearchOptions = {}): Promise<NearbyPlace[]> {
    return (await this.searchCategory(location, category, options)).places;
  }

  /** Places of one category plus which sources did not answer (partial). */
  async searchCategory(location: LatLon, category: FetchCategory, options: SearchOptions = {}): Promise<CategoryResult> {
    const radiusM = options.radiusM ?? null;
    const strict = radiusM != null;
    const key = `${category}:${options.includeKyivOfficialData ? "kyiv" : "osm"}:${radiusM ?? "auto"}`;
    const cached = categoryCache.get(key);
    if (!options.force && cached && Date.now() - cached.at < 90_000 && distanceM(location, cached.location) < (strict ? 50 : 500)) return { places: cached.places, unavailable: [], usedOffline: false };

    // Official city layers run in parallel with OpenStreetMap; when they
    // already cover the area, a slow OSM mirror is not waited for.
    const wantsOfficial = !!options.includeKyivOfficialData && (category === "shelter" || category === "resilience");
    const layer = category === "shelter" ? 0 : 1;
    const officialTask: Promise<NearbyPlace[] | null> = !wantsOfficial ? Promise.resolve([])
      : strict ? this.queryKyivLayer(location, layer, category as "shelter" | "resilience", radiusM)
        // Nothing in the city layer close by (e.g. a suburb inside the Kyiv
        // box): look wider, a city point 8 km away still beats none.
        : this.queryKyivLayer(location, layer, category as "shelter" | "resilience", SEARCH_RADIUS_M)
          .then((near) => (near && near.length === 0 ? this.queryKyivLayer(location, layer, category as "shelter" | "resilience", 15_000) : near));
    const osmTask = strict ? this.osmCategoryWithin(location, category, radiusM) : this.osmCategory(location, category);
    // Community open data (shelters in Kyiv oblast), shipped with the app.
    const bundled = category === "shelter" ? bundledShelters(location, strict ? radiusM : 15_000) : [];
    const officialOrNull = await officialTask;
    // Official / community data already has a place close by: give the (often
    // overloaded) public OpenStreetMap servers a short grace. Otherwise — the
    // only known one is far (the oblast dataset had a shelter 10 km away while
    // OpenStreetMap knew one 300 m away) — wait for OpenStreetMap properly.
    const nearestKnownM = [...(officialOrNull ?? []), ...bundled].reduce((m, p) => Math.min(m, p.distanceM), Infinity);
    const graceMs = nearestKnownM <= (radiusM != null ? Math.min(radiusM, CLOSE_ENOUGH_M) : CLOSE_ENOUGH_M) ? (strict ? 2_500 : 1_500) : OSM_PATIENCE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const osmResult: { osm: NearbyPlace[]; error: unknown } | null = await Promise.race([osmTask, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), graceMs); })]);
    if (timer) clearTimeout(timer);
    const officialFailed = wantsOfficial && officialOrNull == null;
    const osmFailed = !osmResult || !!osmResult.error;
    let official = officialOrNull ?? [];
    let osm = osmResult?.osm ?? [];
    const unavailable: string[] = [...(officialFailed ? ["КМДА"] : []), ...(osmFailed ? ["OpenStreetMap"] : [])];
    // A source that did not answer is filled from the offline package, if any.
    const offlineRadius = strict ? radiusM : 15_000;
    if (officialFailed) official = await offlinePlacesWithin(category, location, offlineRadius, "Kyiv City open data");
    if (osmFailed) osm = await offlinePlacesWithin(category, location, offlineRadius, "OpenStreetMap");
    const usedOffline = official.some((p) => p.origin === "offline") || osm.some((p) => p.origin === "offline");
    if (osmResult?.error && osm.length === 0 && official.length === 0 && bundled.length === 0) {
      const saved = await loadSaved(category, location);
      if (saved) return { places: strict ? searchByRadius(saved, location, radiusM) : saved, unavailable, usedOffline: true };
      throw osmResult.error;
    }
    const byId = new Map<string, NearbyPlace>();
    for (const place of [...official, ...bundled, ...osm]) byId.set(place.id, place);
    const merged = [...byId.values()];
    // One nearest-first search for every category (shelters, resilience
    // points, …): strict = exactly the chosen circle; auto = the nearest 40.
    const places = nearestFirst(merged, location, strict ? { radiusM } : { limit: 40 });
    if (unavailable.length === 0) categoryCache.set(key, { location, at: Date.now(), places });
    if (!strict && !usedOffline) void save(category, location, places);
    return { places, unavailable, usedOffline };
  }

  /** OpenStreetMap inside exactly `radiusM`: map tiles when they cover the
   * circle, otherwise one Overpass query with that radius. */
  private async osmCategoryWithin(location: LatLon, category: FetchCategory, radiusM: number): Promise<{ osm: NearbyPlace[]; error: unknown }> {
    if (TILE_CATEGORIES.has(category) && tileCountForRadius(location, radiusM) <= MAX_RADIUS_TILES) {
      try {
        const found = await tilePoisNear(location, category, radiusM);
        return { osm: found.map((p) => ({ id: `tile-${p.id}`, name: p.name ?? placeName({}, category), category, location: p.location, distanceM: p.distanceM, source: "OpenStreetMap" as const, origin: "online" as const })), error: null };
      } catch { /* fall back to Overpass */ }
    }
    try {
      return { osm: await this.queryCategory(location, category, Math.round(radiusM), true), error: null };
    } catch (error) {
      return { osm: [], error };
    }
  }

  /** OpenStreetMap side of a category search: map tiles, Overpass passes, Nominatim. */
  private async osmCategory(location: LatLon, category: FetchCategory): Promise<{ osm: NearbyPlace[]; error: unknown }> {
    let osm: NearbyPlace[] = [];
    let error: unknown = null;
    // Everyday categories: the map's own tiles first (fast CDN, no Overpass).
    // Close first (3×3 tiles), wider only when the neighbourhood is sparse.
    if (TILE_CATEGORIES.has(category)) {
      for (const radius of [1500, 3500]) {
        try {
          const found = await tilePoisNear(location, category, radius);
          osm = found.map((p) => ({ id: `tile-${p.id}`, name: p.name ?? placeName({}, category), category, location: p.location, distanceM: p.distanceM, source: "OpenStreetMap" as const, origin: "online" as const }));
        } catch { break; /* fall through to Overpass */ }
        if (osm.length >= 3) break;
      }
    }
    for (const radius of osm.length >= 3 ? [] : CATEGORY_RADII[category]) {
      try {
        const found = await this.queryCategory(location, category, radius);
        if (found.length >= osm.length) osm = found;
        error = null;
      } catch (e) {
        error = e;
        break;
      }
      // Enough to choose from, or already one close by: no wider pass.
      if (osm.length >= 3 || osm.some((p) => p.distanceM <= CLOSE_ENOUGH_M)) break;
    }
    // Nominatim fallback only where it has a matching category; an empty
    // answer does not clear the failure (the list may simply be incomplete).
    if (error && osm.length === 0 && NOMINATIM_PHRASE[category]) {
      try { osm = await this.nominatimCategory(location, category); } catch { /* keep the Overpass error */ }
    }
    return { osm, error: osm.length > 0 ? null : error };
  }

  private async queryCategory(location: LatLon, category: FetchCategory, radius: number, unlimited = false): Promise<NearbyPlace[]> {
    const around = `(around:${radius},${location.lat},${location.lon})`;
    const selectors = CATEGORY_QUERY[category].map((q) => `nwr${around}${q};`).join("");
    // Strict radius: every element in the circle (no output cap).
    const query = `[out:json][timeout:25];(${selectors});out center tags${unlimited ? "" : " 400"};`;
    return parseOverpass(await overpass(query), location).filter((p) => p.category === category);
  }

  /** Fallback source (Nominatim special phrases) for everyday categories. */
  private async nominatimCategory(location: LatLon, category: FetchCategory): Promise<NearbyPlace[]> {
    const phrase = NOMINATIM_PHRASE[category];
    if (!phrase) return [];
    const d = 0.12; // ~13 km box
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&addressdetails=1&accept-language=uk&q=${encodeURIComponent(phrase)}&viewbox=${location.lon - d},${location.lat + d},${location.lon + d},${location.lat - d}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "NAVIA/0.1 (navigation app)" }, signal: controller.signal });
      if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
      const rows = await response.json() as { osm_type?: string; osm_id?: number; lat?: string; lon?: string; name?: string; address?: Record<string, string> }[];
      return rows.flatMap((row) => {
        const lat = Number(row.lat), lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        const address = [row.address?.road, row.address?.house_number].filter(Boolean).join(" ");
        return [{
          id: `osm-${row.osm_type ?? "x"}-${row.osm_id ?? `${lat},${lon}`}`,
          name: row.name || placeName({}, category),
          category,
          location: { lat, lon },
          ...(address ? { address } : {}),
          distanceM: distanceM(location, { lat, lon }),
          source: "OpenStreetMap" as const,
          origin: "online" as const,
        }];
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** null = the service did not answer (vs [] = answered, nothing nearby). */
  private async queryKyivLayer(location: LatLon, layer: number, type: "shelter" | "resilience", radiusM = SEARCH_RADIUS_M): Promise<NearbyPlace[] | null> {
    const url = new URL(`${KYIV_GIS_BASE}/${layer}/query`);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("f", "json");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("geometry", `${location.lon},${location.lat}`);
    url.searchParams.set("geometryType", "esriGeometryPoint");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("distance", String(Math.round(radiusM)));
    url.searchParams.set("units", "esriSRUnit_Meter");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KYIV_GIS_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) return null;
      const data = await response.json() as ArcGISResponse;
      if (data.error) return null;
      return parseKyivFeatures(data.features, type, location);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
