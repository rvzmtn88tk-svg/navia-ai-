// Offline search directory (part of the "Київ + область" package): every
// named settlement of the oblast (cities, towns, villages, hamlets, city
// districts) and, for Kyiv, every named street and named place, read from the
// same OpenFreeMap vector tiles the map is drawn from (settlements from z10
// tiles, streets and places from z14). Searched by name without network; each
// result is marked "offline". House numbers are not in the directory (the
// tiles do not link a number to its street) — a street is found, not a house.
import type { LatLon } from "@navia/core";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { poiCategory, tileFetch, tileOf, tileTemplate, toLatLon } from "../providers/vectorTiles";
import { placeName, type FetchCategory, type NearbyPlace } from "../providers/NearbyPlacesProvider";
import type { Bbox } from "./offlinePlaces";

export type GazKind = "city" | "town" | "village" | "hamlet" | "suburb" | "street" | "poi";
/** Compact on-disk record: name, kind, lat, lon, alternative names (ru/en, "|"-joined), area, place category. */
type Entry = { n: string; k: GazKind; la: number; lo: number; x?: string; a?: string; c?: string };
type Meta = { builtAt: string; counts: Record<string, number>; bytes: number; tiles: number; failedTiles: number };

export type OfflineHit = { id: string; name: string; kind: GazKind; area?: string; category?: string; location: LatLon; distanceM?: number };

type KV = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; removeItemAsync?(key: string): Promise<void> };
let kv: KV | null | undefined;
function storage(): KV | null {
  if (kv !== undefined) return kv;
  try { kv = (require("expo-sqlite/kv-store") as { default: KV }).default; } catch { kv = null; }
  return kv;
}
/** Loads the directory into memory ahead of the first search. */
export function warmOfflineSearch(): void {
  void load().catch(() => {});
}

export function setGazetteerStorageForTests(store: KV | null): void {
  kv = store;
  index = undefined;
}

const KEY = "navia.offline.gazetteer.v1";
const META_KEY = "navia.offline.gazetteer.meta.v1";
const SETTLEMENT_Z = 10;
const CITY_Z = 14;
const TILE_TIMEOUT_MS = 20_000;
const SETTLEMENTS = new Set(["city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter"]);

// ——— Text folding: Ukrainian / Russian / surzhyk spellings meet ———

const FOLD: Record<string, string> = { "ё": "е", "ы": "и", "э": "е", "і": "и", "ї": "и", "є": "е", "ґ": "г", "ъ": "", "й": "и" };
/** Lower case, one alphabet for uk/ru look-alikes, no apostrophes or punctuation. */
export function fold(s: string): string {
  return s.toLowerCase()
    .replace(/[’'ʼ`"«»]/g, "")
    .replace(/[ёыэіїєґъй]/g, (ch) => FOLD[ch] ?? ch)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Generic words that are not the name itself: "вулиця", "просп.", "село"… */
const GENERIC = new Set(["вулиця", "вул", "улица", "ул", "проспект", "просп", "пр", "пркт", "бульвар", "бул", "бульв", "провулок", "пров", "переулок", "пер",
  "площа", "пл", "площадь", "шосе", "шоссе", "набережна", "набережная", "наб", "узвиз", "спуск", "тупик", "произд", "проезд", "село", "с", "смт", "мисто", "м",
  "город", "г", "селище", "поселок", "пос", "метро", "станция", "ст", "зупинка", "остановка", "street", "st", "avenue", "ave", "road", "rd", "village", "town"].map(fold));

function tokens(s: string): string[] {
  const all = fold(s).split(" ").filter(Boolean);
  const named = all.filter((w) => !GENERIC.has(w));
  return named.length > 0 ? named : all;
}

// ——— Building the directory from tiles ———

function tilesIn(b: Bbox, z: number): { x: number; y: number }[] {
  const a = tileOf({ lat: b.north, lon: b.west }, z), c = tileOf({ lat: b.south, lon: b.east }, z);
  const out: { x: number; y: number }[] = [];
  for (let x = a.x; x <= c.x; x++) for (let y = a.y; y <= c.y; y++) out.push({ x, y });
  return out;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
type Props = Record<string, string | number | boolean>;
const nameOf = (p: Props): string | null => {
  const n = String(p["name:uk"] ?? p.name ?? "").trim();
  return n || null;
};
function altNames(p: Props, main: string): string | undefined {
  const alts = [p["name:ru"], p["name:en"], p.name_int, p.name].map((v) => (v == null ? "" : String(v).trim())).filter((v) => v && v !== main);
  return alts.length > 0 ? [...new Set(alts)].join("|") : undefined;
}
const HIDDEN = /^(bus_stop|parcel_locker|vending_machine|waste_basket|bench)$/;

export type GazetteerProgress = { done: number; total: number };
export type BuildResult = { meta: Meta; pois: Partial<Record<FetchCategory, NearbyPlace[]>> };

/** Downloads the tiles, builds the directory and saves it. Also returns the
 * city's places by search category (a fallback for the offline places when
 * the OpenStreetMap servers do not answer). */
export async function buildGazetteer(oblast: Bbox, city: Bbox, onProgress: (p: GazetteerProgress) => void = () => {}, concurrency = 12): Promise<BuildResult> {
  const store = storage();
  if (!store) throw new Error("offline directory: no storage");
  const template = await tileTemplate();
  const jobs = [
    ...tilesIn(oblast, SETTLEMENT_Z).map((t) => ({ ...t, z: SETTLEMENT_Z })),
    ...tilesIn(city, CITY_Z).map((t) => ({ ...t, z: CITY_Z })),
  ];
  const places = new Map<string, Entry>();
  const streets = new Map<string, { n: string; x?: string; pts: LatLon[] }>();
  const named = new Map<string, Entry>();
  const pois: Partial<Record<FetchCategory, NearbyPlace[]>> = {};
  const seenPoi = new Set<string>();
  let done = 0, failedTiles = 0, next = 0;

  const handle = (buf: ArrayBuffer, tx: number, ty: number, z: number) => {
    const tile = new VectorTile(new Pbf(new Uint8Array(buf)));
    const place = tile.layers.place;
    for (let i = 0; place && i < place.length; i++) {
      const f = place.feature(i);
      const cls = String(f.properties.class ?? "");
      const n = nameOf(f.properties);
      const pt = f.loadGeometry()[0]?.[0];
      if (!n || !pt || !SETTLEMENTS.has(cls)) continue;
      const at = toLatLon(pt.x, pt.y, tx, ty, f.extent, z);
      const kind: GazKind = cls === "neighbourhood" || cls === "quarter" ? "suburb" : cls as GazKind;
      const key = `${fold(n)}@${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
      if (!places.has(key)) places.set(key, { n, k: kind, la: round(at.lat), lo: round(at.lon), ...(altNames(f.properties, n) ? { x: altNames(f.properties, n) } : {}) });
    }
    if (z !== CITY_Z) return;
    const roads = tile.layers.transportation_name;
    for (let i = 0; roads && i < roads.length; i++) {
      const f = roads.feature(i);
      const n = nameOf(f.properties);
      if (!n || f.type !== 2) continue;
      const key = fold(n);
      const s = streets.get(key) ?? { n, x: altNames(f.properties, n), pts: [] };
      for (const ring of f.loadGeometry()) {
        const mid = ring[Math.floor(ring.length / 2)];
        if (mid) s.pts.push(toLatLon(mid.x, mid.y, tx, ty, f.extent, z));
      }
      streets.set(key, s);
    }
    const poi = tile.layers.poi;
    for (let i = 0; poi && i < poi.length; i++) {
      const f = poi.feature(i);
      const pt = f.loadGeometry()[0]?.[0];
      if (!pt) continue;
      const p = f.properties;
      const at = toLatLon(pt.x, pt.y, tx, ty, f.extent, z);
      const cls = String(p.class ?? ""), sub = String(p.subclass ?? "");
      const n = nameOf(p);
      const category = poiCategory({ cls, sub });
      const key = `${n ?? cls}@${at.lat.toFixed(4)},${at.lon.toFixed(4)}`;
      if (seenPoi.has(key)) continue;
      seenPoi.add(key);
      if (category) {
        (pois[category] ??= []).push({ id: `tile-${tx}-${ty}-${f.id ?? i}`, name: n ?? placeName({}, category), category, location: at, distanceM: 0, source: "OpenStreetMap", origin: "offline" });
      }
      if (n && !HIDDEN.test(sub)) named.set(key, { n, k: "poi", la: round(at.lat), lo: round(at.lon), c: category ?? cls, ...(altNames(p, n) ? { x: altNames(p, n) } : {}) });
    }
  };

  onProgress({ done, total: jobs.length });
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      try {
        // A request that never answers must not hold the whole package.
        const res = await withTimeout(tileFetch(template.replace("{z}", String(j.z)).replace("{x}", String(j.x)).replace("{y}", String(j.y))), TILE_TIMEOUT_MS);
        if (res.ok && res.status !== 204) handle(await res.arrayBuffer(), j.x, j.y, j.z);
        else if (res.status !== 204 && res.status !== 404) failedTiles++;
      } catch { failedTiles++; }
      done++;
      if (done % 20 === 0 || done === jobs.length) onProgress({ done, total: jobs.length });
    }
  }));
  if (failedTiles > jobs.length / 10) throw new Error(`офлайн-довідник: не завантажено ${failedTiles} з ${jobs.length} тайлів`);

  // A street name used in several parts of the city is several streets:
  // cluster its pieces (2.5 km), one entry per cluster, at the piece
  // nearest the cluster's middle.
  const streetEntries: Entry[] = [];
  for (const s of streets.values()) {
    const clusters: LatLon[][] = [];
    for (const p of s.pts) {
      const c = clusters.find((cl) => approxM(cl[0]!, p) < 2500);
      if (c) c.push(p); else clusters.push([p]);
    }
    for (const cl of clusters) {
      const mid = { lat: cl.reduce((a, p) => a + p.lat, 0) / cl.length, lon: cl.reduce((a, p) => a + p.lon, 0) / cl.length };
      const at = cl.reduce((best, p) => (approxM(p, mid) < approxM(best, mid) ? p : best), cl[0]!);
      streetEntries.push({ n: s.n, k: "street", la: round(at.lat), lo: round(at.lon), ...(s.x ? { x: s.x } : {}) });
    }
  }
  const settlements = [...places.values()];
  const grid = settlementGrid(settlements);
  const withArea = (e: Entry): Entry => { const a = areaOf(e, grid); return a ? { ...e, a } : e; };
  const entries: Entry[] = [...settlements.map((e) => (e.k === "suburb" ? withArea(e) : e)), ...streetEntries.map(withArea), ...[...named.values()].map(withArea)];
  const json = JSON.stringify(entries);
  await store.setItemAsync(KEY, json);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.k] = (counts[e.k] ?? 0) + 1;
  const meta: Meta = { builtAt: new Date().toISOString().slice(0, 10), counts, bytes: json.length, tiles: jobs.length, failedTiles };
  await store.setItemAsync(META_KEY, JSON.stringify(meta));
  index = undefined;
  return { meta, pois };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tile timeout")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function approxM(a: LatLon, b: LatLon): number {
  const dx = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

/** Settlements bucketed by 0.05° cells, so a lookup checks 9 cells, not all 3 000+. */
const CELL = 0.05;
type Grid = Map<string, Entry[]>;
function settlementGrid(settlements: Entry[]): Grid {
  const g: Grid = new Map();
  for (const s of settlements) {
    const key = `${Math.floor(s.la / CELL)}:${Math.floor(s.lo / CELL)}`;
    const cell = g.get(key);
    if (cell) cell.push(s); else g.set(key, [s]);
  }
  return g;
}

/** The settlement (or Kyiv district) a street or place belongs to: the nearest one within 4 km. */
function areaOf(e: Entry, grid: Grid): string | undefined {
  let best: Entry | null = null, bestM = 4000;
  const cy = Math.floor(e.la / CELL), cx = Math.floor(e.lo / CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const s of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
      if (s === e) continue;
      // A district names a street better than "Київ" does.
      const m = approxM({ lat: s.la, lon: s.lo }, { lat: e.la, lon: e.lo }) * (s.k === "suburb" ? 0.6 : s.k === "city" ? 1.4 : 1);
      if (m < bestM) { best = s; bestM = m; }
    }
  }
  return best?.n;
}

export async function gazetteerMeta(): Promise<Meta | null> {
  const raw = await storage()?.getItemAsync(META_KEY).catch(() => null);
  return raw ? JSON.parse(raw) as Meta : null;
}

export async function removeGazetteer(): Promise<void> {
  await storage()?.removeItemAsync?.(KEY).catch(() => {});
  await storage()?.removeItemAsync?.(META_KEY).catch(() => {});
  index = undefined;
}

// ——— Searching ———

type Indexed = Entry & { t: string[]; f: string };
let index: Promise<Indexed[]> | undefined;

function load(): Promise<Indexed[]> {
  index ??= (async () => {
    const raw = await storage()?.getItemAsync(KEY).catch(() => null);
    const list = raw ? JSON.parse(raw) as Entry[] : [];
    return list.map((e) => {
      const names = [e.n, ...(e.x ? e.x.split("|") : [])];
      return { ...e, t: names.flatMap(tokens), f: names.map((n) => tokens(n).join(" ")).join("|") };
    });
  })();
  return index;
}

const KIND_WEIGHT: Record<GazKind, number> = { city: 6, town: 5, suburb: 4, village: 3.5, street: 3, hamlet: 2, poi: 1.5 };

/** Name search in the offline directory: every word of the query must start
 * a word of the name (any spelling: uk / ru / en). Nearer results first among
 * equals. */
export async function searchOffline(query: string, near?: LatLon | null, limit = 8): Promise<OfflineHit[]> {
  // "Хрещатик 22": house numbers are not in the directory — the street is
  // found by its words; a number only lifts a name that contains it.
  const all0 = tokens(query);
  const words = all0.filter((w) => !/\d/.test(w));
  const q = words.length > 0 ? words : all0;
  const numbers = words.length > 0 ? all0.filter((w) => /\d/.test(w)) : [];
  if (q.length === 0 || q.join("").length < 2) return [];
  const all = await load();
  const whole = q.join(" ");
  const scored: { e: Indexed; score: number; d?: number }[] = [];
  for (const e of all) {
    if (!q.every((w) => e.t.some((t) => t.startsWith(w)))) continue;
    let score = KIND_WEIGHT[e.k];
    if (numbers.some((w) => e.t.includes(w))) score += 2;
    if (e.f.split("|").includes(whole)) score += 6;
    else if (e.f.split("|").some((n) => n.startsWith(whole))) score += 3;
    const d = near ? approxM(near, { lat: e.la, lon: e.lo }) : undefined;
    if (d != null) score -= Math.log10(d / 1000 + 1) * 1.5;
    scored.push({ e, score, ...(d != null ? { d } : {}) });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: OfflineHit[] = [];
  for (const { e, d } of scored) {
    // One result per place: the same name nearby is a duplicate (a chain's
    // two doors, a street cut into pieces); far apart it is another place.
    if (out.some((o) => o.kind === e.k && fold(o.name) === fold(e.n) && approxM(o.location, { lat: e.la, lon: e.lo }) < 2500)) continue;
    out.push({ id: `off-${e.k}-${e.la},${e.lo}`, name: e.n, kind: e.k, ...(e.a ? { area: e.a } : {}), ...(e.c ? { category: e.c } : {}), location: { lat: e.la, lon: e.lo }, ...(d != null ? { distanceM: d } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}
