import type { LatLon } from "@navia/core";

export type GeolocatedAirAlert = {
  active: boolean | null;
  locationLabel: string;
  region: string;
  district?: string;
  since?: number;
  /** Time NAVIA successfully checked the live status endpoint. */
  updatedAt?: number;
  /** Last time the source's alert set changed; this is not a freshness clock. */
  sourceUpdatedAt?: number;
  source: string;
  sourceUrl: string;
  detail?: string;
  /** Where the alert applies: your district (raion/city) or the whole oblast. */
  scope?: "district" | "city" | "region";
  /** Threat level reported by the source (e.g. "yellow", "red"). */
  level?: string;
  /** Source-provided reasons, e.g. "Дронова загроза (жовтий рівень)". */
  reasons?: string[];
  /** Other districts of your oblast under alert (when yours is not). */
  otherDistrictsActive?: number;
};

type GeoPosition = [number, number];
type GeoGeometry =
  | { type: "Polygon"; coordinates: GeoPosition[][] }
  | { type: "MultiPolygon"; coordinates: GeoPosition[][][] };
type AdminFeature = {
  type?: "Feature";
  properties?: { key?: string; region?: string; name?: string; rayon?: string };
  geometry?: GeoGeometry;
};
type FeatureCollection = { type?: "FeatureCollection"; features?: AdminFeature[] };
type AdminBoundaries = { oblasts: FeatureCollection; raions: FeatureCollection };
type AdminArea = { region: string; regionKey: string; district?: string; districtKey?: string; isKyivCity: boolean };
type ReverseGeocodeResponse = {
  address?: {
    country_code?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
    region?: string;
  };
};
type RegionalAlertsResponse = {
  updatedAt?: string;
  raions?: { key?: string; name?: string; oblast?: string; since?: string; level?: string; reasons?: string[] }[];
  oblasts?: { key?: string; name?: string; oblast?: string; since?: string; level?: string; reasons?: string[] }[];
};
type KyivCityResponse = { current?: { state?: number | string; created_at?: string } };

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const OBLAST_BOUNDARIES_URL = "https://neptun.in.ua/oblasts.geojson";
const RAION_BOUNDARIES_URL = "https://neptun.in.ua/raions.geojson";
const REGIONAL_ALERTS_URL = "https://neptun.in.ua/api/v1/alerts";
const KYIV_CITY_ALERTS_URL = "https://data.kyivcity.gov.ua/dataset/statystyka-povitrianykh-tryvoh-u-misti-kyievi-dep-municipal/resource/e1216fe6-7cbd-41ad-b478-85983a2e2669/data/download";
const KYIV_ALERT_SOURCE = "https://kyiv.digital/open-api/docs/air-alert.html";
const NEPTUN_SOURCE = "https://neptun.in.ua/";
const REQUEST_TIMEOUT_MS = 12_000;
const BOUNDARY_CACHE_MS = 12 * 60 * 60_000;

let alertsCache: { expiresAt: number; data: RegionalAlertsResponse } | null = null;
let reverseCache: { at: number; location: LatLon; data: ReverseGeocodeResponse } | null = null;
let boundariesCache: { expiresAt: number; data: AdminBoundaries } | null = null;

function normalize(value: string): string {
  return value.toLocaleLowerCase("uk-UA").replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();
}

function sameAdministrativeUnit(value: string | undefined, candidate: string | undefined): boolean {
  if (!value || !candidate) return false;
  const a = normalize(value).replace(/ район$/, "");
  const b = normalize(candidate).replace(/ район$/, "");
  return a === b;
}

function pointInRing(ring: GeoPosition[], point: LatLon): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const first = ring[i];
    const second = ring[j];
    if (!first || !second) continue;
    const [lonA, latA] = first;
    const [lonB, latB] = second;
    const crosses = (latA > point.lat) !== (latB > point.lat)
      && point.lon < ((lonB - lonA) * (point.lat - latA)) / (latB - latA) + lonA;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(rings: GeoPosition[][], point: LatLon): boolean {
  const outer = rings[0];
  return !!outer
    && pointInRing(outer, point)
    && !rings.slice(1).some((hole) => pointInRing(hole, point));
}

function pointInGeometry(geometry: GeoGeometry | undefined, point: LatLon): boolean {
  if (!geometry) return false;
  return geometry.type === "Polygon"
    ? pointInPolygon(geometry.coordinates, point)
    : geometry.coordinates.some((polygon) => pointInPolygon(polygon, point));
}

async function fetchJson<T>(url: string): Promise<{ data: T; responseDate: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json, application/geo+json", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Джерело відповіло HTTP ${response.status}.`);
    return { data: await response.json() as T, responseDate: response.headers.get("date") };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBoundaries(): Promise<AdminBoundaries> {
  if (boundariesCache && boundariesCache.expiresAt > Date.now()) return boundariesCache.data;
  const [oblasts, raions] = await Promise.all([
    fetchJson<FeatureCollection>(OBLAST_BOUNDARIES_URL),
    fetchJson<FeatureCollection>(RAION_BOUNDARIES_URL),
  ]);
  if (!oblasts.data.features?.length || !raions.data.features?.length) throw new Error("Не вдалося завантажити межі областей і районів.");
  const data = { oblasts: oblasts.data, raions: raions.data };
  boundariesCache = { data, expiresAt: Date.now() + BOUNDARY_CACHE_MS };
  return data;
}

function findArea(boundaries: AdminBoundaries, point: LatLon): AdminArea | null {
  const oblasts = boundaries.oblasts.features ?? [];
  // Kyiv city is a separate administrative area. Check it first so an
  // adjacent oblast polygon with a shared boundary cannot override the city.
  const kyiv = oblasts.find((feature) => normalize(feature.properties?.key ?? "") === "м. київ");
  if (kyiv && pointInGeometry(kyiv.geometry, point)) {
    return { region: "м. Київ", regionKey: "м. київ", isKyivCity: true };
  }
  const oblast = oblasts.find((feature) => feature.properties?.key && pointInGeometry(feature.geometry, point));
  const region = oblast?.properties?.region;
  const regionKey = oblast?.properties?.key;
  if (!region || !regionKey) return null;
  const raion = (boundaries.raions.features ?? []).find((feature) => feature.properties?.key && pointInGeometry(feature.geometry, point));
  return {
    region,
    regionKey,
    ...(raion?.properties?.rayon ? { district: raion.properties.rayon } : {}),
    ...(raion?.properties?.key ? { districtKey: raion.properties.key } : {}),
    isKyivCity: false,
  };
}

function parseKyivCity(raw: string): KyivCityResponse {
  try {
    return JSON.parse(raw) as KyivCityResponse;
  } catch {
    const state = raw.match(/<state>\s*(\d+)\s*<\/state>/i)?.[1];
    const createdAt = raw.match(/<created_at>\s*([^<]+)\s*<\/created_at>/i)?.[1]?.trim();
    if (state == null) throw new Error("У відповіді міського сервісу не знайдено статус.");
    return { current: { state, ...(createdAt ? { created_at: createdAt } : {}) } };
  }
}

function kyivTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const time = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}+03:00`);
  return Number.isFinite(time) ? time : undefined;
}

async function fetchKyivCityAlert(): Promise<GeolocatedAirAlert> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(KYIV_CITY_ALERTS_URL, { headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Джерело «Київ Цифровий» повернуло HTTP ${response.status}.`);
    const data = parseKyivCity(await response.text());
    const state = Number(data.current?.state);
    if (state !== 0 && state !== 1) throw new Error("У відповіді «Київ Цифровий» немає актуального статусу.");
    return {
      active: state === 1,
      locationLabel: "м. Київ",
      region: "м. Київ",
      ...(kyivTimestamp(data.current?.created_at) ? { since: kyivTimestamp(data.current?.created_at) } : {}),
      updatedAt: Date.now(),
      source: "Kyiv Digital",
      sourceUrl: KYIV_ALERT_SOURCE,
      ...(state === 1 ? { scope: "city" as const } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRegionalAlerts(): Promise<{ data: RegionalAlertsResponse; checkedAt: number; sourceChangedAt?: number }> {
  if (alertsCache && alertsCache.expiresAt > Date.now()) {
    return { data: alertsCache.data, checkedAt: Date.now(), ...(Date.parse(alertsCache.data.updatedAt ?? "") ? { sourceChangedAt: Date.parse(alertsCache.data.updatedAt!) } : {}) };
  }
  const { data, responseDate } = await fetchJson<RegionalAlertsResponse>(REGIONAL_ALERTS_URL);
  if (!Array.isArray(data.raions) || !Array.isArray(data.oblasts)) throw new Error("Сервіс тривог повернув неочікувані дані.");
  const checkedAt = Date.parse(responseDate ?? "") || Date.now();
  // `updatedAt`/`version` change when the source's alert set changes; they do
  // not mean the no-alert snapshot itself is stale. Track request time instead.
  alertsCache = { data, expiresAt: Date.now() + 30_000 };
  const sourceChangedAt = Date.parse(data.updatedAt ?? "");
  return { data, checkedAt, ...(Number.isFinite(sourceChangedAt) ? { sourceChangedAt } : {}) };
}

/** Resolves the GPS point into city/raion polygons, then checks the live feed.
 * Region boundaries remove the unreliable free-form reverse-geocoder matching
 * that previously left most location checks stuck in an "unknown" state.
 */
export class GeolocatedAirAlertProvider {
  async fetchAt(location: LatLon): Promise<GeolocatedAirAlert> {
    let area: AdminArea | null = null;
    let boundariesAvailable = false;
    try {
      area = findArea(await fetchBoundaries(), location);
      boundariesAvailable = true;
    } catch {
      // Continue with the reverse-geocoder fallback if map boundaries cannot load.
    }

    if (area?.isKyivCity) return fetchKyivCityAlert();

    let locationLabel: string;
    let region: string;
    let district = area?.district;
    let districtKey = area?.districtKey;
    let regionKey = area?.regionKey;

    if (area) {
      locationLabel = [district, area.region].filter(Boolean).join(" · ");
      region = area.region;
    } else {
      const address = await this.reverse(location);
      if (address.address?.country_code && address.address.country_code.toLowerCase() !== "ua") {
        return {
          active: null,
          locationLabel: address.address.city ?? address.address.town ?? address.address.village ?? "Поза Україною",
          region: address.address.state ?? address.address.region ?? "",
          updatedAt: Date.now(),
          source: "NEPTUN",
          sourceUrl: NEPTUN_SOURCE,
          detail: "Статус для цього місця джерело не підтверджує.",
        };
      }
      const city = address.address?.city ?? address.address?.town ?? address.address?.village ?? address.address?.municipality ?? "";
      region = address.address?.state ?? address.address?.region ?? "";
      district = address.address?.county;
      if (normalize(city) === "київ" && !normalize(region).includes("область")) return fetchKyivCityAlert();
      if (!region) throw new Error("Не вдалося визначити область за GPS-координатами.");
      locationLabel = [district, city, region].find(Boolean) ?? region;
    }

    const { data, checkedAt, sourceChangedAt } = await fetchRegionalAlerts();
    const matchingRaion = districtKey
      ? data.raions?.find((entry) => entry.key === districtKey)
      : district
        ? data.raions?.find((entry) => sameAdministrativeUnit(entry.name, district) && sameAdministrativeUnit(entry.oblast, region))
        : undefined;
    const matchingOblast = regionKey
      ? data.oblasts?.find((entry) => entry.key === regionKey)
      : data.oblasts?.find((entry) => sameAdministrativeUnit(entry.name, region) || sameAdministrativeUnit(entry.oblast, region));
    const canConfirmAbsence = boundariesAvailable ? Boolean(districtKey) : Boolean(district);
    const active = matchingRaion || matchingOblast ? true : canConfirmAbsence ? false : null;
    const match = matchingRaion ?? matchingOblast;
    const otherDistrictsActive = !match ? (data.raions ?? []).filter((entry) => sameAdministrativeUnit(entry.oblast, region)).length : 0;

    return {
      active,
      locationLabel,
      region,
      ...(district ? { district } : {}),
      ...(matchingRaion?.since ? { since: Date.parse(matchingRaion.since) } : matchingOblast?.since ? { since: Date.parse(matchingOblast.since) } : {}),
      updatedAt: checkedAt,
      ...(sourceChangedAt ? { sourceUpdatedAt: sourceChangedAt } : {}),
      source: "NEPTUN",
      sourceUrl: NEPTUN_SOURCE,
      ...(!canConfirmAbsence && !matchingRaion && !matchingOblast ? { detail: "Район за GPS не визначився — відсутність тривоги тут підтвердити не можна." } : {}),
      ...(matchingRaion ? { scope: "district" as const } : matchingOblast ? { scope: "region" as const } : {}),
      ...(match?.level ? { level: match.level } : {}),
      ...(match?.reasons?.length ? { reasons: match.reasons.slice(0, 4) } : {}),
      ...(otherDistrictsActive > 0 ? { otherDistrictsActive } : {}),
    };
  }

  private async reverse(location: LatLon): Promise<ReverseGeocodeResponse> {
    if (reverseCache && Date.now() - reverseCache.at < 10 * 60_000 && Math.abs(location.lat - reverseCache.location.lat) < 0.003 && Math.abs(location.lon - reverseCache.location.lon) < 0.003) {
      return reverseCache.data;
    }
    const url = new URL(REVERSE_URL);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(location.lat));
    url.searchParams.set("lon", String(location.lon));
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "uk");
    const { data } = await fetchJson<ReverseGeocodeResponse>(url.toString());
    if (!data.address) throw new Error("Джерело адрес не повернуло адміністративний район.");
    reverseCache = { at: Date.now(), location, data };
    return data;
  }
}
