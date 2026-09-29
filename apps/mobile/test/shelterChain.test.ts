// Programme part 4: the whole shelter chain — source records → the one
// nearest-first search (the map's list AND the navigator's world) → the
// navigator's answer. A shelter 300 m away must come first even when a
// shelter 30+ km away (another town) is listed first by the source; a demo
// record is never shown as real.
import test from "node:test";
import assert from "node:assert/strict";
import { destinationPoint, haversineMeters } from "@navia/core";
import { rankWorldPlaces } from "../src/places/worldPlaces";
import { placesFor } from "../src/places/categories";
import { Navigator } from "../src/ai/navigator/navigator";
import { buildSnapshot } from "../src/ai/navigator/snapshot";
import { sevenSituations, worldFrom } from "./support/navigatorScenarios";

const here = { lat: 50.4501, lon: 30.5234 }; // Майдан Незалежності
const near = destinationPoint(here, 45, 300);
const far = { lat: 49.7989, lon: 30.1153 }; // Біла Церква, ~80 km

const source = [
  { id: "far", name: "Укриття в Білій Церкві", location: far, origin: "online" as const, source: "data.gov.ua" },
  { id: "demo", name: "Демо-укриття", location: destinationPoint(here, 0, 50), origin: "demo" as const },
  { id: "near", name: "Укриття біля Майдану", location: near, origin: "online" as const, source: "Kyiv City open data" },
];

test("300 m vs 30+ km: the near one is first — in the navigator's world and in the map's list", () => {
  assert.ok(haversineMeters(here, far) > 30_000);
  const world = rankWorldPlaces({ shelter: { places: source } } as never, here, false);
  const names = (world.shelter ?? []).map((p) => `${p.name} ${Math.round(p.distanceM)} м`);
  console.log("navigator world:", names.join(" | "));
  assert.equal(world.shelter?.[0]?.id, "near");
  assert.ok(Math.abs(world.shelter![0]!.distanceM - 300) < 2);
  assert.ok(!(world.shelter ?? []).some((p) => p.id === "demo"), "real mode: the demo record is not there");
  // The map's list: the same shared search (placesFor → nearestFirst).
  const map = placesFor("shelter", source.filter((p) => p.origin !== "demo").map((p) => ({ ...p, category: "shelter" as const, distanceM: 0, source: "OpenStreetMap" as const, origin: "online" as const })), here);
  assert.deepEqual(map.map((p) => p.id), (world.shelter ?? []).map((p) => p.id), "map and navigator: one order");
});

test("demo mode keeps demo records and marks them demo in the snapshot", async () => {
  const world = rankWorldPlaces({ shelter: { places: source } } as never, here, true);
  assert.equal(world.shelter?.[0]?.id, "demo");
  const sit = (await sevenSituations()).find((s) => s.key === "alert")!;
  const w = worldFrom(sit.state, { alert: { active: true, scope: "district" } });
  w.places = { ...w.places, shelter: world.shelter };
  const snap = buildSnapshot({ state: sit.state, world: w, isDemo: true });
  assert.equal(snap.fields.nearbyShelters[0]?.source, "demo");
  assert.equal(snap.fields.nearbyShelters.find((p) => p.label === "Укриття біля Майдану")?.source, "real");
});

test("the navigator's alert answer names the 300 m shelter, and «is it the nearest» lists the order", async () => {
  const sit = (await sevenSituations()).find((s) => s.key === "alert")!;
  const pos = sit.state.position!.position;
  const src = [
    { id: "far", name: "Укриття в Білій Церкві", location: far, origin: "online" as const },
    { id: "near", name: "Укриття біля дому", location: destinationPoint(pos, 90, 300), origin: "online" as const },
  ];
  const w = worldFrom(sit.state, { alert: { active: true, scope: "district" } });
  w.places = { ...w.places, shelter: rankWorldPlaces({ shelter: { places: src } } as never, pos, false).shelter };
  const snap = buildSnapshot({ state: sit.state, world: w });
  const nav = new Navigator();
  const a = nav.ask("Объявлена тревога, где ближайшее укрытие?", snap);
  console.log("answer:", a.text.replace(/\n/g, " ⏎ "));
  assert.match(a.text, /Укриття біля дому — 300 м/);
  const b = nav.ask("Это точно ближайшее?", snap);
  console.log("is it the nearest:", b.text.replace(/\n/g, " ⏎ "));
  assert.equal(b.intent, "shelterWhy");
  assert.ok(b.text.indexOf("Укриття біля дому") < b.text.indexOf("Білій Церкві"), "listed nearest first");
});
