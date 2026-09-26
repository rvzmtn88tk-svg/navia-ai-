// Fix Б: a tap on a base-map POI (OpenMapTiles "poi" layer) gives the place
// card real data — its own name or an honest "name unknown", the kind, the
// distance from the user — the same for every category.
import test from "node:test";
import assert from "node:assert/strict";
import { haversineMeters } from "@navia/core";
import { pickPoi, poiFromFeature } from "../src/map/basemapPoi";

const here = { lat: 50.4488, lon: 30.5135 };
const pt = (lat: number, lon: number, props: Record<string, unknown>, id?: number) => ({ type: "Feature", id, geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

test("every category gets a card with name, kind and real distance", () => {
  const cases = [
    { f: pt(50.4492, 30.5140, { class: "shop", subclass: "supermarket", name: "Сільпо", "name:uk": "Сільпо", rank: 10 }), kind: "Супермаркет", cat: "shop", name: "Сільпо" },
    { f: pt(50.4480, 30.5150, { class: "pharmacy", subclass: "pharmacy", name: "Аптека Доброго Дня", rank: 12 }), kind: "Аптека", cat: "pharmacy", name: "Аптека Доброго Дня" },
    { f: pt(50.4470, 30.5100, { class: "fuel", subclass: "fuel", name: "WOG", rank: 5 }), kind: "АЗС", cat: "fuel", name: "WOG" },
    { f: pt(50.4510, 30.5160, { class: "hospital", subclass: "hospital", name: "Лікарня №1", rank: 3 }), kind: "Лікарня", cat: "hospital", name: "Лікарня №1" },
    { f: pt(50.4500, 30.5120, { class: "school", subclass: "school", name: "Ліцей №171", rank: 8 }), kind: "Школа", cat: "other", name: "Ліцей №171" },
  ];
  for (const c of cases) {
    const p = poiFromFeature(c.f, here)!;
    assert.equal(p.name, c.name);
    assert.equal(p.kindLabel, c.kind);
    assert.equal(p.category, c.cat);
    assert.ok(Math.abs(p.distanceM - haversineMeters(here, p.location)) < 0.01);
    console.log(`${c.kind.padEnd(12)} → «${p.name}», ${Math.round(p.distanceM)} m, ${p.sourceDetail}`);
  }
});

test("no name in the data: honest 'name unknown', never invented", () => {
  const p = poiFromFeature(pt(50.449, 30.514, { class: "shop", subclass: "convenience", rank: 20 }), here)!;
  assert.equal(p.name, "Продуктовий магазин (назва невідома)");
  assert.equal(p.nameKnown, false);
  const odd = poiFromFeature(pt(50.449, 30.514, { class: "shop", subclass: "tobacco", rank: 20 }), here)!;
  assert.equal(odd.kindLabel, "Магазин", "unknown subclass falls back to the class");
  assert.equal(poiFromFeature({ geometry: { type: "LineString", coordinates: [] }, properties: { class: "shop" } }, here), null);
});

test("several icons under the finger: the one nearest to the tap", () => {
  const a = pt(50.4490, 30.5136, { class: "cafe", subclass: "cafe", name: "Ближче", rank: 5 });
  const b = pt(50.4494, 30.5139, { class: "cafe", subclass: "cafe", name: "Далі", rank: 5 });
  assert.equal(pickPoi([b, a], { lat: 50.44901, lon: 30.51361 }, here)!.name, "Ближче");
});
