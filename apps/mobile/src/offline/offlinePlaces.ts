// Places kept on the phone for search without network (part of the
// "Київ + область" offline package): every shelter and heating
// (resilience) point from Kyiv's official GIS, and OpenStreetMap places of
// every search category for the whole Kyiv oblast. Queried with the same
// strict radius rule as online search; every result is marked "offline".
import { searchByRadius, type LatLon } from "@navia/core";
import {
  CATEGORY_QUERY, KYIV_GIS_BASE, parseKyivFeatures, parseOverpass,
  type ArcGISResponse, type FetchCategory, type NearbyPlace,
} from "../providers/NearbyPlacesProvider";
import { overpass } from "../providers/overpass";

export type Bbox = { south: number; west: number; north: number; east: number };

/** Compact on-disk record. */
type Stored = { i: string; n: string; c: string; la: number; lo: number; a?: string; h?: string; s: "k" | "o" };
type Meta = { downloadedAt: string; counts: Record<string, number>; failed: string[]; bytes: number };

type KV = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; removeItemAsync?(key: string): Promise<void> };
let kv: KV | null | undefined;
function storage(): KV | null {
  if (kv !== undefined) return kv;
  try { kv = (require("expo-sqlite/kv-store") as { default: KV }).default; } catch { kv = null; }
  return kv;
}
export function setOfflinePlacesStorageForTests(store: KV | null): void {
  kv = store;
  memory.clear();
  metaCache = undefined;
}

const KEY = (c: string) => `navia.offline.places.${c}.v1`;
const META_KEY = "navia.offline.places.meta.v1";
export const OFFLINE_CATEGORIES: FetchCategory[] = ["shelter", "resilience", "fuel", "charger", "pharmacy", "hospital", "atm", "shop", "water", "food"];

const memory = new Map<string, Stored[]>();
let metaCache: Meta | null | undefined;

function toStored(p: NearbyPlace): Stored {
  return {
    i: p.id, n: p.name, c: p.category, la: Math.round(p.location.lat * 1e6) / 1e6, lo: Math.round(p.location.lon * 1e6) / 1e6,
    ...(p.address ? { a: p.address } : {}), ...(p.openingHours ? { h: p.openingHours } : {}),
    s: p.source === "Kyiv City open data" ? "k" : "o",
  };
}

async function load(category: FetchCategory): Promise<Stored[]> {
  const hit = memory.get(category);
  if (hit) return hit;
  const raw = await storage()?.getItemAsync(KEY(category)).catch(() => null);
  const list = raw ? (JSON.parse(raw) as Stored[]) : [];
  memory.set(category, list);
  return list;
}

export async function offlinePlacesMeta(): Promise<Meta | null> {
  if (metaCache !== undefined) return metaCache;
  const raw = await storage()?.getItemAsync(META_KEY).catch(() => null);
  metaCache = raw ? (JSON.parse(raw) as Meta) : null;
  return metaCache;
}

/** Offline places of one category strictly within `radiusM`. `only`: one source. */
export async function offlinePlacesWithin(category: FetchCategory, center: LatLon, radiusM: number, only?: "Kyiv City open data" | "OpenStreetMap"): Promise<NearbyPlace[]> {
  const meta = await offlinePlacesMeta();
  if (!meta) return [];
  const list = await load(category);
  const places: Omit<NearbyPlace, "distanceM">[] = list
    .filter((r) => !only || (only === "Kyiv City open data") === (r.s === "k"))
    .map((r) => ({
      id: r.i, name: r.n, category: r.c as NearbyPlace["category"], location: { lat: r.la, lon: r.lo },
      ...(r.a ? { address: r.a } : {}), ...(r.h ? { openingHours: r.h } : {}),
      source: r.s === "k" ? "Kyiv City open data" as const : "OpenStreetMap" as const,
      origin: "offline" as const,
      sourceDetail: `${r.s === "k" ? "КМДА" : "OpenStreetMap"} · офлайн-знімок від ${meta.downloadedAt}`,
    }));
  return searchByRadius(places, center, radiusM);
}

export type PlacesProgress = { done: number; total: number; category: string; failed: string[] };

export type DownloadPlacesOptions = {
  overpassImpl?: typeof overpass;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Per Overpass mirror, per category. */
  perEndpointTimeoutMs?: number;
  kyivTimeoutMs?: number;
  /** Places to keep for a category whose OpenStreetMap download failed (e.g. read from the map tiles). */
  fallback?: Partial<Record<FetchCategory, NearbyPlace[]>>;
  /** How the fallback is described in the list of gaps. */
  fallbackLabel?: string;
};

/** Downloads the offline places for `bbox` (Kyiv official data + OSM per
 * category). OpenStreetMap is optional: when it does not answer (the public
 * Overpass servers are often overloaded — one category then fails only after
 * ~80 s), the remaining OSM categories are skipped instead of waiting ~14 min;
 * the map and the official data are still saved and the gap is reported. */
export async function downloadOfflinePlaces(bbox: Bbox, onProgress: (p: PlacesProgress) => void, options: DownloadPlacesOptions = {}): Promise<Meta> {
  const store = storage();
  if (!store) throw new Error("offline places: no storage");
  const ask = options.overpassImpl ?? overpass;
  const doFetch = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const center = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  let bytes = 0;
  const total = OFFLINE_CATEGORIES.length;
  let done = 0;

  // Kyiv official layers, complete (the server allows 10 000 records per call).
  const kyiv: Partial<Record<"shelter" | "resilience", NearbyPlace[]>> = {};
  for (const [layer, cat] of [[0, "shelter"], [1, "resilience"]] as const) {
    onProgress({ done, total, category: cat, failed });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.kyivTimeoutMs ?? 30_000);
    try {
      const url = `${KYIV_GIS_BASE}/${layer}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json`;
      const res = await doFetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      const data = await res.json() as ArcGISResponse;
      if (!res.ok || data.error) throw new Error("kyiv gis");
      kyiv[cat] = parseKyivFeatures(data.features, cat, center);
    } catch {
      failed.push(`КМДА: ${cat === "shelter" ? "укриття" : "пункти обігріву"}`);
    } finally {
      clearTimeout(timer);
    }
  }

  let osmDown = false;
  for (const category of OFFLINE_CATEGORIES) {
    onProgress({ done, total, category, failed });
    let osm: NearbyPlace[] = [];
    if (osmDown) {
      failed.push(`OpenStreetMap: ${category}`);
    } else {
      try {
        const selectors = CATEGORY_QUERY[category].map((q) => `nwr${q};`).join("");
        const query = `[out:json][timeout:120][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];(${selectors});out center tags;`;
        osm = parseOverpass(await ask(query, { perEndpointTimeoutMs: options.perEndpointTimeoutMs ?? 60_000 }), center).filter((p) => p.category === category);
      } catch {
        failed.push(`OpenStreetMap: ${category}`);
        // Every mirror failed for this category: the servers are down or
        // overloaded right now — do not wait the same way nine more times.
        osmDown = true;
      }
    }
    const official = category === "shelter" || category === "resilience" ? kyiv[category] ?? [] : [];
    // Overpass did not answer: the map's own places, where there are some.
    const substitute = osm.length === 0 && failed[failed.length - 1] === `OpenStreetMap: ${category}` ? options.fallback?.[category] ?? [] : [];
    if (substitute.length > 0) failed[failed.length - 1] = `OpenStreetMap: ${category} (${options.fallbackLabel ?? "замінено"})`;
    const list = [...official, ...osm, ...substitute].map(toStored);
    // Keep the previous copy when this category failed completely — and
    // count what is really on the phone, not zero.
    const previous = list.length > 0 ? null : await store.getItemAsync(KEY(category)).catch(() => null);
    if (previous) {
      bytes += previous.length;
      counts[category] = (JSON.parse(previous) as unknown[]).length;
    } else {
      const json = JSON.stringify(list);
      bytes += json.length;
      await store.setItemAsync(KEY(category), json);
      memory.set(category, list);
      counts[category] = list.length;
    }
    done += 1;
    onProgress({ done, total, category, failed });
  }
  const meta: Meta = { downloadedAt: new Date().toISOString().slice(0, 10), counts, failed, bytes };
  await store.setItemAsync(META_KEY, JSON.stringify(meta));
  metaCache = meta;
  return meta;
}

export async function removeOfflinePlaces(): Promise<void> {
  const store = storage();
  for (const c of OFFLINE_CATEGORIES) { memory.delete(c); await store?.removeItemAsync?.(KEY(c)).catch(() => {}); }
  await store?.removeItemAsync?.(META_KEY).catch(() => {});
  metaCache = null;
}
