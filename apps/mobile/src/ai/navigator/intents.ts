// NAVIA navigator — LAYER 2: intent classifier (by meaning, not by phrase).
// The question is folded (uk/ru letter variants, case, punctuation), split
// into words, and every intent collects a score from its cues: word stems
// and short phrases in Ukrainian, Russian, surzhyk and English, matched with
// tolerance for one typo in longer words ("сигнл", "поворт", "укритя").
// Combinations add meaning ("сигнал" + "пропав" = the signal is gone,
// "якщо" + "сигнал" = what if it drops). The best-scoring intent wins; no
// score → the classic co-pilot or an honest "can't tell".
// Deterministic, no network, < 1 ms. Pure; unit-tested.
import { detectIntent, detectKind, fold, type PlaceKind } from "../copilotBrain";
import { EXAMPLES } from "./examples";

export type NavigatorIntent =
  | "repeat"          // "повтори"
  | "explain"         // "чому ти так відповів?"
  | "emergency"       // injured, 112
  | "signalLost"      // GPS is gone / jammed / what if it drops
  | "gpsStatus"       // what's with GPS / accuracy
  | "onRoute"         // am I on the right road
  | "reroute"         // I left the route / what if I get lost off it
  | "routeNext"       // what next / how far to the turn
  | "eta"             // how far / how long / when do we arrive
  | "whereAmI"        // where am I / I'm lost
  | "shelter"         // nearest shelter
  | "alert"           // air alert status
  | "status"          // overall situation
  | "place"           // other place categories (fuel, pharmacy, resilience point…)
  | "noData"          // traffic, weather, cameras… — data NAVIA does not have
  | "smalltalk"       // "як справи", "дякую", "ок"
  | "classic"         // describe / navigate to / landmarks / help — the classic co-pilot
  | "unknown";

type Cue = [stem: string, weight: number];
const cue = (w: number, ...stems: string[]): Cue[] => stems.map((s) => [fold(s), w]);
/** Cues matched only exactly (no typo tolerance): short everyday words that
 * a typo would turn into something else ("корок" ≠ "короче"). */
const exact = (w: number, ...stems: string[]): Cue[] => stems.map((s) => [`=${fold(s)}`, w]);

const CUES: Partial<Record<NavigatorIntent, Cue[]>> = {
  repeat: [...exact(7, "повтори", "повтор", "ще раз", "еще раз", "не розчув", "не расслишал", "не почув", "не услишал", "say again", "repeat")],
  explain: cue(6, "чому ти", "почему ты", "чого ти", "чего ты", "why did you", "why do you", "звідки ти знаєш", "откуда ты знаешь", "звідки знаєш", "откуда знаешь", "how do you know", "на основі чого", "на основе чего", "звідки дані", "откуда данные", "чому так", "почему так", "поясни відповід", "объясни ответ", "поясни чому", "объясни почему", "звідки інформац", "откуда информац", "з чого ти взяв", "с чего ты взял"),
  signalLost: cue(6, "без gps", "без сигнал", "без джипиес", "без жпс", "без спутник", "без супутник", "реб", "рэб", "глуш", "заглуш", "jamming", "jammed", "no gps", "no signal", "lost signal", "signal lost", "gps lost", "спуф", "spoof", "підмін", "подмен", "не ловит", "не ловить"),
  gpsStatus: [
    ...cue(8, "статус gps", "стан gps", "статус gnss", "стан сигналу", "состояние gps", "gps ok", "is gps ok", "gps нормальн", "gps працює", "gps работает"),
    ...cue(3, "gps", "джипиес", "джіпіес", "жпс", "gnss", "глонас", "точніст", "точност", "accuracy", "геолокац", "геопозиц"),
    ...cue(2, "сигнал", "signal", "спутник", "супутник", "satellit"),
  ],
  routeNext: [
    ...cue(6, "to the turn", "до повороту", "до поворота", "до наступного повороту", "до следующего поворота"),
    ...cue(5, "що далі", "шо далі", "что дальше", "шо дальше", "что дальше будет", "куди далі", "куда дальше", "далі куди", "дальше куда", "what next", "whats next", "next turn", "наступний поворот", "следующий поворот", "наступн маневр", "следующ маневр", "де поворот", "где поворот", "коли поворот", "когда поворот", "через скільки поворот", "через сколько поворот", "скільки до повороту", "сколько до поворота", "куди повертат", "куда поворачив", "куди звертат", "куда сворачив", "куди їхати", "куда ехать", "куди йти", "куда идти", "куди зараз", "куда сейчас", "де звертат", "где сворачив", "куди мені", "куда мне"),
    ...cue(3, "поворот", "повернут", "повертат", "поворачив", "звернут", "свернут", "звертат", "сворачив", "маневр", "развязк", "розвязк", "turn", "exit", "налево", "направо", "ліворуч", "праворуч", "прямо"),
    ...cue(1, "далі", "дальше", "next"),
  ],
  eta: [
    ...cue(5, "коли приїд", "когда приед", "коли будем", "когда будем", "скільки їхати", "сколько ехать", "скільки йти", "сколько идти", "скільки залиш", "сколько остал", "далеко ще", "далеко еще", "ще далеко", "еще далеко", "how long", "how far", "скоро приїд", "скоро приед", "довго ще", "долго еще", "скільки км", "сколько км", "скільки кілометр", "сколько километр", "скільки часу", "сколько времени", "коли доїд", "когда доед", "о котрій", "во сколько", "скільки лишил", "скоко остал", "скок остал"),
    ...cue(3, "приїд", "приед", "доїд", "доед", "arrive", "arrival", "eta", "далеко", "залишил", "осталос", "хвилин", "минут", "кілометр", "километр"),
  ],
  onRoute: [
    ...cue(6, "не збилис", "не сбилис", "не збилися", "не заблукали", "не заблудились"),
    ...cue(5, "правильно їду", "правильно еду", "правильно йду", "правильно иду", "правильно рухаюсь", "правильно двигаюсь", "правильн дорог", "правильн дороз", "правильн шлях", "правильн напрям", "правильн направлен", "верн дорог", "верно еду", "туди їду", "туда еду", "туди йду", "туда иду", "on track", "right way", "right road", "по маршруту", "за маршрутом", "на маршруті", "на маршруте", "не збився", "не сбился", "не заблукав", "не заблудился", "туди їдемо", "туда едем"),
    ...cue(2, "правильн", "верно", "вірно", "correct"),
  ],
  reroute: cue(6, "пропуст поворот", "пропущ поворот", "пропущу", "пропущ", "звернути не туди", "свернуть не туда", "съеду", "з'їду", "зїду", "не туди", "не туда", "збився", "сбился", "зіб'юсь", "собьюсь", "звернув не", "свернул не", "не там звернув", "не там свернул", "пропустив поворот", "пропустил поворот", "проїхав поворот", "проехал поворот", "перебуд", "перестро", "перерах", "пересчит", "новий маршрут", "новый маршрут", "з'їхав з маршрут", "съехал с маршрут", "зійшов з маршрут", "сошел с маршрут", "off route", "wrong turn", "wrong way", "missed the turn", "reroute", "recalculat", "відхилив", "отклонил", "збитися", "сбиться", "злетів з маршрут", "слетел с маршрут"),
  whereAmI: [
    ...cue(6, "якій я вулиц", "какой я улиц", "на якій я", "на какой я", "що це за місце", "что это за место"),
    ...cue(6, "де я", "где я", "where am i", "де ми", "где мы", "моє місце", "мое место", "моя позиц", "my location", "де знаходж", "где нахож", "на якій вулиці", "на какой улице", "що це за вулиц", "что за улиц", "мої координат", "мои координат", "заблук", "заблуд", "загубив", "потерялся", "i am lost", "im lost", "де зараз", "где сейчас"),
    ...cue(2, "позиц", "координат", "location", "місцезнаход", "местонахож"),
  ],
  shelter: [
    ...cue(6, "укритт", "укрит", "укрыт", "сховищ", "бомбосхов", "бомбоубеж", "shelter", "куди ховат", "куда прятат", "куди бігти", "куда бежать", "де сховатис", "где спрятат", "where to hide", "take cover"),
    ...cue(3, "ховат", "сховат", "прятат", "спрятат", "hide", "підвал", "подвал", "метро", "subway"),
  ],
  alert: [
    ...cue(5, "безпечн", "безопасн", "небезпечн", "опасн", "is it safe", "safe now"),
    ...cue(5, "тривог", "тревог", "air alert", "alert", "сирен", "siren", "повітрян", "воздушн"),
    ...cue(3, "ракет", "шахед", "дрон", "бпла", "обстріл", "обстрел", "вибух", "взрыв", "missile", "drone", "баліст", "баллист", "прильот", "прилет", "бомб"),
  ],
  status: [
    ...cue(5, "статус", "обстановк", "ситуац", "що відбуваєт", "что происход", "що коїться", "что творится", "як ми", "как мы", "все гаразд", "все ок", "все нормально", "усе добре", "status", "situation", "whats going on", "what s going on", "how are we", "звіт", "отчет", "доповідь", "доклад", "огляд", "обзор", "що там", "что там", "шо там"),
    ...cue(3, "взагалі", "вообще", "загалом", "в целом", "происход", "відбуваєт"),
  ],
  noData: [...exact(6, "корок", "курс", "черг", "дтп", "камер", "news", "rain", "snow", "joke", "music"), ...cue(6, "перекри", "пробк", "затор", "трафік", "трафик", "traffic", "погод", "дощ", "дожд", "сніг", "снег", "ожеледиц", "гололед", "туман", "weather", "rain", "snow", "температур", "радар", "speed camera", "штраф", "ціна бензин", "цена бензин", "ціни на пальне", "цены на топливо", "аварі", "авари", "accident", "ремонт дорог", "roadworks", "перекрит", "перекрыт", "блокпост", "checkpoint", "очеред", "новин", "новост", "news", "футбол", "анекдот", "жарт", "шутк", "joke", "пісн", "песн", "music", "музик", "рецепт", "гороскоп", "виграв", "выиграл")],
  smalltalk: [...cue(5, "як справи", "как дела", "спасибі", "спасибо", "дякую", "зрозумів", "понял", "привіт", "привет", "здрастуй", "здравству", "добрий день", "добрый день", "thanks", "thank you", "hello"), ...exact(5, "як справи", "как дела", "як ти", "как ты", "how are you", "ти хто", "ты кто", "who are you", "дякую", "спасибі", "спасибо", "thanks", "thank you", "добре", "хорошо", "зрозумів", "понял", "окей", "ok", "ок", "ясно", "мерси", "привіт", "привет", "hello", "hi", "здрастуй", "здравству", "добрий день", "добрый день", "доброго ранку", "доброе утро", "добрий вечір", "добрый вечер")],
};

/** One edit (insert, delete, replace) at most. */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  // Two neighbouring letters swapped ("сиганл", "повроот") = one typo.
  if (a.length === b.length) {
    const d = [...a].map((ch, i) => (ch !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (d.length === 2 && d[1] === d[0]! + 1 && a[d[0]!] === b[d[1]!] && a[d[1]!] === b[d[0]!]) return true;
  }
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well a word matches a stem: 1 exact/prefix, 0.6 with one typo (stems ≥ 5 letters), 0 no. */
function wordHit(word: string, stem: string): number {
  if (stem.length < 4) return word === stem ? 1 : 0;
  if (word.startsWith(stem)) return 1;
  if (stem.length < 5 || word.length < stem.length - 1) return 0;
  const typo = within1(word.slice(0, stem.length), stem) || within1(word.slice(0, stem.length + 1), stem) || within1(word.slice(0, stem.length - 1), stem);
  return typo ? 0.6 : 0;
}

/** Best match strength of a (multi-word) stem anywhere in the words. */
function phraseHit(words: string[], stem: string): number {
  const parts = stem.split(" ").filter(Boolean);
  if (parts.length === 0) return 0;
  let best = 0;
  for (let i = 0; i + parts.length <= words.length; i++) {
    let strength = 1;
    for (let k = 0; k < parts.length && strength > 0; k++) strength = Math.min(strength, wordHit(words[i + k]!, parts[k]!));
    best = Math.max(best, strength);
    if (best === 1) break;
  }
  return best;
}
const phraseHits = (words: string[], stem: string) => phraseHit(words, stem) > 0;

const list = (...stems: string[]) => stems.map(fold);
const FILLER = new Set(list("ну", "короче", "слухай", "слушай", "скажи", "бро", "підкажи", "подскажи", "швидко", "срочно", "блін", "блин", "да", "будь", "ласка", "пожалуйста", "вже", "уже", "дякую", "спасибо", "допоможи", "терміново", "ну скільки можна", "скільки", "можна"));
// Life-threatening only ("швидко!" or "допоможи" alone are not an emergency).
const EMERGENCY = list("швидка", "раненые", "раненых", "поранені", "поранених", "нужна скорая", "потрібна швидка", "поранен", "ранен", "ранил", "кров", "кровотеч", "без свідом", "без сознан", "не дихає", "не дышит", "швидку", "швидка допомог", "швидкої", "скорую", "скорая", "103", "112", "sos", "пожеж", "пожар", "emergency", "injured", "bleeding", "ambulance", "людині погано", "человеку плохо", "серцем", "сердцем", "інсульт", "инсульт", "інфаркт", "инфаркт", "дтп з постраждал", "есть раненые", "є поранені");
const SIGNAL = list("сигнал", "gps", "джипиес", "джіпіес", "жпс", "gnss", "навігац", "навигац", "спутник", "супутник", "signal", "геолокац", "зв'язок зі супутн");
const GONE = list("не бачить", "не видит", "не бачу", "не вижу", "не находит", "не знаходить", "пропа", "зник", "исчез", "нема", "немає", "нет", "нету", "втрат", "потер", "lost", "gone", "dropped", "died", "глуш", "jam", "відвал", "отвал", "вмер", "сдох", "впав", "упал", "слаб", "погір", "ухудш", "не працю", "не работ", "не ловит", "не ловить", "зникне", "пропаде", "пропадет");
const IF = list("якщо", "если", "раптом", "вдруг", "if", "what if", "коли зникне", "когда пропадет", "а як", "а как");
const LOST_ROUTE = list("маршрут", "дорог", "шлях", "путь", "пути", "route", "way", "заблук", "заблуд", "зіб", "собью", "собьюс", "збиюс");

const KIND_CUES: [kind: PlaceKind, canonical: string, stems: string[]][] = [
  ["resilience", "пункт незламності", list("незламн", "несокруш", "обігрів", "обогрев", "зарядити телефон", "зарядить телефон", "де світло", "где свет", "resilience", "warming")],
  ["charger", "зарядна станція", list("електрозаряд", "электрозаряд", "зарядна станц", "зарядная станц", "charging", "зарядка для авто")],
  ["fuel", "АЗС", list("заправ", "азс", "пальн", "бензин", "дизел", "fuel", "petrol", "gas station", "топлив")],
  ["pharmacy", "аптека", list("аптек", "ліки", "лекарств", "pharmacy", "drugstore", "chemist")],
  ["hospital", "лікарня", list("лікарн", "больниц", "травмпункт", "поликлин", "поліклін", "hospital", "clinic")],
  ["atm", "банкомат", list("банкомат", "банк", "готівк", "наличн", "atm", "cash")],
  ["water", "питна вода", list("питн", "попити", "попить", "drinking water")],
  ["food", "кафе", list("поїсти", "поесть", "їжа", "кафе", "ресторан", "перекус", "food", "eat", "cafe")],
  ["shop", "магазин", list("магазин", "продукт", "супермаркет", "shop", "store", "grocery")],
];

/** Place category of a question, tolerant to one typo; with a canonical word. */
export function placeKindOf(question: string): { kind: PlaceKind; canonical: string } | null {
  const words = fold(question).split(" ").filter(Boolean);
  let best: { kind: PlaceKind; canonical: string; hit: number } | null = null;
  for (const [kind, canonical, stems] of KIND_CUES) {
    const hit = Math.max(...stems.map((st) => phraseHit(words, st)));
    if (hit > (best?.hit ?? 0)) best = { kind, canonical, hit };
  }
  return best ? { kind: best.kind, canonical: best.canonical } : null;
}

/** Scores for every intent (exported for the tests). */
export function scores(question: string): Partial<Record<NavigatorIntent, number>> {
  const words = fold(question).split(" ").filter(Boolean);
  const out: Partial<Record<NavigatorIntent, number>> = {};
  for (const [intent, cues] of Object.entries(CUES) as [NavigatorIntent, Cue[]][]) {
    let total = 0;
    for (const [stem, w] of cues) total += w * (stem.startsWith("=") ? (phraseHit(words, stem.slice(1)) === 1 ? 1 : 0) : phraseHit(words, stem));
    if (total > 0) out[intent] = total;
  }
  const hasAny = (l: string[]) => l.some((s) => phraseHits(words, s));
  // The signal is (or may get) gone: a signal word with a loss word or a "what if".
  if (hasAny(SIGNAL) && (hasAny(GONE) || hasAny(IF))) out.signalLost = (out.signalLost ?? 0) + 7;
  // "What if I get lost / leave the route".
  // A "what if" about getting lost is about the plan, not about where I am now.
  if (hasAny(IF) && hasAny(LOST_ROUTE) && !hasAny(SIGNAL)) { out.reroute = (out.reroute ?? 0) + 10; delete out.whereAmI; }
  // "Where am I" beats a lone "on the route".
  if ((out.whereAmI ?? 0) >= 6 && (out.onRoute ?? 0) < 5) delete out.onRoute;
  // "Як ти"/"как ты" inside a "why did you" question is not small talk.
  if ((out.explain ?? 0) > 0) delete out.smalltalk;
  return out;
}

// ——— similarity layer: character trigrams against the example bank ———

type Vec = Map<string, number>;
function trigrams(text: string): Vec {
  const v: Vec = new Map();
  for (const w of fold(text).split(" ").filter((x) => x.length > 1 && !FILLER.has(x))) {
    const t = ` ${w} `;
    for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); v.set(g, (v.get(g) ?? 0) + 1); }
  }
  return v;
}
function norm(v: Vec): number { let s = 0; for (const x of v.values()) s += x * x; return Math.sqrt(s); }
function cosine(a: Vec, na: number, b: Vec, nb: number): number {
  if (!na || !nb) return 0;
  let dot = 0;
  for (const [g, x] of a) { const y = b.get(g); if (y) dot += x * y; }
  return dot / (na * nb);
}
let bank: { intent: NavigatorIntent; v: Vec; n: number }[] | null = null;
function exampleBank() {
  bank ??= (Object.entries(EXAMPLES) as [NavigatorIntent, string[]][]).flatMap(([intent, list]) => list.map((e) => { const v = trigrams(e); return { intent, v, n: norm(v) }; }));
  return bank;
}

/** Most similar intent by example (mean of the 3 best matches per intent). */
export function similarIntent(question: string): { intent: NavigatorIntent; score: number } | null {
  const q = trigrams(question);
  const nq = norm(q);
  if (!nq) return null;
  const per = new Map<NavigatorIntent, number[]>();
  for (const e of exampleBank()) {
    const c = cosine(q, nq, e.v, e.n);
    if (c > 0) per.set(e.intent, [...(per.get(e.intent) ?? []), c]);
  }
  let best: { intent: NavigatorIntent; score: number } | null = null;
  for (const [intent, list] of per) {
    const top = list.sort((a, b) => b - a).slice(0, 3);
    const score = 0.6 * top[0]! + 0.4 * (top.reduce((a, b) => a + b, 0) / top.length);
    if (!best || score > best.score) best = { intent, score };
  }
  return best;
}

// Ties: the more urgent / more specific first.
const ORDER: NavigatorIntent[] = ["repeat", "explain", "signalLost", "shelter", "alert", "reroute", "onRoute", "routeNext", "eta", "whereAmI", "gpsStatus", "noData", "status", "smalltalk"];

export function classify(question: string): NavigatorIntent {
  const f = fold(question);
  if (!f) return "unknown";
  if (/^(ну |слушай |слухай |скажи |будь ласка |пожалуйста )?(повтори\S*|ще раз|еще раз|що ти сказав\S*|что ты сказал\S*|не розчув\S*|не расслишал\S*|не расслышал\S*|не почув\S*|не услишал\S*|не услышал\S*|repeat|say again|say that again|again)( |$)/.test(f) && f.split(" ").length <= 4) return "repeat";
  // A lone "що?" / "шо?" / "что?" / "га?" = "say that again" (fillers and emotions around it don't matter).
  const core = f.split(" ").filter((w) => !FILLER.has(w)).join(" ");
  if (/^(що|шо|что|чо|га|а|what)$/.test(core)) return "repeat";
  const classic = detectIntent(question);
  // Exact, or one typo in a long word ("кровотча", "скроая" stays unmatched below 6 letters).
  if (EMERGENCY.some((e) => { const h = phraseHit(f.split(" "), e); return h === 1 || (h > 0 && e.replace(/ /g, "").length >= 8); })) return "emergency";
  const sc = scores(question);
  let best: NavigatorIntent | null = null;
  let bestScore = 0;
  for (const intent of ORDER) {
    const v = sc[intent] ?? 0;
    if (v > bestScore) { best = intent; bestScore = v; }
  }
  // Places other than shelters (fuel, pharmacy, resilience point, …).
  const kind = detectKind(question) ?? placeKindOf(question)?.kind ?? null;
  if (kind && kind !== "shelter" && bestScore < 5) return "place";
  // Strong rule evidence wins; otherwise the example bank decides when it is
  // clearly similar; weak rule evidence is the last resort.
  const sim = similarIntent(question);
  if ((!best || bestScore < 5) && sim && sim.score >= 0.42 && (!best || sim.score >= 0.5 || sim.intent === best)) {
    if (sim.intent === "emergency" || sim.intent === "repeat" || sim.intent === "explain" || sim.intent === "noData" || sim.intent === "smalltalk" || (sc[sim.intent] ?? 0) > 0 || !best || bestScore < 3) return sim.intent;
  }
  if (best && bestScore >= 1) {
    // "Hi" or "thanks" around a real question does not make it small talk.
    if (best === "smalltalk") {
      const other = ORDER.find((i) => i !== "smalltalk" && (sc[i] ?? 0) >= 2);
      if (other) return other;
      if (kind) return kind === "shelter" ? "shelter" : "place";
    }
    return best;
  }
  if (kind) return kind === "shelter" ? "shelter" : "place";
  // A short "повтори" with a typo (only when nothing else matched).
  if (f.split(" ").length <= 4 && f.split(" ").some((w) => ["повтори", "розчув", "расслишал", "repeat"].some((st) => wordHit(w, st) > 0))) return "repeat";
  if (classic === "greet" || classic === "thanks") return "smalltalk";
  if (classic !== "unknown") return "classic";
  return "unknown";
}
