// Fix 5/10: "nearest shelter" must be the nearest one, not a far shelter from
// the bundled oblast dataset (Васильків) returned because OpenStreetMap was
// given only 1.5 s to answer. Same search for resilience points.
import test from "node:test";
import assert from "node:assert/strict";
import { haversineMeters } from "@navia/core";
import { NearbyPlacesProvider, setPlacesStorageForTests, type NearbyPlace } from "../src/providers/NearbyPlacesProvider";
import { setOfflinePlacesStorageForTests } from "../src/offline/offlinePlaces";
import { nearestShelter, placesFor } from "../src/places/categories";

// Боярка, вул. Білогородська (inside the Kyiv bounding box, outside the city).
const USER = { lat: 50.3290, lon: 30.2960 };
// A point `m` metres north of the user.
const north = (m: number) => ({ lat: USER.lat + m / 111_320, lon: USER.lon });
const NEAR = north(300);

type Handler = (url: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
function installFetch(handler: Handler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = await handler(url, init);
    if (init?.signal?.aborted) throw new Error("aborted");
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const delay = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
});

test("nearest shelter: a 300 m OpenStreetMap shelter beats a 10 km Васильків shelter, even when OSM needs 3 s", async () => {
  setPlacesStorageForTests(null);
  setOfflinePlacesStorageForTests(null);
  const restore = installFetch(async (url, init) => {
    if (url.includes("gisserver.kyivcity.gov.ua")) return { status: 200, body: { features: [] } }; // city layer: nothing here
    if (url.includes("overpass")) {
      await delay(3000, init?.signal);
      return { status: 200, body: { elements: [{ type: "node", id: 777, lat: NEAR.lat, lon: NEAR.lon, tags: { amenity: "shelter", shelter_type: "bomb_shelter", name: "Укриття ліцею" } }] } };
    }
    return { status: 404, body: {} };
  });
  try {
    const t0 = Date.now();
    const r = await new NearbyPlacesProvider().searchCategory(USER, "shelter", { includeKyivOfficialData: true, force: true });
    const first = nearestShelter(r.places, USER)!;
    const far = r.places.find((p) => p.source === "data.gov.ua");
    console.log(`answer in ${Date.now() - t0} ms: nearest ${Math.round(first.distanceM)} m «${first.name}» [${first.source}]; also found ${r.places.length - 1} more, e.g. ${far ? `${Math.round(far.distanceM)} m «${far.name}» (${far.sourceDetail})` : "—"}; unavailable: ${r.unavailable.join(",") || "none"}`);
    assert.equal(first.name, "Укриття ліцею");
    assert.ok(Math.abs(first.distanceM - 300) < 2, `${first.distanceM} m`);
    assert.ok(Math.abs(haversineMeters(USER, first.location) - first.distanceM) < 1, "distance is the real haversine distance from the user");
  } finally {
    restore();
  }
});

test("nearest shelter is measured from where the user is NOW, not where the list was loaded", () => {
  const loadedAt = north(20_000); // list loaded 20 km away (earlier in the trip)
  const places: NearbyPlace[] = [
    { id: "a", name: "Було поруч", category: "shelter", location: north(20_100), distanceM: 100, source: "OpenStreetMap", origin: "online" },
    { id: "b", name: "Поруч зараз", category: "shelter", location: north(300), distanceM: haversineMeters(loadedAt, north(300)), source: "OpenStreetMap", origin: "online" },
  ];
  const first = nearestShelter(places, USER)!;
  assert.equal(first.name, "Поруч зараз");
  assert.ok(Math.abs(first.distanceM - 300) < 2);
  assert.deepEqual(placesFor("shelter", places, USER).map((p) => Math.round(p.distanceM)), [north(300), north(20_100)].map((q) => Math.round(haversineMeters(USER, q))));
});

// Real КМДА answers recorded 2026-09-26 around Голосіївський проспект
// (layer 0 «Укриття», layer 1 «Пункти обігріву» = пункти незламності).
import { readFileSync } from "node:fs";
import { join } from "node:path";
const HOLOSIIV = { lat: 50.3920, lon: 30.5070 };
const kmda = (layer: 0 | 1) => JSON.parse(readFileSync(join(__dirname, `fixtures/kmda-layer${layer}-holosiiv.json`), "utf8"));

function kmdaFetch(osmDelayMs: number) {
  return installFetch(async (url, init) => {
    if (url.includes("gisserver.kyivcity.gov.ua")) return { status: 200, body: kmda(url.includes("/MapServer/1/") ? 1 : 0) };
    if (url.includes("overpass")) { await delay(osmDelayMs, init?.signal); return { status: 200, body: { elements: [] } }; }
    return { status: 404, body: {} };
  });
}

test("resilience points near me (Київ, real КМДА data): not empty, nearest first, real distances", async () => {
  setPlacesStorageForTests(null);
  const restore = kmdaFetch(200);
  try {
    const r = await new NearbyPlacesProvider().searchCategory(HOLOSIIV, "resilience", { includeKyivOfficialData: true, force: true });
    assert.ok(r.places.length >= 10, `${r.places.length} found`);
    for (const [i, p] of r.places.entries()) {
      assert.equal(p.category, "resilience");
      assert.ok(Math.abs(haversineMeters(HOLOSIIV, p.location) - p.distanceM) < 1, `${p.name}: distance is real`);
      if (i > 0) assert.ok(p.distanceM >= r.places[i - 1]!.distanceM, "sorted by distance");
    }
    console.log(`resilience near Голосіїв: ${r.places.length} points; nearest: ${r.places.slice(0, 5).map((p) => `${Math.round(p.distanceM)} m «${p.name}»`).join(", ")} [${r.places[0]!.sourceDetail}]`);
    const strict = await new NearbyPlacesProvider().searchCategory(HOLOSIIV, "resilience", { includeKyivOfficialData: true, force: true, radiusM: 1000 });
    assert.ok(strict.places.length > 0 && strict.places.every((p) => p.distanceM <= 1000), "strict 1 km radius");
    console.log(`  within 1 km: ${strict.places.length}, farthest ${Math.round(strict.places.at(-1)!.distanceM)} m`);
  } finally {
    restore();
  }
});

test("the same nearest-first search answers «nearest shelter» and «resilience points near me»", async () => {
  setPlacesStorageForTests(null);
  const restore = kmdaFetch(200);
  try {
    const provider = new NearbyPlacesProvider();
    const [sh, rs] = await Promise.all([
      provider.searchCategory(HOLOSIIV, "shelter", { includeKyivOfficialData: true, force: true }),
      provider.searchCategory(HOLOSIIV, "resilience", { includeKyivOfficialData: true, force: true }),
    ]);
    const { nearestFirst } = await import("@navia/core");
    const shelter = nearestShelter(sh.places, HOLOSIIV)!;
    assert.equal(shelter.id, nearestFirst(sh.places, HOLOSIIV)[0]!.id);
    const { nearestResilience } = await import("../src/places/categories");
    assert.equal(nearestResilience(rs.places, HOLOSIIV)!.id, nearestFirst(rs.places, HOLOSIIV)[0]!.id);
    console.log(`Голосіїв: nearest shelter ${Math.round(shelter.distanceM)} m «${shelter.name}»; nearest resilience point ${Math.round(nearestResilience(rs.places, HOLOSIIV)!.distanceM)} m`);
  } finally {
    restore();
  }
});

test("bundled oblast shelters: points geocoded to another place (85 km from their community) are dropped", async () => {
  const { plausibleShelters } = await import("../src/providers/openDataShelters");
  const b = JSON.parse(readFileSync(join(__dirname, "../assets/data/kyiv-oblast-shelters.json"), "utf8")) as { shelters: { lat: number; lon: number; publisher: string; address: string }[] };
  const kept = plausibleShelters(b.shelters);
  const dropped = b.shelters.filter((s) => !kept.includes(s));
  console.log(`bundled: ${b.shelters.length}, kept ${kept.length}, dropped ${dropped.length}: ${dropped.map((s) => `${s.publisher.split(" ")[0]} «${s.address}»`).join("; ")}`);
  assert.ok(dropped.some((s) => /Новосілки/.test(s.address) && /Кагарлицька/.test(s.publisher)));
  assert.ok(dropped.length <= 3 && dropped.every((s) => /Кагарлицька/.test(s.publisher)), "only clear outliers");
});

test("co-pilot: when only a far shelter is known and a source did not answer, it says so", async () => {
  const { answer } = await import("../src/ai/copilotBrain");
  const far = { id: "v", name: "Найпростіше укриття", kind: "shelter" as const, location: north(9800), distanceM: 9800 };
  const base = { lang: "uk" as const, now: Date.now(), gps: { state: "NORMAL" as const, accuracyM: 5, lastFixAgeS: 1, positionMode: "GNSS" as const, uncertaintyM: null, hasPosition: true }, landmarks: [], remote: false };
  const partial = answer("де найближче укриття?", { ...base, places: { shelter: [far] }, placeStates: { shelter: "ready" }, placeGaps: { shelter: ["OpenStreetMap"] } });
  console.log(partial.text.split("\n").join(" / "));
  assert.match(partial.text, /OpenStreetMap зараз не відповідає — поруч можуть бути ближчі/);
  const complete = answer("де найближче укриття?", { ...base, places: { shelter: [far] }, placeStates: { shelter: "ready" } });
  assert.doesNotMatch(complete.text, /не відповідає/);
});
