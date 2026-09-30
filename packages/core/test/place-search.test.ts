// PlaceSearchProvider implementations + opening_hours evaluation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalPlaceSearchProvider, OverpassPlaceSearchProvider, evaluateOpeningHours, matchesFilter, normalizePlaceName,
  overpassRegexLiteral, type FetchLike,
} from "../src/place-search";
import { DEMO_ROUTE_POIS, demoPointAlongRoad } from "../src/demo-data";

const at = (h: number, m = 0, day = 29) => new Date(2026, 8, day, h, m); // 29 Sep 2026 is a Tuesday

test("opening_hours: 24/7, day ranges, multiple ranges, off, past-midnight, unknown", () => {
  const tue = at(14); // 2026-09-29
  assert.equal(tue.getDay(), 2, "fixture date must be a Tuesday");
  assert.equal(evaluateOpeningHours("24/7", tue), true);
  assert.equal(evaluateOpeningHours("Mo-Su 07:00-22:00", tue), true);
  assert.equal(evaluateOpeningHours("Mo-Su 07:00-22:00", at(23)), false);
  assert.equal(evaluateOpeningHours("Mo-Fr 08:00-18:00; Sa-Su off", tue), true);
  const sunday = new Date(2026, 9, 4, 12, 0); // Sunday 4 Oct 2026
  assert.equal(sunday.getDay(), 0);
  assert.equal(evaluateOpeningHours("Mo-Fr 08:00-18:00; Sa-Su off", sunday), false);
  assert.equal(evaluateOpeningHours("Mo-Fr 10:00-13:00,14:00-19:00", at(13, 30)), false);
  assert.equal(evaluateOpeningHours("Mo-Fr 10:00-13:00,14:00-19:00", at(15)), true);
  assert.equal(evaluateOpeningHours("Mo-Su 20:00-04:00", at(2)), true); // spill-over from Monday night
  assert.equal(evaluateOpeningHours("Mo-Su 20:00-04:00", at(14)), false);
  assert.equal(evaluateOpeningHours("We 09:00-17:00", tue), false); // well-formed, no rule for today
  assert.equal(evaluateOpeningHours("sunrise-sunset", tue), null); // unsupported -> unknown, not a guess
  assert.equal(evaluateOpeningHours(undefined, tue), null);
});

test("name matching: normalisation makes \"McDonald's\" match \"mcdonalds\" and Cyrillic variants are just more variants", () => {
  assert.equal(normalizePlaceName("McDonald’s"), "mcdonalds");
  const mcd = DEMO_ROUTE_POIS.find((p) => p.id === "demo-ff-mcd-1")!;
  assert.ok(matchesFilter(mcd, { nameVariants: ["mcdonalds"] }));
  assert.ok(matchesFilter(mcd, { nameVariants: ["Макдональдз", "McDonald's"] }));
  assert.ok(!matchesFilter(mcd, { categories: ["fuel"] }));
  assert.ok(!matchesFilter(mcd, { nameVariants: ["KFC"] }));
});

test("LocalPlaceSearchProvider: corridor search along a polyline and radius search; tags source", async () => {
  const provider = new LocalPlaceSearchProvider(DEMO_ROUTE_POIS, "demo");
  const corridor = [demoPointAlongRoad(0, 0), demoPointAlongRoad(4_400, 0), demoPointAlongRoad(11_900, 0), demoPointAlongRoad(24_000, 0)];
  const fuel500 = await provider.searchAlongPolyline(corridor, 500, { categories: ["fuel"] });
  assert.deepEqual(fuel500.map((p) => p.id).sort(), ["demo-fuel-okko-1", "demo-fuel-wog-2"]);
  assert.ok(fuel500.every((p) => p.source === "demo"));
  const around = await provider.searchAround(demoPointAlongRoad(6_000, 0), 300, { categories: ["cafe"] });
  assert.deepEqual(around.map((p) => p.id), ["demo-cafe-aroma"]);
});

test("Overpass: builds a real around-polyline query with category + escaped name regex", () => {
  const provider = new OverpassPlaceSearchProvider({ endpoint: "https://overpass.example/api/interpreter", fetchImpl: async () => { throw new Error("unused"); } });
  const q = provider.buildQuery("(around:500,50.1,30.1,50.2,30.2)", { categories: ["fast_food"], nameVariants: ["McDonald's"] }, 20);
  assert.match(q, /^\[out:json\]\[timeout:15\];\(/);
  assert.match(q, /nwr\["amenity"="fast_food"\]\["name"~"McDonald\.\?s",i\]\(around:500,50\.1,30\.1,50\.2,30\.2\);/);
  assert.match(q, /\["brand"~"McDonald\.\?s",i\]/);
  assert.match(q, /out center tags 20;$/);
  assert.equal(overpassRegexLiteral(["a.b", "c(d)"]), "a\\\\.b|c\\\\(d\\\\)");
  assert.throws(() => provider.buildQuery("(around:1,0,0)", {}, 5), /needs a searchable category or a name/);
});

test("Overpass: parses nodes and way centers, keeps opening_hours, drops unnamed, tags osm-online", async () => {
  let sentBody = "";
  const fetchImpl: FetchLike = async (_url, init) => {
    sentBody = init.body;
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({
        elements: [
          { type: "node", id: 101, lat: 50.41, lon: 30.70, tags: { amenity: "fuel", name: "WOG", brand: "WOG", opening_hours: "24/7" } },
          { type: "way", id: 202, center: { lat: 50.40, lon: 30.72 }, tags: { amenity: "fuel", "name:uk": "ОККО", name: "OKKO" } },
          { type: "node", id: 303, lat: 50.39, lon: 30.73, tags: { amenity: "fuel" } },
        ],
      }),
    };
  };
  const provider = new OverpassPlaceSearchProvider({ endpoint: "https://overpass.example/api/interpreter", fetchImpl });
  const pois = await provider.searchAround({ lat: 50.41, lon: 30.70 }, 3000, { categories: ["fuel"] });
  assert.ok(sentBody.startsWith("data="));
  assert.deepEqual(pois.map((p) => [p.id, p.name, p.category, p.source]), [
    ["osm:n101", "WOG", "fuel", "osm-online"],
    ["osm:w202", "ОККО", "fuel", "osm-online"],
  ]);
  assert.equal(pois[0]!.openingHours, "24/7");
});

test("Overpass: HTTP failure throws loudly (never an empty list that reads as 'nothing there')", async () => {
  const provider = new OverpassPlaceSearchProvider({
    endpoint: "https://overpass.example/api/interpreter",
    fetchImpl: async () => ({ ok: false, status: 504, statusText: "Gateway Timeout", json: async () => null }),
  });
  await assert.rejects(() => provider.searchAround({ lat: 50, lon: 30 }, 500, { categories: ["fuel"] }), /504 Gateway Timeout/);
});
