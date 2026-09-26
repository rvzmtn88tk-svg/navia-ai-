// Points of interest drawn by the base map itself (OpenMapTiles "poi" layer
// of the vector tiles: shops, pharmacies, fuel, hospitals, schools, …). A tap
// on one turns the rendered feature into a place for the shared place card:
// its own name (or an honest "name unknown"), what it is, and the distance
// from the user. Nothing is invented: OpenMapTiles POIs carry no address.
// Pure; unit-tested.
import { haversineMeters, type LatLon } from "@navia/core";
import type { NearbyPlace, NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";

type Kind = { label: string; category: NearbyPlaceCategory };

// OSM value (OpenMapTiles `subclass`, or `class`) → words and NAVIA category.
const KINDS: Record<string, Kind> = {
  fuel: { label: "АЗС", category: "fuel" },
  charging_station: { label: "Зарядна станція", category: "charger" },
  pharmacy: { label: "Аптека", category: "pharmacy" },
  chemist: { label: "Аптека, побутова хімія", category: "pharmacy" },
  hospital: { label: "Лікарня", category: "hospital" },
  clinic: { label: "Поліклініка", category: "hospital" },
  doctors: { label: "Лікар", category: "hospital" },
  dentist: { label: "Стоматологія", category: "hospital" },
  supermarket: { label: "Супермаркет", category: "shop" },
  convenience: { label: "Продуктовий магазин", category: "shop" },
  grocery: { label: "Продуктовий магазин", category: "shop" },
  mall: { label: "Торговий центр", category: "shop" },
  department_store: { label: "Універмаг", category: "shop" },
  marketplace: { label: "Ринок", category: "shop" },
  bakery: { label: "Пекарня", category: "shop" },
  butcher: { label: "М'ясна крамниця", category: "shop" },
  alcohol: { label: "Алкогольний магазин", category: "shop" },
  alcohol_shop: { label: "Алкогольний магазин", category: "shop" },
  clothes: { label: "Одяг", category: "shop" },
  clothing_store: { label: "Одяг", category: "shop" },
  hardware: { label: "Господарчий магазин", category: "shop" },
  shop: { label: "Магазин", category: "shop" },
  bank: { label: "Банк", category: "atm" },
  atm: { label: "Банкомат", category: "atm" },
  restaurant: { label: "Ресторан", category: "food" },
  cafe: { label: "Кафе", category: "food" },
  fast_food: { label: "Фастфуд", category: "food" },
  bar: { label: "Бар", category: "food" },
  pub: { label: "Паб", category: "food" },
  ice_cream: { label: "Морозиво", category: "food" },
  drinking_water: { label: "Питна вода", category: "water" },
  police: { label: "Поліція", category: "police" },
  fire_station: { label: "Пожежна частина", category: "fire" },
  parking: { label: "Паркування", category: "parking" },
  toilets: { label: "Вбиральня", category: "toilets" },
  school: { label: "Школа", category: "other" },
  kindergarten: { label: "Дитячий садок", category: "other" },
  college: { label: "Коледж", category: "other" },
  university: { label: "Університет", category: "other" },
  library: { label: "Бібліотека", category: "other" },
  post: { label: "Пошта", category: "other" },
  post_office: { label: "Пошта", category: "other" },
  place_of_worship: { label: "Храм", category: "other" },
  townhall: { label: "Адміністрація", category: "other" },
  town_hall: { label: "Адміністрація", category: "other" },
  bus: { label: "Зупинка", category: "transport" },
  bus_stop: { label: "Зупинка", category: "transport" },
  railway: { label: "Залізниця", category: "transport" },
  station: { label: "Станція", category: "transport" },
  subway: { label: "Метро", category: "transport" },
  hotel: { label: "Готель", category: "other" },
  lodging: { label: "Житло для подорожніх", category: "other" },
  museum: { label: "Музей", category: "other" },
  theatre: { label: "Театр", category: "other" },
  cinema: { label: "Кінотеатр", category: "other" },
  park: { label: "Парк", category: "other" },
  playground: { label: "Дитячий майданчик", category: "other" },
  sports_centre: { label: "Спортивний центр", category: "other" },
  stadium: { label: "Стадіон", category: "other" },
  attraction: { label: "Пам'ятка", category: "other" },
};

export type BasemapPoi = NearbyPlace & { kindLabel: string; nameKnown: boolean };

function readable(value: string): string {
  return value.replace(/_/g, " ");
}

/** A rendered base-map POI → a place for the card. `null` when the feature is
 * not a point or has no class at all. */
export function poiFromFeature(feature: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> | null; id?: string | number }, here: LatLon | null): BasemapPoi | null {
  const g = feature.geometry;
  if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [lon, lat] = g.coordinates as number[];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = feature.properties ?? {};
  const subclass = typeof p.subclass === "string" ? p.subclass : "";
  const klass = typeof p.class === "string" ? p.class : "";
  if (!subclass && !klass) return null;
  const kind = KINDS[subclass] ?? KINDS[klass] ?? { label: readable(subclass || klass), category: "other" as const };
  const name = [p["name:uk"], p.name, p["name:latin"], p.name_int].find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;
  const location = { lat: lat!, lon: lon! };
  return {
    id: `basemap-${String(feature.id ?? `${lat!.toFixed(6)},${lon!.toFixed(6)}`)}-${subclass || klass}`,
    name: name ?? `${kind.label} (назва невідома)`,
    nameKnown: !!name,
    kindLabel: kind.label,
    category: kind.category,
    location,
    distanceM: here ? haversineMeters(here, location) : NaN,
    source: "OpenStreetMap",
    origin: "online",
    sourceDetail: "OpenStreetMap · шар карти",
  };
}

/** The feature nearest to the tap wins (several may lie under a finger). */
export function pickPoi(features: Parameters<typeof poiFromFeature>[0][], tap: LatLon, here: LatLon | null): BasemapPoi | null {
  let best: { poi: BasemapPoi; d: number } | null = null;
  for (const f of features) {
    const poi = poiFromFeature(f, here);
    if (!poi) continue;
    const d = haversineMeters(tap, poi.location);
    if (!best || d < best.d) best = { poi, d };
  }
  return best?.poi ?? null;
}
