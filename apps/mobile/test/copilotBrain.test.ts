import test from "node:test";
import assert from "node:assert/strict";
import { answer, detectIntent, detectKind, directionWords, greeting, matchDescription, proactiveInsights, type CopilotWorld } from "../src/ai/copilotBrain";

function world(over: Partial<CopilotWorld> = {}): CopilotWorld {
  return {
    lang: "uk",
    now: new Date(2026, 8, 24, 21, 30).getTime(),
    gps: { state: "NORMAL", accuracyM: 5, lastFixAgeS: 1, positionMode: "GNSS", uncertaintyM: null, hasPosition: true },
    alert: { active: false },
    places: {
      shelter: [{ id: "s1", name: "Станція метро «Золоті ворота»", kind: "shelter", location: { lat: 50.4488, lon: 30.5135 }, distanceM: 180, bearingDeg: 45 }],
      fuel: [{ id: "f1", name: "ОККО", kind: "fuel", location: { lat: 50.45, lon: 30.52 }, distanceM: 1700, bearingDeg: 180, address: "вул. Соборна 12" }],
      pharmacy: [{ id: "p1", name: "Подорожник", kind: "pharmacy", location: { lat: 50.449, lon: 30.514 }, distanceM: 220, bearingDeg: 270 }],
    },
    landmarks: [
      { name: "ОККО", kindLabel: "АЗС", location: { lat: 50.45, lon: 30.52 }, onRoute: true, alongM: 1200 },
      { name: "Сільпо", kindLabel: "супермаркет", location: { lat: 50.451, lon: 30.521 }, onRoute: false },
    ],
    remote: false,
    ...over,
  };
}

test("intents: Ukrainian, Russian and English phrasings", () => {
  assert.equal(detectIntent("Де найближче укриття?"), "place");
  assert.equal(detectIntent("где укрытие"), "place");
  assert.equal(detectIntent("куди бігти?"), "place");
  assert.equal(detectIntent("Де я зараз?"), "whereAmI");
  assert.equal(detectIntent("где я"), "whereAmI");
  assert.equal(detectIntent("я заблукав"), "lost");
  assert.equal(detectIntent("що робити без GPS"), "noGps");
  assert.equal(detectIntent("глушать сигнал"), "noGps");
  assert.equal(detectIntent("Що з GPS?"), "gps");
  assert.equal(detectIntent("яка зараз тривога"), "alert");
  assert.equal(detectIntent("шахеди летять?"), "alert");
  assert.equal(detectIntent("людина поранена, кров"), "emergency");
  assert.equal(detectIntent("що далі?"), "routeNext");
  assert.equal(detectIntent("коли приїдемо"), "eta");
  assert.equal(detectIntent("бачу АЗС ОККО"), "describe");
  assert.equal(detectIntent("вижу сильпо"), "describe");
  assert.equal(detectIntent("веди до Фастова"), "navigateTo");
  assert.equal(detectIntent("привіт"), "greet");
});

test("intents: short stems never fire inside other words", () => {
  assert.notEqual(detectIntent("потребую аптеку"), "noGps");
  assert.equal(detectIntent("потребую аптеку"), "place");
  assert.notEqual(detectIntent("де якась аптека"), "whereAmI");
});

test("kinds: categories from everyday words", () => {
  assert.equal(detectKind("де заправка"), "fuel");
  assert.equal(detectKind("треба ліки"), "pharmacy");
  assert.equal(detectKind("зняти готівку"), "atm");
  assert.equal(detectKind("де пункт незламності"), "resilience");
  assert.equal(detectKind("хочу поїсти"), "food");
});

test("directions in Ukrainian", () => {
  assert.equal(directionWords(45, "uk"), "на північний схід");
  assert.equal(directionWords(180, "uk"), "на південь");
  assert.equal(directionWords(350, "uk"), "на північ");
});

test("shelter answer: distance, direction, walking time and a route button", () => {
  const r = answer("де укриття?", world());
  assert.match(r.text, /Найближче укриття/);
  assert.match(r.text, /200 м на північний схід/);
  assert.match(r.text, /≈2 хв пішки/);
  assert.match(r.text, /перевіряйте на місці/);
  assert.equal(r.actions[0]?.kind, "route");
  assert.equal((r.actions[0] as { mode: string }).mode, "walk");
});

test("no shelters: honest answer with what to do, never 'safe'", () => {
  const r = answer("где укрытие", world({ places: {}, placeStates: { shelter: "ready" } }));
  assert.match(r.text, /немає укриттів/);
  assert.doesNotMatch(r.text, /безпечн/);
});

test("still searching or no connection is never reported as 'no shelters'", () => {
  assert.match(answer("де укриття", world({ places: {}, placeStates: { shelter: "loading" } })).text, /Ще шукаю/);
  assert.match(answer("де укриття", world({ places: {}, placeStates: { shelter: "error" } })).text, /Не вдалося завантажити/);
});

test("no resilience points: points to the official bot", () => {
  const r = answer("пункт незламності", world({ places: {}, placeStates: { resilience: "ready" } }));
  assert.equal(r.actions[0]?.kind, "open");
});

test("emergency: 112 and 103 buttons first", () => {
  const r = answer("поранений, потрібна швидка", world());
  assert.deepEqual(r.actions.slice(0, 2).map((a) => a.kind), ["call", "call"]);
});

test("alert active: says where, offers the nearest shelter and never promises safety", () => {
  const w = world({ alert: { active: true, scope: "district", reasons: ["Дронова загроза (жовтий рівень)"] } });
  const r = answer("що з тривогою", w);
  assert.match(r.text, /у вашому районі/);
  assert.match(r.text, /Дронова загроза/);
  assert.match(r.text, /Найближче укриття/);
  assert.ok(r.actions.some((a) => a.kind === "route"));
  const insights = proactiveInsights(w);
  assert.equal(insights[0]?.tone, "critical");
});

test("where am I without GPS on a route: between landmarks, with confirm-turn", () => {
  const w = world({
    gps: { state: "LOST", accuracyM: null, lastFixAgeS: 240, positionMode: "DEAD_RECKONING", uncertaintyM: 120, hasPosition: true },
    route: { destination: "Фастів", mode: "car", remainingM: 5200, etaS: 480, offRoute: false, next: { action: "поверніть праворуч", distanceM: 300, cue: "після АЗС «ОККО»" }, behind: "церква", ahead: "АЗС «ОККО»", landmarkCount: 14 },
  });
  const r = answer("де я?", w);
  assert.match(r.text, /між «церква» і «АЗС «ОККО»»/);
  assert.match(r.text, /±120 м/);
  assert.ok(r.actions.some((a) => a.kind === "confirmTurn"));
});

test("what next without GPS: landmark, no exact metres, confirm button", () => {
  const w = world({
    gps: { state: "LOST", accuracyM: null, lastFixAgeS: 60, positionMode: "DEAD_RECKONING", uncertaintyM: 80, hasPosition: true },
    route: { destination: "Фастів", mode: "car", remainingM: 5200, etaS: 480, offRoute: false, next: { action: "поверніть праворуч", road: "вулицю Шевченка", distanceM: 300, cue: "після АЗС «ОККО»" }, landmarkCount: 14 },
  });
  const r = answer("что дальше", w);
  assert.match(r.text, /^Скоро, після АЗС «ОККО», поверніть праворуч на вулицю Шевченка\./);
  assert.ok(r.actions.some((a) => a.kind === "confirmTurn"));
});

test("describe what you see: matches brand names across languages and offers 'I'm here'", () => {
  const hits = matchDescription("вижу заправку окко", world().landmarks);
  assert.equal(hits[0]?.name, "ОККО");
  const r = answer("бачу АЗС ОККО", world({ route: { destination: "Фастів", mode: "car", remainingM: 1, etaS: 1, offRoute: false, landmarkCount: 2 } }));
  assert.match(r.text, /Схоже, ви біля «ОККО»/);
  assert.equal(r.actions[0]?.kind, "correctPosition");
  assert.equal(answer("бачу якийсь паркан", world()).actions[0]?.kind, "ask");
});

test("greeting summarises the situation", () => {
  const g = greeting(world({ alert: { active: false, otherDistricts: 2 }, userName: "Олег" }));
  assert.match(g.text, /^Добрий вечір, Олег\./);
  assert.match(g.text, /ще в 2 районах/);
  assert.match(g.text, /GPS стабільний \(±5 м\)/);
});

test("unknown question: honest, with the current situation and suggestions", () => {
  const r = answer("розкажи анекдот", world());
  assert.equal(r.intent, "unknown");
  assert.ok(r.actions.length >= 2);
});

test("GPS weakening: the co-pilot names the reason and warns about a possible loss", () => {
  const w = world({ gps: { state: "DEGRADED", accuracyM: 38, lastFixAgeS: 1, positionMode: "GNSS", uncertaintyM: null, hasPosition: true, trendText: "точність погіршується" } });
  const r = answer("що з GPS?", w);
  assert.match(r.text, /слабшає \(точність погіршується\) — можлива втрата/);
});

test("standard commands are understood: Куди далі? Через скільки поворот? Статус GPS?", () => {
  for (const q of ["Куди далі?", "куда дальше", "Через скільки поворот?", "через сколько поворот", "Скільки до повороту?", "Коли поворот?"]) {
    assert.equal(detectIntent(q), "routeNext", q);
  }
  assert.equal(detectIntent("Статус GPS?"), "gps");
  const w = world({ route: { destination: "ОККО", mode: "car", remainingM: 2400, etaS: 420, offRoute: false, next: { action: "поверніть праворуч", road: "Вознесенський узвіз", distanceM: 650, cue: "біля аптеки «Фармація»" }, landmarkCount: 67 } });
  assert.match(answer("Через скільки поворот?", w).text, /^Через 650 м, біля аптеки «Фармація», поверніть праворуч на Вознесенський узвіз\./);
});

test("answers are instant: every standard command is computed in under 20 ms", () => {
  const w = world({ route: { destination: "ОККО", mode: "car", remainingM: 2400, etaS: 420, offRoute: false, next: { action: "поверніть праворуч", distanceM: 650 }, landmarkCount: 67 } });
  for (const q of ["Куди далі?", "Через скільки поворот?", "Де я?", "Статус GPS?", "Де укриття?", "Що з тривогою?", "Коли приїдемо?"]) {
    answer(q, w);
    // CPU time of this process (not wall clock): other load on the machine
    // (parallel test files, sync daemons) must not fail the test.
    let ms = Infinity;
    for (let b = 0; b < 5; b++) {
      const c0 = process.cpuUsage();
      for (let i = 0; i < 10; i++) answer(q, w);
      const c = process.cpuUsage(c0);
      ms = Math.min(ms, (c.user + c.system) / 1000 / 10);
    }
    assert.ok(ms < 20, `${q}: ${ms.toFixed(2)} ms`);
  }
});
