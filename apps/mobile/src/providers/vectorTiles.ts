// Places and landmarks read straight from the map's own vector tiles
// (OpenFreeMap / OpenMapTiles schema, zoom 14). A CDN-served, keyless source
// that stays fast when the public Overpass servers are overloaded; the same
// tiles also back the map. Also finds railway crossings and river bridges by
// intersecting the route with rail lines and waterways.
import { VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { junctionsFromRoads, type LatLon, type MapFeature } from "@navia/core";
import { INVISIBLE_NAME, type LandmarkKind, type RawLandmark } from "../navigation/landmarks";
import type { FetchCategory } from "./NearbyPlacesProvider";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const Z = 14;

export type TilePoi = { id: string; cls: string; sub: string; name: string | null; location: LatLon };
type TileLine = { cls: string; name: string | null; points: LatLon[] };
type DecodedTile = { pois: TilePoi[]; rails: TileLine[]; waterways: TileLine[]; junctions: LatLon[] };

let templatePromise: Promise<string> | null = null;
const tiles = new Map<string, Promise<DecodedTile>>();
const MAX_TILES = 260;
/** Largest circle served from tiles (z14 tiles are ~1.5 km at Kyiv's latitude). */
export const MAX_RADIUS_TILES = 200;

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
let doFetch: FetchLike = (url) => fetch(url);
/** The fetch used for tiles (tests replace it). */
export function tileFetch(url: string) {
  return doFetch(url);
}
/** For tests. */
export function setTileFetchForTests(f: FetchLike | null): void {
  doFetch = f ?? ((url) => fetch(url));
  templatePromise = null;
  tiles.clear();
}

/** The live tile URL template (versioned) from OpenFreeMap's TileJSON. */
export async function tileTemplate(): Promise<string> {
  return template();
}

async function template(): Promise<string> {
  templatePromise ??= (async () => {
    const response = await doFetch(TILEJSON);
    if (!response.ok) throw new Error(`TileJSON HTTP ${response.status}`);
    const json = await response.json() as { tiles?: string[] };
    const t = json.tiles?.[0];
    if (!t) throw new Error("TileJSON: no tiles");
    return t;
  })().catch((e) => { templatePromise = null; throw e; });
  return templatePromise;
}

export function tileOf(p: LatLon, z = Z): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-85, Math.min(85, p.lat)) * Math.PI / 180;
  return {
    x: Math.floor((p.lon + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n),
  };
}

export function toLatLon(x: number, y: number, tx: number, ty: number, extent: number, z = Z): LatLon {
  const n = 2 ** z;
  const lon = (tx + x / extent) / n * 360 - 180;
  const merc = Math.PI * (1 - 2 * (ty + y / extent) / n);
  return { lat: Math.atan(Math.sinh(merc)) * 180 / Math.PI, lon };
}

function readLines(layer: VectorTileLayer | undefined, tx: number, ty: number, keep: (p: Record<string, string | number | boolean>) => boolean): TileLine[] {
  if (!layer) return [];
  const out: TileLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2 || !keep(f.properties)) continue;
    const name = (f.properties["name:uk"] ?? f.properties.name ?? null) as string | null;
    for (const ring of f.loadGeometry()) out.push({ cls: String(f.properties.class ?? ""), name, points: ring.map((pt) => toLatLon(pt.x, pt.y, tx, ty, f.extent)) });
  }
  return out;
}

const ROAD_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"]);

function decode(buffer: ArrayBuffer, tx: number, ty: number): DecodedTile {
  const tile = new VectorTile(new Pbf(new Uint8Array(buffer)));
  const pois: TilePoi[] = [];
  const poi = tile.layers.poi;
  if (poi) {
    for (let i = 0; i < poi.length; i++) {
      const f = poi.feature(i);
      const pt = f.loadGeometry()[0]?.[0];
      if (!pt) continue;
      const p = f.properties;
      const name = (p["name:uk"] ?? p.name ?? null) as string | null;
      pois.push({ id: `t${tx}-${ty}-${f.id ?? i}`, cls: String(p.class ?? ""), sub: String(p.subclass ?? ""), name: name && String(name).trim() ? String(name).trim() : null, location: toLatLon(pt.x, pt.y, tx, ty, f.extent) });
    }
  }
  return {
    pois,
    rails: readLines(tile.layers.transportation, tx, ty, (p) => p.class === "rail" && p.brunnel !== "bridge" && p.brunnel !== "tunnel"),
    waterways: readLines(tile.layers.waterway, tx, ty, (p) => p.class === "river" || p.class === "canal" || (p.class === "stream" && !!p.name)),
    // Street junctions (for "the junction after the shop"): where drivable roads meet.
    junctions: junctionsFromRoads(readLines(tile.layers.transportation, tx, ty, (p) => ROAD_CLASSES.has(String(p.class)) && p.brunnel !== "tunnel")),
  };
}

async function loadTile(x: number, y: number): Promise<DecodedTile> {
  const key = `${x}/${y}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const task = (async () => {
    const url = (await template()).replace("{z}", String(Z)).replace("{x}", String(x)).replace("{y}", String(y));
    const response = await doFetch(url);
    if (response.status === 204 || response.status === 404) return { pois: [], rails: [], waterways: [], junctions: [] };
    if (!response.ok) throw new Error(`tile HTTP ${response.status}`);
    return decode(await response.arrayBuffer(), x, y);
  })();
  tiles.set(key, task);
  task.catch(() => tiles.delete(key));
  if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value!);
  return task;
}

async function loadTiles(keys: { x: number; y: number }[]): Promise<DecodedTile[]> {
  // At most 16 downloads at a time.
  const results: PromiseSettledResult<DecodedTile>[] = new Array(keys.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, keys.length) }, async () => {
    while (next < keys.length) {
      const i = next++;
      const k = keys[i]!;
      results[i] = await loadTile(k.x, k.y).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
    }
  }));
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0 && keys.length > 0) throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason ?? new Error("tiles failed");
  return ok;
}

function distanceM(a: LatLon, b: LatLon): number {
  const rad = (v: number) => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ——— Nearby categories ———

export function poiCategory(p: Pick<TilePoi, "cls" | "sub">): FetchCategory | null {
  if (p.cls === "fuel") return p.sub === "charging_station" ? "charger" : "fuel";
  if (p.cls === "pharmacy" || p.sub === "chemist") return "pharmacy";
  if (p.cls === "hospital" || p.sub === "clinic" || p.sub === "doctors") return "hospital";
  if (p.cls === "bank" || p.cls === "atm") return "atm";
  if (p.sub === "supermarket" || p.sub === "convenience" || p.sub === "mall" || p.sub === "marketplace" || p.sub === "department_store") return "shop";
  if (p.cls === "cafe" || p.cls === "restaurant" || p.cls === "fast_food") return "food";
  if (p.cls === "drinking_water") return "water";
  return null;
}

/** How many z14 tiles cover a circle of `radiusM` (to decide tiles vs Overpass). */
export function tileCountForRadius(center: LatLon, radiusM: number): number {
  const dLat = radiusM / 110_540;
  const dLon = radiusM / (111_320 * Math.cos(center.lat * Math.PI / 180));
  const a = tileOf({ lat: center.lat + dLat, lon: center.lon - dLon });
  const b = tileOf({ lat: center.lat - dLat, lon: center.lon + dLon });
  return (b.x - a.x + 1) * (b.y - a.y + 1);
}

/** Everyday places of one category within `radiusM` (tiles covering the circle). */
export async function tilePoisNear(center: LatLon, category: FetchCategory, radiusM: number): Promise<(TilePoi & { distanceM: number })[]> {
  const dLat = radiusM / 110_540;
  const dLon = radiusM / (111_320 * Math.cos(center.lat * Math.PI / 180));
  const a = tileOf({ lat: center.lat + dLat, lon: center.lon - dLon });
  const b = tileOf({ lat: center.lat - dLat, lon: center.lon + dLon });
  const keys: { x: number; y: number }[] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) keys.push({ x, y });
  // Never silently cover only part of the circle.
  if (keys.length > MAX_RADIUS_TILES) throw new Error(`tilePoisNear: radius needs ${keys.length} tiles`);
  const decoded = await loadTiles(keys);
  const seen = new Set<string>();
  return decoded.flatMap((t) => t.pois)
    .filter((p) => poiCategory(p) === category)
    .map((p) => ({ ...p, distanceM: distanceM(center, p.location) }))
    .filter((p) => p.distanceM <= radiusM)
    // The same place can sit in two tiles' buffers.
    .filter((p) => { const k = `${p.name ?? ""}@${p.location.lat.toFixed(4)},${p.location.lon.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => x.distanceM - y.distanceM);
}

// ——— Localization by what the driver sees ———

/** Every named/classed map feature and road junction within `radiusM` (for locate-by-description). */
export async function tileLocalizationData(center: LatLon, radiusM: number): Promise<{ features: MapFeature[]; junctions: LatLon[] }> {
  const dLat = radiusM / 110_540;
  const dLon = radiusM / (111_320 * Math.cos(center.lat * Math.PI / 180));
  const a = tileOf({ lat: center.lat + dLat, lon: center.lon - dLon });
  const b = tileOf({ lat: center.lat - dLat, lon: center.lon + dLon });
  const keys: { x: number; y: number }[] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) keys.push({ x, y });
  if (keys.length > MAX_RADIUS_TILES) throw new Error(`tileLocalizationData: radius needs ${keys.length} tiles`);
  const decoded = await loadTiles(keys);
  const seen = new Set<string>();
  const features: MapFeature[] = [];
  for (const p of decoded.flatMap((t) => t.pois)) {
    if (distanceM(center, p.location) > radiusM) continue;
    // The same place can sit in two tiles' buffers.
    const k = `${p.cls}/${p.sub}/${p.name ?? ""}@${p.location.lat.toFixed(4)},${p.location.lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    features.push({ id: p.id, cls: p.cls, sub: p.sub || null, name: p.name, location: p.location });
  }
  const junctions: LatLon[] = [];
  for (const j of decoded.flatMap((t) => t.junctions)) {
    if (distanceM(center, j) <= radiusM && !junctions.some((o) => distanceM(o, j) < 25)) junctions.push(j);
  }
  return { features, junctions };
}

// ——— Landmarks along a route ———

export function tileLandmarkKind(p: Pick<TilePoi, "cls" | "sub" | "name">): LandmarkKind | null {
  if (INVISIBLE_NAME.test(p.name ?? "") || p.sub === "parcel_locker") return null;
  if (p.cls === "fuel" && p.sub !== "charging_station") return "fuel";
  if (p.cls === "pharmacy" || p.sub === "chemist") return "pharmacy";
  if (p.sub === "supermarket") return "supermarket";
  if (p.sub === "mall" || p.sub === "department_store") return "mall";
  if (p.cls === "place_of_worship") return "church";
  if (p.sub === "school") return "school";
  if (p.cls === "hospital") return "hospital";
  if (p.cls === "bank") return "bank";
  if (p.cls === "police") return "police";
  if (p.cls === "post") return "post";
  if (p.cls === "monument") return "monument";
  if ((p.cls === "cafe" || p.cls === "restaurant" || p.cls === "fast_food") && p.name) return "cafe";
  if (p.sub === "bus_stop" && p.name) return "bus_stop";
  if ((p.cls === "shop" || p.cls === "grocery") && p.name) return "shop";
  return null;
}

/** Tiles touched by the route, sampling every ~150 m. */
export function routeTiles(geometry: LatLon[], max = 90): { x: number; y: number }[] {
  const keys = new Map<string, { x: number; y: number }>();
  const add = (p: LatLon) => { const t = tileOf(p); keys.set(`${t.x}/${t.y}`, t); };
  for (let i = 0; i < geometry.length; i++) {
    add(geometry[i]!);
    if (i > 0) {
      const a = geometry[i - 1]!, b = geometry[i]!;
      const steps = Math.floor(distanceM(a, b) / 150);
      for (let k = 1; k <= steps; k++) add({ lat: a.lat + (b.lat - a.lat) * k / (steps + 1), lon: a.lon + (b.lon - a.lon) * k / (steps + 1) });
    }
  }
  return [...keys.values()].slice(0, max);
}

function segmentIntersection(p1: LatLon, p2: LatLon, p3: LatLon, p4: LatLon): LatLon | null {
  const d = (p2.lon - p1.lon) * (p4.lat - p3.lat) - (p2.lat - p1.lat) * (p4.lon - p3.lon);
  if (Math.abs(d) < 1e-15) return null;
  const t = ((p3.lon - p1.lon) * (p4.lat - p3.lat) - (p3.lat - p1.lat) * (p4.lon - p3.lon)) / d;
  const u = ((p3.lon - p1.lon) * (p2.lat - p1.lat) - (p3.lat - p1.lat) * (p2.lon - p1.lon)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { lat: p1.lat + t * (p2.lat - p1.lat), lon: p1.lon + t * (p2.lon - p1.lon) };
}

/** Where the route crosses the given lines (deduplicated within 40 m). */
export function crossings(route: LatLon[], lines: TileLine[]): { at: LatLon; name: string | null }[] {
  const found: { at: LatLon; name: string | null }[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat), minLon = Math.min(a.lon, b.lon), maxLon = Math.max(a.lon, b.lon);
    for (const line of lines) {
      for (let j = 1; j < line.points.length; j++) {
        const c = line.points[j - 1]!, d = line.points[j]!;
        if (Math.max(c.lat, d.lat) < minLat || Math.min(c.lat, d.lat) > maxLat || Math.max(c.lon, d.lon) < minLon || Math.min(c.lon, d.lon) > maxLon) continue;
        const at = segmentIntersection(a, b, c, d);
        if (at && !found.some((f) => distanceM(f.at, at) < 40)) found.push({ at, name: line.name });
      }
    }
  }
  return found;
}

/** Visible landmarks near the route, plus rail crossings and river bridges. */
export async function tileLandmarksAlong(geometry: LatLon[]): Promise<RawLandmark[]> {
  const decoded = await loadTiles(routeTiles(geometry));
  const out: RawLandmark[] = [];
  const seen = new Set<string>();
  for (const t of decoded) {
    for (const p of t.pois) {
      const kind = tileLandmarkKind(p);
      if (!kind) continue;
      const k = `${kind}:${p.name ?? ""}@${p.location.lat.toFixed(4)},${p.location.lon.toFixed(4)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: p.id, kind, name: p.name, location: p.location });
    }
  }
  const rails = decoded.flatMap((t) => t.rails);
  const rivers = decoded.flatMap((t) => t.waterways);
  crossings(geometry, rails).forEach((c, i) => out.push({ id: `rail-${i}`, kind: "rail_crossing", name: null, location: c.at }));
  crossings(geometry, rivers).forEach((c, i) => out.push({ id: `bridge-${i}`, kind: "bridge", name: c.name ? `через річку ${c.name}` : null, location: c.at }));
  return out;
}
