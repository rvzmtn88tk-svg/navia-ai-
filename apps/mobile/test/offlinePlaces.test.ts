// Offline package places: stored on the phone, strict radius, marked offline;
// a category that fails to download is reported, never faked.
import test from "node:test";
import assert from "node:assert/strict";
import { destinationPoint } from "@navia/core";
import { downloadOfflinePlaces, offlinePlacesMeta, offlinePlacesWithin, setOfflinePlacesStorageForTests } from "../src/offline/offlinePlaces";
import { resetOverpassPreference } from "../src/providers/overpass";

const maidan = { lat: 50.4501, lon: 30.5234 };
const at = (b: number, m: number) => destinationPoint(maidan, b, m);

function memoryKV() {
  const m = new Map<string, string>();
  return { getItemAsync: async (k: string) => m.get(k) ?? null, setItemAsync: async (k: string, v: string) => { m.set(k, v); }, removeItemAsync: async (k: string) => { m.delete(k); }, size: () => m.size };
}

test("offline places: download → stored → strict radius search, marked offline", async () => {
  const kv = memoryKV();
  setOfflinePlacesStorageForTests(kv);
  resetOverpassPreference();
  const realFetch = globalThis.fetch;
  const shelterNear = at(90, 400), shelterFar = at(0, 3000), fuel = at(180, 800);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (o: unknown) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) }) as Response;
    if (url.includes("Public_protection/MapServer/0/query")) {
      return json({ features: [
        { geometry: { x: shelterNear.lon, y: shelterNear.lat }, attributes: { OBJECTID: 1, name: "Укриття біля Майдану", address: "Хрещатик 1" } },
        { geometry: { x: shelterFar.lon, y: shelterFar.lat }, attributes: { OBJECTID: 2, name: "Укриття далеко", address: "Оболонь" } },
      ] });
    }
    if (url.includes("Public_protection/MapServer/1/query")) return json({ features: [] });
    if (url.includes("overpass")) {
      const body = decodeURIComponent(String(init?.body ?? ""));
      if (body.includes('"amenity"="fuel"')) return json({ elements: [{ type: "node", id: 7, lat: fuel.lat, lon: fuel.lon, tags: { amenity: "fuel", name: "ОККО" } }] });
      if (body.includes('"amenity"="pharmacy"')) return { ok: false, status: 504, json: async () => ({}) } as Response;
      return json({ elements: [] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const meta = await downloadOfflinePlaces({ south: 50.2, west: 30.2, north: 50.6, east: 30.8 }, () => {});
    assert.equal(meta.counts.shelter, 2);
    assert.equal(meta.counts.fuel, 1);
    assert.ok(meta.failed.some((f) => f.includes("pharmacy")), `failed categories are reported: ${meta.failed.join(", ")}`);
    const within1k = await offlinePlacesWithin("shelter", maidan, 1000);
    assert.deepEqual(within1k.map((p) => p.name), ["Укриття біля Майдану"]);
    assert.equal(within1k[0]!.origin, "offline");
    assert.match(within1k[0]!.sourceDetail ?? "", /КМДА · офлайн-знімок від \d{4}-\d{2}-\d{2}/);
    assert.equal((await offlinePlacesWithin("shelter", maidan, 5000)).length, 2);
    assert.equal((await offlinePlacesWithin("fuel", maidan, 1000))[0]!.name, "ОККО");
    assert.equal((await offlinePlacesWithin("pharmacy", maidan, 5000)).length, 0);
    assert.ok(await offlinePlacesMeta());
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("offline places: nothing downloaded → empty, never invented", async () => {
  setOfflinePlacesStorageForTests(memoryKV());
  assert.equal(await offlinePlacesMeta(), null);
  assert.deepEqual(await offlinePlacesWithin("shelter", maidan, 5000), []);
});

test("offline package: when OpenStreetMap does not answer, the places step ends after one category, not ten", async () => {
  setOfflinePlacesStorageForTests(memoryKV());
  resetOverpassPreference();
  const realFetch = globalThis.fetch;
  let overpassCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (o: unknown, status = 200) => ({ ok: status === 200, status, json: async () => o, text: async () => JSON.stringify(o) }) as Response;
    if (url.includes("Public_protection/MapServer/0/query")) return json({ features: [{ geometry: { x: maidan.lon, y: maidan.lat }, attributes: { OBJECTID: 1, name: "Укриття" } }] });
    if (url.includes("Public_protection/MapServer/1/query")) return json({ features: [] });
    if (url.includes("overpass")) { overpassCalls++; await new Promise((r) => setTimeout(r, 300)); return json({}, 504); } // real servers: ~80 s per category
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const t0 = Date.now();
    const categoriesSeen: string[] = [];
    const meta = await downloadOfflinePlaces({ south: 50.2, west: 30.2, north: 50.6, east: 30.8 }, (p) => { if (!categoriesSeen.includes(p.category)) categoriesSeen.push(p.category); });
    const ms = Date.now() - t0;
    console.log(`places step with OSM down: ${ms} ms, ${overpassCalls} Overpass requests (≈ ${Math.round(overpassCalls / 4 * 80)} s with real ~80 s timeouts); saved ${meta.counts.shelter} official shelters; reported: ${meta.failed.length} gaps`);
    assert.ok(overpassCalls <= 4, `${overpassCalls} Overpass requests`);
    assert.equal(meta.counts.shelter, 1, "official data still saved");
    assert.equal(meta.failed.filter((f) => f.startsWith("OpenStreetMap")).length, 10, "every OSM gap is reported");
    assert.equal(categoriesSeen.length, 10, "progress walks all categories");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("offline package: an update without network keeps the saved places and counts them", async () => {
  const kv = memoryKV();
  setOfflinePlacesStorageForTests(kv);
  resetOverpassPreference();
  const realFetch = globalThis.fetch;
  const json = (o: unknown, status = 200) => ({ ok: status === 200, status, json: async () => o, text: async () => JSON.stringify(o) }) as Response;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("MapServer/0/query")) return json({ features: [{ geometry: { x: maidan.lon, y: maidan.lat }, attributes: { OBJECTID: 1, name: "Укриття" } }] });
    if (url.includes("MapServer/1/query")) return json({ features: [] });
    return json({ elements: [] });
  }) as typeof fetch;
  const bbox = { south: 50.2, west: 30.2, north: 50.6, east: 30.8 };
  try {
    assert.equal((await downloadOfflinePlaces(bbox, () => {})).counts.shelter, 1);
    globalThis.fetch = (async () => { throw new TypeError("Network request failed"); }) as typeof fetch;
    const again = await downloadOfflinePlaces(bbox, () => {});
    assert.equal(again.counts.shelter, 1, "the saved shelter is still there and counted");
    assert.equal((await offlinePlacesWithin("shelter", maidan, 500)).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
