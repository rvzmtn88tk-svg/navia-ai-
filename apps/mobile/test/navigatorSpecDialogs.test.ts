// The example dialogs of the programme (part 2.3), 3+ per category, as tests:
// each question in its situation must get the right kind of answer, with
// the snapshot's real values (or an honest reason when there are none).
import test from "node:test";
import assert from "node:assert/strict";
import { Navigator } from "../src/ai/navigator/navigator";
import { formatDistance } from "../src/i18n/format";
import { sevenSituations, type Scenario } from "./support/navigatorScenarios";

type Case = { cat: string; sit: string; q: string; intents: string[]; check?: (text: string, s: Scenario) => void; before?: string };
const d = (m: number) => formatDistance(m, "uk");

const CASES: Case[] = [
  // А. signal status
  { cat: "А", sit: "driving", q: "Какой сейчас сигнал?", intents: ["gpsStatus"], check: (t, s) => assert.match(t, new RegExp(`±${Math.round(s.snapshot.gnss.accuracyM!)} м`)) },
  { cat: "А", sit: "driving", q: "Ты вообще знаешь где я?", intents: ["confidence", "whereAmI"], check: (t) => assert.match(t, /достовірна|Ви тут/) },
  { cat: "А", sit: "degraded", q: "Почему карта дёргается?", intents: ["gpsStatus"], check: (t) => assert.match(t, /нестабільний/) },
  // Б. signal loss / degradation
  { cat: "Б", sit: "lost", q: "Пропал сигнал, что делать?", intents: ["signalLost"], check: (t) => assert.match(t, /втрачено .*тому[\s\S]*рахунком шляху/) },
  { cat: "Б", sit: "lost", q: "А если сигнал совсем пропадёт надолго?", intents: ["signalLost"], check: (t) => assert.match(t, /м за хвилину|невідомо без даних про швидкість/) },
  { cat: "Б", sit: "degraded", q: "Сигнал плохой но ещё есть", intents: ["signalLost", "gpsStatus"], check: (t) => assert.match(t, /нестабільний|точність/) },
  // В. route
  { cat: "В", sit: "driving", q: "Куда дальше?", intents: ["routeNext"], check: (t, s) => assert.ok(t.includes(d(s.snapshot.route!.next!.distanceM!))) },
  { cat: "В", sit: "driving", q: "Далеко ещё?", intents: ["eta"], check: (t, s) => assert.ok(t.includes(d(s.snapshot.route!.remainingM))) },
  { cat: "В", sit: "driving", q: "Почему ты меня туда ведёшь?", intents: ["routeWhy"], check: (t) => assert.match(t, /найшвидший[\s\S]*порівняти/) },
  // Г. safety and alert
  { cat: "Г", sit: "alert", q: "Тревога, что делать?", intents: ["alert", "shelter", "status"], check: (t, s) => assert.ok(t.includes(s.snapshot.places.shelter![0]!.name)) },
  { cat: "Г", sit: "alert", q: "Это точно ближайшее укрытие?", intents: ["shelterWhy"], check: (t) => assert.match(t, /відсортовані за відстанню[\s\S]*Перше —/) },
  { cat: "Г", sit: "alert", q: "Где ближайшее укрытие?", intents: ["shelter"], check: (t, s) => assert.ok(t.includes(d(s.snapshot.places.shelter![0]!.distanceM))) },
  // Д. off route
  { cat: "Д", sit: "offroute", q: "Я сбился с пути?", intents: ["reroute", "onRoute"], check: (t) => assert.match(t, /Так, ви зійшли/) },
  { cat: "Д", sit: "driving", q: "Я сбился с пути?", intents: ["reroute", "onRoute"], check: (t) => assert.match(t, /на маршруті/) },
  { cat: "Д", sit: "offroute", q: "Перестрой маршрут", intents: ["reroute"] },
  // Е. meta
  { cat: "Е", sit: "alert", before: "Где ближайшее укрытие?", q: "Почему ты так ответил?", intents: ["explain"], check: (t, s) => assert.ok(t.includes(s.snapshot.places.shelter![0]!.name) && /з даних NAVIA на \d\d:\d\d/.test(t)) },
  { cat: "Е", sit: "driving", before: "Куда дальше?", q: "повтори", intents: ["repeat"], check: (t, s) => assert.ok(t.includes(d(s.snapshot.route!.next!.distanceM!))) },
  { cat: "Е", sit: "driving", q: "Откуда ты это знаешь?", intents: ["explain"] },
  // Ж. no data
  { cat: "Ж", sit: "driving", q: "Какая пробка на дороге?", intents: ["noData"], check: (t) => assert.match(t, /не отримує даних про трафік[\s\S]*без урахування трафіку/) },
  { cat: "Ж", sit: "driving", q: "Будет дождь?", intents: ["noData"] },
  { cat: "Ж", sit: "driving", q: "Где камеры?", intents: ["noData"] },
  // З. emotion
  { cat: "З", sit: "alert", q: "мене страшно шо робити", intents: ["emotion"], check: (t) => assert.match(t, /Розумію[\s\S]*Тривога[\s\S]*Зараз одне/) },
  { cat: "З", sit: "lost", q: "Мне страшно", intents: ["emotion"], check: (t) => assert.match(t, /GPS немає, але маршрут ведеться/) },
  { cat: "З", sit: "driving", q: "Я панікую", intents: ["emotion"], check: (t) => assert.match(t, /Зараз одне/) },
  // И. offline
  { cat: "И", sit: "driving", q: "Нет интернета, что теперь", intents: ["offline"], check: (t) => assert.match(t, /офлайн-пакет/i) },
  { cat: "И", sit: "driving", q: "Без інтернету карта працює?", intents: ["offline"] },
  { cat: "И", sit: "driving", q: "Зник мобільний інтернет", intents: ["offline"] },
  // К. anything else: honest refusal with the reason
  { cat: "К", sit: "driving", q: "Напиши вірш", intents: ["unknown", "noData"], check: (t) => assert.match(t, /не можу|не маю|немає/i) },
  { cat: "К", sit: "driving", q: "Скільки буде два плюс два?", intents: ["unknown", "noData"] },
  { cat: "К", sit: "driving", q: "Tell me a joke", intents: ["noData", "unknown"] },
];

test("programme example dialogs (2.3): right kind of answer, real values", async () => {
  const sits = new Map((await sevenSituations()).map((s) => [s.key, s]));
  for (const c of CASES) {
    const s = sits.get(c.sit)!;
    const nav = new Navigator();
    if (c.before) nav.ask(c.before, s.snapshot);
    const r = nav.ask(c.q, s.snapshot);
    assert.ok(c.intents.includes(r.intent), `${c.cat} «${c.q}» [${c.sit}] → ${r.intent}: ${r.text}`);
    try { c.check?.(r.text, s); } catch (e) { throw new Error(`${c.cat} «${c.q}» [${c.sit}]: ${r.text}\n${(e as Error).message}`); }
  }
});
