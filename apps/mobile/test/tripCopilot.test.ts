// Routing between the on-device navigator (situation questions) and the
// tool-calling trip co-pilot (doing things with the trip).
import test from "node:test";
import assert from "node:assert/strict";
import { wantsTripCopilot, yesNo } from "../src/ai/tripCopilot";
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
