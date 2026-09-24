import test from "node:test";
import assert from "node:assert/strict";
import { alongRoute, landmarkCue, landmarkForTurn, landmarkKind, landmarksAround, project, type RawLandmark } from "../src/navigation/landmarks";
import { cautiousPhrase, instructionPhrase } from "../src/voice/guidance";
import { crossings, poiCategory, routeTiles, tileLandmarkKind } from "../src/providers/vectorTiles";

// Route: 500 m north, then 500 m east (a right turn at ~500 m).
const O = { lat: 50.0, lon: 30.0 };
const north = { lat: 50.0 + 500 / 110_540, lon: 30.0 };
const east = { lat: north.lat, lon: 30.0 + 500 / (111_320 * Math.cos(50 * Math.PI / 180)) };
const route = [O, north, east];
const offsetEast = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat, lon: p.lon + m / (111_320 * Math.cos(50 * Math.PI / 180)) });
const offsetNorth = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 110_540, lon: p.lon });

test("project: distance along, lateral offset and side", () => {
  const p = project(offsetEast({ lat: O.lat + 200 / 110_540, lon: O.lon }, 15), route);
  assert.ok(Math.abs(p.alongM - 200) < 2);
  assert.ok(Math.abs(p.offsetM - 15) < 1);
  assert.equal(p.side, "right");
});

test("landmarkForTurn: traffic lights at the turn beat a shop before it", () => {
  const raw: RawLandmark[] = [
    { id: "s", kind: "shop", name: "Київхліб", location: offsetEast(offsetNorth(O, 440), 12) },
    { id: "t", kind: "traffic_signals", name: null, location: offsetEast(north, 3) },
  ];
  const s = landmarkForTurn(alongRoute(raw, route), 500);
  assert.equal(s?.landmark.id, "t");
  assert.equal(landmarkCue(s!, "uk"), "на світлофорі");
});

test("landmarkForTurn: a fuel station passed before the turn reads 'після АЗС'", () => {
  const raw: RawLandmark[] = [{ id: "f", kind: "fuel", name: "ОККО", location: offsetEast(offsetNorth(O, 440), 20) }];
  const s = landmarkForTurn(alongRoute(raw, route), 500);
  assert.equal(s?.relation, "before");
  assert.equal(landmarkCue(s!, "uk"), "після АЗС «ОККО»");
});

test("landmarkForTurn: nameless shops and far-away places are ignored", () => {
  const raw: RawLandmark[] = [
    { id: "a", kind: "shop", name: null, location: offsetEast(north, 10) },
    { id: "b", kind: "fuel", name: "WOG", location: offsetEast(offsetNorth(O, 250), 10) },
  ];
  assert.equal(landmarkForTurn(alongRoute(raw, route), 500), null);
});

test("instructionPhrase and cautiousPhrase name the landmark", () => {
  const raw: RawLandmark[] = [{ id: "f", kind: "fuel", name: "ОККО", location: offsetEast(offsetNorth(O, 440), 20) }];
  const cue = landmarkForTurn(alongRoute(raw, route), 500);
  const step = { id: "1", maneuver: "right" as const, roadName: "вулиця Шевченка" };
  assert.equal(instructionPhrase(step, 300, "uk", cue), "Через 300 метрів, після АЗС «ОККО», поверніть праворуч на вулицю Шевченка.");
  assert.match(cautiousPhrase(step, "uk", cue), /^Приготуйтеся: скоро, після АЗС «ОККО», поверніть праворуч на вулицю Шевченка\. Коли повернете/);
  const lights = landmarkForTurn(alongRoute([{ id: "t", kind: "traffic_signals", name: null, location: north }], route), 500);
  assert.equal(instructionPhrase(step, 200, "uk", lights), "Через 200 метрів на світлофорі поверніть праворуч на вулицю Шевченка.");
});

test("landmarksAround: last passed and next landmark for 'where am I' without GPS", () => {
  const raw: RawLandmark[] = [
    { id: "1", kind: "church", name: null, location: offsetEast(offsetNorth(O, 100), 20) },
    { id: "2", kind: "fuel", name: "ОККО", location: offsetEast(offsetNorth(O, 400), 20) },
  ];
  const around = landmarksAround(alongRoute(raw, route), 250);
  assert.equal(around.behind?.id, "1");
  assert.equal(around.ahead?.id, "2");
});

test("invisible things are never landmarks", () => {
  assert.equal(landmarkKind({ amenity: "post_office", name: "Поштомат Розетка #1005" }), null);
  assert.equal(landmarkKind({ historic: "memorial", memorial: "plaque", name: "А. Г. Петрицький" }), null);
  assert.equal(landmarkKind({ highway: "traffic_signals" }), "traffic_signals");
  assert.equal(tileLandmarkKind({ cls: "post", sub: "post_office", name: "Поштомат" }), null);
  assert.equal(tileLandmarkKind({ cls: "fuel", sub: "fuel", name: "ОККО" }), "fuel");
});

test("vector tiles: category mapping, route tiles and rail/river crossings", () => {
  assert.equal(poiCategory({ cls: "pharmacy", sub: "pharmacy" }), "pharmacy");
  assert.equal(poiCategory({ cls: "shop", sub: "chemist" }), "pharmacy");
  assert.equal(poiCategory({ cls: "fuel", sub: "charging_station" }), "charger");
  assert.equal(poiCategory({ cls: "grocery", sub: "supermarket" }), "shop");
  assert.ok(routeTiles(route).length >= 1);
  const rail = { cls: "rail", name: null, points: [offsetEast(offsetNorth(O, 300), -50), offsetEast(offsetNorth(O, 300), 50)] };
  const found = crossings(route, [rail]);
  assert.equal(found.length, 1);
  assert.ok(Math.abs(project(found[0]!.at, route).alongM - 300) < 3);
});
