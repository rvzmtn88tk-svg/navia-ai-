// Routing between the on-device navigator (situation questions) and the
// tool-calling trip co-pilot (doing things with the trip).
import test from "node:test";
import assert from "node:assert/strict";
import { wantsLocatingCopilot, wantsTripCopilot, yesNo } from "../src/ai/tripCopilot";
import { understand } from "../src/ai/navigator/intents";
import { CONTROL } from "./support/controlQuestions";

test("trip actions go to the trip co-pilot", () => {
  for (const q of ["Знайди АЗС по дорозі", "заїдемо на каву по дорозі", "додай зупинку в Броварах", "поїхали без платних доріг", "уникай трас", "додому", "веди мене додому", "на роботу",
    "нагадай через 20 хвилин заправитись", "запам'ятай що я не люблю WOG", "скасуй останню зупинку", "маршрут через Бровари", "давай інший маршрут", "найди заправку по пути", "take me home"]) {
    assert.ok(wantsTripCopilot(q, true), q);
  }
});

test("needs on the way go to the trip co-pilot only while a route is active", () => {
  assert.ok(wantsTripCopilot("хочу кави", true));
  assert.ok(wantsTripCopilot("бензин закінчується, треба заправитись", true));
  assert.ok(!wantsTripCopilot("хочу кави", false));
  // "Where is the nearest …" stays with the navigator (what is around, instantly).
  assert.ok(!wantsTripCopilot("де найближча АЗС", true));
  assert.ok(!wantsTripCopilot("где ближайшая аптека", true));
});

test("situation questions stay with the on-device navigator", () => {
  for (const c of CONTROL) assert.ok(!wantsTripCopilot(c.q, true), c.q);
  for (const q of ["де я", "що з GPS", "де укриття", "скільки ще їхати", "мені страшно", "що з тривогою", "повтори"]) assert.ok(!wantsTripCopilot(q, true), q);
  // and the navigator still understands them itself
  assert.equal(understand("де я").intent, "whereAmI");
});

test("yes / no to a pending proposal", () => {
  for (const y of ["так", "Так, додай", "да", "давай", "ок", "yes"]) assert.equal(yesNo(y), "yes", y);
  for (const n of ["ні", "Ні, не треба", "нет", "не треба", "скасуй"]) assert.equal(yesNo(n), "no", n);
  for (const x of ["так а скільки ще їхати?".slice(0, 0) + "скільки ще їхати", "де я", "таксі"]) assert.equal(yesNo(x), null, x);
});

test("GPS lost during a trip: talk about where we are goes to the reasoning co-pilot (by state, not wording)", () => {
  const lost = { routeActive: true, positionMode: "DEAD_RECKONING", gnss: "LOST" };
  const healthy = { routeActive: true, positionMode: "GNSS", gnss: "NORMAL" };
  const phrases = ["Пропал навигатор, что делать?", "Вижу Фору, а за ней перекрёсток", "Что-то сбился опять, куда дальше?",
    "Вижу станцию метро, хз какая, а напротив магазин Днипро-М", "Я проехал поворот или нет?", "Почему ты думаешь что я тут?", "Харківська"];
  for (const q of phrases) assert.ok(wantsLocatingCopilot(understand(q).intent, lost, false), q);
  // Shelters and alerts too (the co-pilot has get_safety_info); only the emergency flow stays instant and local.
  for (const q of ["де укриття", "що з тривогою"]) assert.ok(wantsLocatingCopilot(understand(q).intent, lost, false), q);
  assert.ok(!wantsLocatingCopilot("emergency", lost, false));
  // Healthy GPS and no locating dialogue: nothing changes.
  assert.ok(!wantsLocatingCopilot(understand("Вижу Фору").intent, healthy, false));
  // An answer to the co-pilot's "which station?" belongs to that dialogue even if GPS came back.
  assert.ok(wantsLocatingCopilot(understand("Харківська").intent, healthy, true));
  // No route: nothing to guide along.
  assert.ok(!wantsLocatingCopilot(understand("де я").intent, { routeActive: false, positionMode: null, gnss: "LOST" }, false));
});
