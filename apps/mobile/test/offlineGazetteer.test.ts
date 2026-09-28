// Offline search directory: built from vector tiles (settlements z10, Kyiv
// streets and places z14), searched by name without network. Tiles here are
// encoded in the test with known content, so every expectation is exact.
import test from "node:test";
import assert from "node:assert/strict";
import { destinationPoint, type LatLon } from "@navia/core";
import { buildGazetteer, fold, gazetteerMeta, searchOffline, setGazetteerStorageForTests } from "../src/offline/offlineGazetteer";
import { downloadOfflinePlaces, offlinePlacesWithin, setOfflinePlacesStorageForTests } from "../src/offline/offlinePlaces";
import { setTileFetchForTests, tileOf } from "../src/providers/vectorTiles";
import { resetOverpassPreference } from "../src/providers/overpass";
import { isNetworkError } from "../src/providers/netError";
import { encodeTile, type TestFeature } from "./support/mvt";

function memoryKV() {
  const m = new Map<string, string>();
  return { getItemAsync: async (k: string) => m.get(k) ?? null, setItemAsync: async (k: string, v: string) => { m.set(k, v); }, removeItemAsync: async (k: string) => { m.delete(k); } };
}

/** Tile and in-tile pixel (extent 4096) of a point. */
function pixel(p: LatLon, z: number): { key: string; xy: [number, number] } {
  const n = 2 ** z;
  const lat = p.lat * Math.PI / 180;
  const fx = (p.lon + 180) / 360 * n;
  const fy = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n;
  const t = tileOf(p, z);
  return { key: `${z}/${t.x}/${t.y}`, xy: [Math.round((fx - t.x) * 4096), Math.round((fy - t.y) * 4096)] };
}

const tetiiv = { lat: 49.3713, lon: 29.6676 };
const bila = { lat: 49.7989, lon: 30.1153 };
const maidan = { lat: 50.4501, lon: 30.5234 };
const OBLAST = { south: 49.3, west: 29.6, north: 49.9, east: 30.2 };
const CITY = { south: 50.44, west: 30.5, north: 50.47, east: 30.6 };

/** Features per tile key; the fake server answers 204 (empty) elsewhere. */
function world(): Map<string, { layer: string; f: TestFeature }[]> {
  const tiles = new Map<string, { layer: string; f: TestFeature }[]>();
  const put = (z: number, layer: string, type: TestFeature["type"], props: Record<string, string>, points: LatLon[]) => {
    const first = pixel(points[0]!, z);
    const coords = points.map((p) => pixel(p, z).xy);
    tiles.set(first.key, [...(tiles.get(first.key) ?? []), { layer, f: { type, props, coords } }]);
  };
  put(10, "place", "point", { class: "town", name: "Тетіїв", "name:ru": "Тетиев" }, [tetiiv]);
  put(10, "place", "point", { class: "city", name: "Біла Церква", "name:ru": "Белая Церковь" }, [bila]);
  put(14, "place", "point", { class: "suburb", name: "Центр" }, [destinationPoint(maidan, 0, 150)]);
  put(14, "transportation_name", "line", { class: "primary", name: "вулиця Хрещатик", "name:ru": "улица Крещатик" }, [destinationPoint(maidan, 200, 300), destinationPoint(maidan, 20, 300)]);
  put(14, "poi", "point", { class: "pharmacy", subclass: "pharmacy", name: "Аптека Доброго Дня" }, [destinationPoint(maidan, 90, 200)]);
  put(14, "poi", "point", { class: "fuel", subclass: "fuel" }, [destinationPoint(maidan, 120, 500)]);
  put(14, "poi", "point", { class: "bus", subclass: "bus_stop", name: "Майдан Незалежності" }, [destinationPoint(maidan, 45, 100)]);
  // The same street name in two parts of the city: two streets.
  put(14, "transportation_name", "line", { class: "minor", name: "Садова вулиця" }, [destinationPoint(maidan, 90, 1000), destinationPoint(maidan, 90, 1100)]);
  put(14, "transportation_name", "line", { class: "minor", name: "Садова вулиця" }, [destinationPoint(maidan, 90, 5500), destinationPoint(maidan, 90, 5600)]);
  return tiles;
}

function serve(tiles: Map<string, { layer: string; f: TestFeature }[]>, fail = new Set<string>()) {
  setTileFetchForTests(async (url) => {
    if (url.endsWith("/planet")) return { ok: true, status: 200, json: async () => ({ tiles: ["https://t.test/planet/20260913_x/{z}/{x}/{y}.pbf"] }), arrayBuffer: async () => new ArrayBuffer(0) };
    const key = url.match(/(\d+\/\d+\/\d+)\.pbf$/)![1]!;
    if (fail.has(key) || fail.has("*")) throw new TypeError("Network request failed");
    const features = tiles.get(key);
    if (!features) return { ok: true, status: 204, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const layers = [...new Set(features.map((x) => x.layer))].map((name) => ({ name, features: features.filter((x) => x.layer === name).map((x) => x.f) }));
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => encodeTile(layers) };
  });
}

test("fold: Ukrainian / Russian look-alike letters and apostrophes meet", () => {
  assert.equal(fold("Лук’янівська"), fold("Лук'янівська"));
  assert.equal(fold("лукʼянівська"), "лукянивська");
  assert.equal(fold("Київ"), fold("Киів"), "ї and і fold to и");
  assert.equal(fold("ТЕТІЇВ"), fold("тетіїв"));
  assert.equal(fold("Ґонти"), "гонти");
  assert.equal(fold("вул. Хрещатик, 22"), "вул хрещатик 22");
});

test("offline directory: built from tiles, found by name in any spelling, no network", async () => {
  const kv = memoryKV();
  setGazetteerStorageForTests(kv);
  serve(world());
  const built = await buildGazetteer(OBLAST, CITY);
  assert.equal(built.meta.counts.town, 1);
  assert.equal(built.meta.counts.city, 1);
  assert.equal(built.meta.counts.street, 3, "Хрещатик + two separate Садова streets");
  assert.equal(built.meta.failedTiles, 0);
  // Search runs on stored data only: the network is now gone.
  serve(new Map(), new Set(["*"]));
  setGazetteerStorageForTests(kv);

  const t1 = await searchOffline("тетиев");
  assert.equal(t1[0]?.name, "Тетіїв");
  assert.equal(t1[0]?.kind, "town");
  assert.ok(Math.abs(t1[0]!.location.lat - tetiiv.lat) < 0.001 && Math.abs(t1[0]!.location.lon - tetiiv.lon) < 0.001, "location from the tile");
  assert.equal((await searchOffline("белая церковь"))[0]?.name, "Біла Церква");
  assert.equal((await searchOffline("Біла Церква"))[0]?.kind, "city");

  const street = await searchOffline("вул. Крещатик", maidan);
  assert.equal(street[0]?.name, "вулиця Хрещатик");
  assert.equal(street[0]?.kind, "street");
  assert.equal(street[0]?.area, "Центр", "the district it is in");
  // House number: not in the directory — the street is still found.
  assert.equal((await searchOffline("Хрещатик 22", maidan))[0]?.name, "вулиця Хрещатик");

  const sadova = (await searchOffline("садова", maidan)).filter((h) => h.kind === "street");
  assert.equal(sadova.length, 2);
  assert.ok(sadova[0]!.distanceM! < sadova[1]!.distanceM!, "nearer one first");

  const pharmacy = await searchOffline("аптека доброго", maidan);
  assert.equal(pharmacy[0]?.name, "Аптека Доброго Дня");
  assert.equal(pharmacy[0]?.category, "pharmacy");
  assert.equal((await searchOffline("Майдан Незалежності")).length, 0, "bus stops are not search results");
  assert.deepEqual(await searchOffline("Жмеринка"), [], "not in the package → nothing, never a guess");
  assert.ok(await gazetteerMeta());

  // City places by category, for the offline category search.
  assert.equal(built.pois.pharmacy?.[0]?.name, "Аптека Доброго Дня");
  assert.equal(built.pois.fuel?.length, 1);
  assert.ok(built.pois.fuel![0]!.name.length > 0, "an unnamed station still has a readable name");
  setTileFetchForTests(null);
});

test("offline directory: no package → empty results; a mostly failed download is an error", async () => {
  setGazetteerStorageForTests(memoryKV());
  assert.deepEqual(await searchOffline("Київ"), []);
  assert.equal(await gazetteerMeta(), null);
  serve(world(), new Set(["*"]));
  await assert.rejects(buildGazetteer(OBLAST, CITY), /не завантажено/);
  setTileFetchForTests(null);
});

test("offline places: OpenStreetMap down → the map's own places are kept, and the gap is named", async () => {
  setOfflinePlacesStorageForTests(memoryKV());
  resetOverpassPreference();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("MapServer")) return { ok: true, status: 200, json: async () => ({ features: [] }) } as Response;
    return { ok: false, status: 504, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const fuel = { id: "tile-1", name: "WOG", category: "fuel" as const, location: destinationPoint(maidan, 90, 300), distanceM: 0, source: "OpenStreetMap" as const, origin: "offline" as const };
    const meta = await downloadOfflinePlaces({ south: 50.4, west: 30.4, north: 50.5, east: 30.6 }, () => {}, { perEndpointTimeoutMs: 50, fallback: { fuel: [fuel] }, fallbackLabel: "з карти, лише Київ" });
    assert.equal(meta.counts.fuel, 1);
    assert.ok(meta.failed.includes("OpenStreetMap: fuel (з карти, лише Київ)"), meta.failed.join("; "));
    assert.ok(meta.failed.includes("OpenStreetMap: pharmacy"), "no substitute → reported as missing");
    assert.equal((await offlinePlacesWithin("fuel", maidan, 1000))[0]?.name, "WOG");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("route error: network failures are told apart from bad routes", () => {
  for (const m of ["Network request failed", "Network request failed (offline test mode)", "Aborted", "The request timed out.", "AbortError: signal is aborted without reason"]) assert.ok(isNetworkError(m), m);
  for (const m of ["OnlineValhallaProvider: route geometry needs at least two points.", "Valhalla HTTP 400: No path could be found", null]) assert.ok(!isNetworkError(m), String(m));
});
