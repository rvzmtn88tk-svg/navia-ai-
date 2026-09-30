// The co-pilot's self-check of its final words against what was done this
// turn, and the shape of spoken answers (no lists, no SKIP, not too long).
import test from "node:test";
import assert from "node:assert/strict";
import { capSpokenWords, neuterize, replyCorrection, toSpeakable, type ToolTraceEntry } from "../src/copilot/copilot";

const t = (tool: string, isError = false): ToolTraceEntry => ({ tool, input: {}, isError, result: {}, ms: 1 });

test("a yes/no about an action that was never proposed is sent back to the model", () => {
  assert.match(replyCorrection("Змінюю маршрут на ваш дім у Бориспілі — 30 км. Погоджуєтесь?", [t("find_destination")], false, "Забудь Бориспіль, їдемо додому") ?? "", /Call the action tool now/);
  assert.match(replyCorrection("Додати обидві зупинки?", [t("search_along_route")], false, "Розплануй: заправка, потім вода") ?? "", /Call the action tool now/);
  // The driver only asked to find: offering "Додати?" without a proposal is the design.
  assert.equal(replyCorrection("McDonald's за 18 хвилин. Додати як зупинку?", [t("search_along_route")], false, "Знайди McDonald's"), null);
  // A pending proposal exists: asking is right.
  assert.equal(replyCorrection("Додати ОККО? Це +1 хвилина.", [t("add_stop")], true), null);
  // A choice between options is not a confirmation.
  assert.equal(replyCorrection("ОККО за 11 хвилин або WOG за 24. Яку обрати?", [t("search_along_route")], false), null);
  assert.equal(replyCorrection("Додати ОККО чи WOG?", [t("search_along_route")], false), null);
});

test("«done» without an action tool is sent back; with one it passes", () => {
  assert.match(replyCorrection("Додано. Зупинимось на Aroma Kava.", [], false) ?? "", /was not done this turn/);
  assert.equal(replyCorrection("Зупинку Aroma Kava додано.", [t("add_stop")], false), null);
  assert.equal(replyCorrection("Нагадування встановлено.", [t("set_reminder")], false), null);
  assert.match(replyCorrection("Скасовано.", [t("remove_stop", true)], false) ?? "", /was not done this turn/);
});

test("an empty answer after tools asks for the result; plain answers pass", () => {
  assert.match(replyCorrection("", [t("set_reminder")], false) ?? "", /result/);
  assert.equal(replyCorrection("", [], false), null);
  assert.equal(replyCorrection("До Борисполя 31 км, 48 хвилин.", [], false), null);
});

test("spoken shape: lists become sentences, SKIP is never read, long answers are cut at a sentence", () => {
  assert.equal(toSpeakable("Є три ресторани:\n1. Пузата Хата за 3,2 км.\n2. Козак за 18 км.\nТуди?"), "Є три ресторани: Пузата Хата за 3,2 км. Козак за 18 км. Туди?");
  assert.equal(toSpeakable("SKIP\n(Я NAVIA — навігаційний помічник.)"), "(Я NAVIA — навігаційний помічник.)");
  const long = Array.from({ length: 12 }, (_, i) => `Речення номер ${i + 1} має кілька слів.`).join(" ") + " Додати зупинку?";
  const cut = capSpokenWords(long, 30);
  assert.ok(cut.split(/\s+/).length <= 36, cut);
  assert.ok(cut.endsWith("Додати зупинку?"), "the question to the driver is kept");
  assert.equal(capSpokenWords("Коротко.", 30), "Коротко.");
});

test("other shapes of an unproposed yes/no are caught too; clarifying questions are not", () => {
  const read = [t("find_destination")];
  for (const q of ["Встанови маршрут на Бориспіль-центр? Це 31 кілометр.", "Дім буде проміжною зупинкою перед Бориспілем. Гаразд?", "Так переспрямовуюсь в аеропорт?"]) {
    assert.match(replyCorrection(q, read, false, "поїхали туди") ?? "", /Call the action tool now/, q);
  }
  for (const q of ["Де ваш дім? Скажіть адресу чи назву району.", "Куди саме в Броварах?", "Яку заправку обрати?"]) assert.equal(replyCorrection(q, read, false, "поїхали додому"), null, q);
});

test("\u00abdone\u00bb about an action that is only proposed is sent back", () => {
  const pendingAdd: ToolTraceEntry = { tool: "add_stop", input: {}, isError: false, result: { status: "awaiting_user_confirmation" }, ms: 1 };
  assert.match(replyCorrection("WOG додано.", [pendingAdd], true) ?? "", /was not done this turn/);
});

test("reply language from the driver's words", async () => {
  const { replyLanguage } = await import("../src/copilot/copilot");
  assert.equal(replyLanguage("Where can I get coffee on the way?"), "en");
  assert.equal(replyLanguage("Найди заправку по дороге."), "ru");
  assert.equal(replyLanguage("Сколько ещё ехать?"), "ru");
  assert.equal(replyLanguage("Знайди заправку по дорозі."), "uk");
  assert.equal(replyLanguage("Домой"), "uk");
  assert.equal(replyLanguage("кава срчно"), "uk");
  assert.equal(replyLanguage("Окей, find me a gas station, але тільки не SOCAR"), "uk");
});

test("NAVIA about itself in the neuter, at the start of a sentence only", async () => {
  const { neuterize } = await import("../src/copilot/copilot");
  assert.equal(neuterize("Знайшов три АЗС. Найближча — ОККО."), "Знайдено три АЗС. Найближча — ОККО.");
  assert.equal(neuterize("Добре. Додала зупинку WOG."), "Добре. Додано зупинку WOG.");
  assert.equal(neuterize("Зрозумів, їдемо далі."), "Зрозуміло, їдемо далі.");
  // Not at the start: someone else did it.
  assert.equal(neuterize("Водій знайшов заправку."), "Водій знайшов заправку.");
  assert.equal(neuterize("WOG справа, почти без обʼїзду, відкрита."), "WOG справа, майже без обʼїзду, відкрита.");
  assert.equal(neuterize("Заправка почти рядом."), "Заправка почти рядом.");
});

test("Russian replies speak in the neuter too", () => {
  assert.equal(neuterize("Понял, вы у станции Харківська."), "Понятно, вы у станции Харківська.");
  assert.equal(neuterize("Хорошо, вернулся к предыдущей позиции."), "Хорошо, возвращаю к предыдущей позиции.");
  assert.equal(neuterize("Нашла две заправки."), "Найдено две заправки.");
});
