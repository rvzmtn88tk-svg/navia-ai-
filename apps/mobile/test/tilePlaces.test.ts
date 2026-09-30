// Place search and localization data from REAL map tiles (OpenFreeMap z14
// around metro Kharkivska, Kyiv — fixtures/tiles-kharkivska/SOURCE.json).
// This is what the co-pilot searches when the public Overpass servers are
// unreachable (they refuse the owner's network), so it must stand on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FallbackPlaceSearchProvider, featureCategories, haversineMeters, locateByDescription, type PlaceSearchProvider } from "@navia/core";
import { TilePlaceSearchProvider, setTileFetchForTests, tileLocalizationData } from "../src/providers/vectorTiles";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tiles-kharkivska");
const KHARKIVSKA = { lat: 50.4017, lon: 30.6531 };

function serveRealTiles(): void {
  setTileFetchForTests(async (url) => {
    if (url.endsWith("/planet")) return { ok: true, status: 200, json: async () => ({ tiles: ["https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"] }), arrayBuffer: async () => new ArrayBuffer(0) };
    const [z, x, y] = url.match(/(\d+)\/(\d+)\/(\d+)\.pbf$/)!.slice(1);
    const f = join(dir, `${z}_${x}_${y}.pbf`);
    if (!existsSync(f)) return { ok: true, status: 204, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const b = readFileSync(f);
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
}

test("localization data from real tiles: the metro, the Dnipro-M next to it, road junctions", async () => {
  serveRealTiles();
  const { features, junctions } = await tileLocalizationData(KHARKIVSKA, 600);
  assert.ok(features.some((f) => f.name === "Харківська" && featureCategories(f).includes("metro")));
  assert.ok(features.some((f) => /Дніпро-М|Dnipro-M/.test(f.name ?? "")));
  assert.ok(junctions.length > 10, `${junctions.length} junctions`);
  const r = locateByDescription({ objects: [{ category: "metro" }, { category: "shop", name_variants: ["Днипро М"], relation: "opposite", of: 0 }], estimate: { location: KHARKIVSKA, sigmaM: 200 }, features, junctions });
  assert.equal(r.status, "unique");
  assert.ok(haversineMeters(r.candidates[0]!.location, KHARKIVSKA) < 150);
});

test("co-pilot place search from tiles: real named places, nearest first, names across scripts", async () => {
  serveRealTiles();
  const tiles = new TilePlaceSearchProvider();
  const pharmacies = await tiles.searchAround(KHARKIVSKA, 500, { categories: ["pharmacy"] }, 10);
  assert.ok(pharmacies.length > 0);
  assert.ok(pharmacies.every((p) => p.category === "pharmacy" && p.name && p.source === "osm-online"));
  const d = pharmacies.map((p) => haversineMeters(KHARKIVSKA, p.location));
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  // A brand said in Latin finds the Ukrainian-named shop (and vice versa).
  const byLatin = await tiles.searchAround(KHARKIVSKA, 500, { nameVariants: ["Dnipro-M"] }, 10);
  assert.ok(byLatin.length === 0 || byLatin.every((p) => /дніпро|dnipro/i.test(p.name)));
  // Along a short line through the square.
  const line = [{ lat: 50.4000, lon: 30.6450 }, { lat: 50.4035, lon: 30.6600 }];
  const along = await tiles.searchAlongPolyline(line, 150, { categories: ["pharmacy", "supermarket", "fast_food"] }, 20);
  assert.ok(along.length > 0);
});

test("when the first source fails the fallback answers; when all fail the error is honest", async () => {
  const failing: PlaceSearchProvider = { source: "osm-online", searchAlongPolyline: () => Promise.reject(new Error("Overpass: all mirrors failed")), searchAround: () => Promise.reject(new Error("Overpass: all mirrors failed")) };
  serveRealTiles();
  const chain = new FallbackPlaceSearchProvider([failing, new TilePlaceSearchProvider()]);
  assert.ok((await chain.searchAround(KHARKIVSKA, 400, { categories: ["pharmacy"] })).length > 0);
  await assert.rejects(new FallbackPlaceSearchProvider([failing]).searchAround(KHARKIVSKA, 400, {}), /mirrors failed/);
  setTileFetchForTests(null);
});
