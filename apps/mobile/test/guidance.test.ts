import test from "node:test";
import assert from "node:assert/strict";
import { GuidanceAnnouncer, alertPhrase, instructionPhrase, stageFor, streetAccusative } from "../src/voice/guidance";

test("streetAccusative: feminine street nouns and agreeing adjectives", () => {
  assert.equal(streetAccusative("вулиця Хрещатик"), "вулицю Хрещатик");
  assert.equal(streetAccusative("Велика Васильківська вулиця"), "Велику Васильківську вулицю");
  assert.equal(streetAccusative("площа Льва Толстого"), "площу Льва Толстого");
  assert.equal(streetAccusative("проспект Перемоги"), "проспект Перемоги");
  assert.equal(streetAccusative("Бориспільське шосе"), "Бориспільське шосе");
});

test("instructionPhrase: natural Ukrainian prompts", () => {
  assert.equal(
    instructionPhrase({ id: "a", maneuver: "right", roadName: "вулиця Шевченка" }, 300, "uk"),
    "Через 300 метрів поверніть праворуч на вулицю Шевченка.",
  );
  assert.equal(
    instructionPhrase({ id: "b", maneuver: "roundabout", roadName: "", roundaboutExit: 2 }, 200, "uk"),
    "Через 200 метрів на круговому русі другий з’їзд.",
  );
  assert.equal(instructionPhrase({ id: "c", maneuver: "left", roadName: "" }, null, "uk"), "Поверніть ліворуч.");
  assert.equal(instructionPhrase({ id: "d", maneuver: "arrive", roadName: "" }, 10, "uk"), "Ви прибули.");
  assert.equal(instructionPhrase({ id: "e", maneuver: "right", roadName: "Main St" }, 1500, "en"), "In 1.5 kilometers turn right onto Main St.");
});

test("stageFor: car and walking thresholds", () => {
  assert.equal(stageFor(2000, "car"), null);
  assert.equal(stageFor(1200, "car"), "far");
  assert.equal(stageFor(350, "car"), "prepare");
  assert.equal(stageFor(60, "car"), "now");
  assert.equal(stageFor(50, "walk"), "prepare");
});

test("GuidanceAnnouncer: each stage once, never backwards on GPS jitter", () => {
  const a = new GuidanceAnnouncer();
  const step = { id: "s1", maneuver: "right" as const, roadName: "вулиця Хрещатик" };
  assert.equal(a.next(step, 2000, "car", "uk"), null);
  assert.match(a.next(step, 1200, "car", "uk") ?? "", /^Через 1,2 кілометра/);
  assert.equal(a.next(step, 1190, "car", "uk"), null);
  assert.match(a.next(step, 390, "car", "uk") ?? "", /^Через 400 метрів/);
  assert.equal(a.next(step, 420, "car", "uk"), null, "jitter back into the far band stays silent");
  assert.equal(a.next(step, 70, "car", "uk"), "Поверніть праворуч на вулицю Хрещатик.");
  assert.equal(a.next(step, 40, "car", "uk"), null);
});

test("cautiousPhrase: no distance while the position is estimated", () => {
  const { cautiousPhrase } = require("../src/voice/guidance") as typeof import("../src/voice/guidance");
  assert.equal(cautiousPhrase({ id: "x", maneuver: "right", roadName: "вулиця Хрещатик" }, "uk"), "Приготуйтеся: скоро поверніть праворуч на вулицю Хрещатик. Коли повернете — натисніть «Я вже повернув».");
});

test("alertPhrase names the scope and ending", () => {
  assert.match(alertPhrase(true, "region", "uk"), /по всій області/);
  assert.match(alertPhrase(true, undefined, "uk"), /у вашому районі/);
  assert.match(alertPhrase(false, "district", "en"), /ended/);
});
