import test from "node:test";
import assert from "node:assert/strict";
import { formatDistance, formatDuration, ordinalExit, roundDistance, spokenDistance, ukPlural } from "../src/i18n/format";

test("ukPlural: one/few/many including teens", () => {
  assert.equal(ukPlural(1), "one");
  assert.equal(ukPlural(21), "one");
  assert.equal(ukPlural(11), "many");
  assert.equal(ukPlural(3), "few");
  assert.equal(ukPlural(14), "many");
  assert.equal(ukPlural(24), "few");
  assert.equal(ukPlural(300), "many");
});

test("roundDistance: 10 m steps under 100 m, 50 m under 1 km, 0.1 km beyond", () => {
  assert.deepEqual(roundDistance(37), { value: 40, unit: "m" });
  assert.deepEqual(roundDistance(312), { value: 300, unit: "m" });
  assert.deepEqual(roundDistance(1234), { value: 1.2, unit: "km" });
  assert.deepEqual(roundDistance(15_600), { value: 16, unit: "km" });
  assert.deepEqual(roundDistance(0), { value: 10, unit: "m" });
});

test("formatDistance uses a decimal comma in Ukrainian", () => {
  assert.equal(formatDistance(1234, "uk"), "1,2 км");
  assert.equal(formatDistance(1234, "en"), "1.2 km");
  assert.equal(formatDistance(312, "uk"), "300 м");
});

test("formatDuration", () => {
  assert.equal(formatDuration(30, "uk"), "1 хв");
  assert.equal(formatDuration(12 * 60, "uk"), "12 хв");
  assert.equal(formatDuration(65 * 60, "uk"), "1 год 5 хв");
  assert.equal(formatDuration(120 * 60, "en"), "2 h");
});

test("spokenDistance: grammatical Ukrainian forms", () => {
  assert.equal(spokenDistance(300, "uk"), "300 метрів");
  assert.equal(spokenDistance(1500, "uk"), "1,5 кілометра");
  assert.equal(spokenDistance(2000, "uk"), "2 кілометри");
  assert.equal(spokenDistance(5000, "uk"), "5 кілометрів");
  assert.equal(spokenDistance(21_000, "uk"), "21 кілометр");
});

test("ordinalExit", () => {
  assert.equal(ordinalExit(2, "uk"), "другий");
  assert.equal(ordinalExit(3, "en"), "third");
  assert.equal(ordinalExit(12, "uk"), "12");
});
