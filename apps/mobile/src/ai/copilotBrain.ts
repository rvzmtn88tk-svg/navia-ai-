// NAVIA co-pilot, on-device. Understands short questions in Ukrainian,
// Russian and English and answers like a calm human navigator: what is going
// on, where things are (distance AND direction), what to do next — with
// buttons for the action (walk to the shelter, call 112, "I've turned").
// It only uses NAVIA's own live data (alert, GPS, route, landmarks, places)
// and never invents facts or calls a place safe. Works without network.
// Pure functions; unit-tested. The Claude co-pilot, when connected, gets the
// same world and these answers' actions.

import { formatClock, formatDistance, formatDuration } from "../i18n/format";

export type Lang = "uk" | "en";
export type LatLonLite = { lat: number; lon: number };

export type PlaceKind = "shelter" | "resilience" | "fuel" | "charger" | "pharmacy" | "hospital" | "atm" | "water" | "food" | "shop";

export type WorldPlace = {
  id: string;
  name: string;
  kind: PlaceKind;
  location: LatLonLite;
  distanceM: number;
  /** Compass bearing from the user, degrees. */
  bearingDeg?: number;
  address?: string;
  hours?: string;
};

export type WorldLandmark = { name: string; kindLabel: string; location: LatLonLite; onRoute: boolean; alongM?: number };

export type CopilotWorld = {
  lang: Lang;
  now: number;
  userName?: string;
  gps: {
    state: "NORMAL" | "DEGRADED" | "LOST";
    accuracyM: number | null;
    /** Seconds since the last trusted fix. */
    lastFixAgeS: number | null;
    positionMode: "GNSS" | "DEAD_RECKONING" | "MANUAL" | null;
    uncertaintyM: number | null;
    hasPosition: boolean;
    /** Early-warning reasons in words when the signal is getting worse. */
    trendText?: string;
    /** Navigator mode from the engine (navigation/navigatorMode.ts). */
    mode?: "normal" | "degraded" | "navigator";
  };
  here?: { street?: string; area?: string };
  alert?: { active: boolean | null; scope?: "district" | "city" | "region"; level?: string; reasons?: string[]; since?: number; otherDistricts?: number; area?: string };
  /** Regional threat summary, already in words ("БпЛА, крилаті ракети"). */
  regional?: { state: "reported" | "advisory" | "none" | "unavailable"; kindsText?: string };
  route?: {
    destination: string;
    mode: "car" | "walk";
    remainingM: number;
    etaS: number | null;
    offRoute: boolean;
    next?: { action: string; road?: string; distanceM: number | null; cue?: string; confirm?: string };
    then?: string;
    behind?: string;
    ahead?: string;
    landmarkCount: number;
  };
  places: Partial<Record<PlaceKind, WorldPlace[]>>;
  /** Search state per category: an empty list only means "none" when ready. */
  placeStates?: Partial<Record<PlaceKind, "idle" | "loading" | "ready" | "error">>;
  /** Sources that did not answer for a category (the list may miss closer places). */
  placeGaps?: Partial<Record<PlaceKind, string[]>>;
  /** Landmarks the user could describe seeing (route + nearby places). */
  landmarks: WorldLandmark[];
  remote: boolean;
};

export type CopilotAction =
  | { kind: "route"; label: string; place: { name: string; lat: number; lon: number }; mode: "walk" | "car" }
  | { kind: "call"; label: string; number: string }
  | { kind: "open"; label: string; url: string }
  | { kind: "search"; label: string; query: string }
  | { kind: "confirmTurn"; label: string }
  | { kind: "correctPosition"; label: string; place: { name: string; lat: number; lon: number } }
  | { kind: "safety"; label: string }
  | { kind: "ask"; label: string; question: string };

export type Intent =
  | "greet" | "help" | "about" | "thanks" | "whereAmI" | "lost" | "gps" | "noGps" | "alert" | "emergency"
  | "place" | "routeNext" | "eta" | "landmarks" | "describe" | "navigateTo" | "photo" | "unknown";

export type CopilotReply = { intent: Intent; text: string; actions: CopilotAction[]; places?: WorldPlace[] };

// ——— Text normalisation ———

/** Lower-cases and folds Ukrainian/Russian letter variants so "Сільпо" = "сильпо". */
export function fold(text: string): string {
  return text.toLocaleLowerCase("uk-UA")
    .replace(/[іїы]/g, "и").replace(/[єэ]/g, "е").replace(/ё/g, "е").replace(/ґ/g, "г").replace(/[ъ'’ʼ`"«»]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** True when a stem starts a word of the text ("аптек" ~ "аптеку"). Phrases
 * match word by word the same way. Stems under 4 letters must be whole words,
 * so "реб" (EW) is not found inside "потребую" and "де я" not in "де якась". */
function has(text: string, ...stems: string[]): boolean {
  const words = text.split(" ");
  const wordMatches = (word: string, stem: string) => (stem.length < 4 ? word === stem : word.startsWith(stem));
  return stems.some((raw) => {
    const parts = fold(raw).split(" ").filter(Boolean);
    if (parts.length === 0) return false;
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, k) => wordMatches(words[i + k]!, p))) return true;
    }
    return false;
  });
}

// ——— Intent + category detection ———

const KIND_STEMS: Record<PlaceKind, string[]> = {
  shelter: ["укритт", "укрит", "укрыт", "сховищ", "бомбосхов", "subway", "shelter", "сховатис", "сховатись", "сховат", "спрятат", "куди бігти", "куда бежать", "where to hide", "метро"],
  resilience: ["незламн", "несокруш", "обігрів", "обогрев", "зарядити телефон", "зарядить телефон", "де світло", "где свет", "resilience", "warming"],
  fuel: ["заправ", "азс", "пальн", "бензин", "дизел", "газ для авто", "fuel", "petrol", "gas station", "топлив"],
  charger: ["електрозаряд", "электрозаряд", "зарядна станц", "зарядная станц", "charging", "ev charger", "зарядка для авто"],
  pharmacy: ["аптек", "ліки", "лекарств", "pharmacy", "drugstore", "chemist"],
  hospital: ["лікарн", "больниц", "лікар", "врач", "травмпункт", "медпункт", "поликлин", "поліклін", "hospital", "clinic", "doctor", "ambulance station"],
  atm: ["банкомат", "банк", "готівк", "наличн", "atm", "cash", "гроши", "деньги"],
  water: ["вода", "воду", "попити", "попить", "питн", "water", "drink"],
  food: ["поїсти", "поесть", "їжа", "еда", "кафе", "ресторан", "перекус", "food", "eat", "cafe"],
  shop: ["магазин", "продукт", "супермаркет", "shop", "store", "grocery", "купити", "купить"],
};

export function detectKind(q: string): PlaceKind | null {
  const f = fold(q);
  // Order matters: "зарядна станція" before "банк", "укриття в метро" is a shelter.
  const order: PlaceKind[] = ["shelter", "resilience", "charger", "fuel", "pharmacy", "hospital", "atm", "water", "food", "shop"];
  for (const kind of order) if (has(f, ...KIND_STEMS[kind])) return kind;
  return null;
}

export function detectIntent(q: string): Intent {
  const f = fold(q);
  if (!f) return "unknown";
  if (has(f, "поранен", "ранен", "ранил", "кров", "кровотеч", "без свідом", "без сознан", "швидк", "скорую", "скорая", "103", "112", "101", "102", "пожеж", "пожар", "emergency", "injured", "bleeding", "ambulance", "допоможіть", "помогите", "sos")) return "emergency";
  if (has(f, "фото", "сфотограф", "камер", "photo", "picture", "camera")) return "photo";
  if (/^(бачу|вижу|я бачу|я вижу|i see|поруч|рядом|я биля|я возле|я около|стою биля|стою возле|стою у)( |$)/.test(f) || has(f, "бачу", "вижу", "i can see")) return "describe";
  if (has(f, "заблук", "загубив", "загубил", "заблуд", "потерял", "не знаю де я", "не знаю где я", "i am lost", "im lost", "i'm lost")) return "lost";
  if (has(f, "де я", "где я", "where am i", "моє місце", "мое место", "моя позиц", "my location", "мої координ", "мои координ")) return "whereAmI";
  if (has(f, "без gps", "без джипиес", "gps пропав", "gps зник", "пропал gps", "пропав сигнал", "пропал сигнал", "зник сигнал", "нет сигнала", "немає сигналу", "глуш", "заглуш", "реб", "рэб", "jamming", "jammed", "no gps", "without gps", "spoof", "спуф", "підмін", "подмен")) return "noGps";
  if (has(f, "gps", "джипиес", "джі пі ес", "джипіес", "жпс", "сигнал", "точніст", "точност", "accuracy", "signal", "gnss", "супутник", "спутник")) return "gps";
  if (detectKind(q) === "shelter") return "place";
  if (has(f, "тривог", "тревог", "alert", "сирен", "siren", "ракет", "шахед", "дрон", "бпла", "обстріл", "обстрел", "вибух", "взрыв", "missile", "drone", "балістик", "баллистик")) return "alert";
  if (detectKind(q)) return "place";
  if (has(f, "що далі", "что дальше", "куди далі", "далі куди", "куда дальше", "дальше куда", "куди зараз", "куда сейчас", "що робити далі", "куди повертат", "куда поворачив",
    "наступн поворот", "наступний поворот", "следующ поворот", "через скільки поворот", "через скилки поворот", "через сколько поворот", "скільки до поворот", "сколько до поворот",
    "коли поворот", "когда поворот", "де поворот", "где поворот", "next turn", "what next", "whats next", "how far to the turn", "куди їхати", "куда ехать", "куди йти", "куда идти")) return "routeNext";
  if (has(f, "коли приїд", "когда приед", "скільки їхати", "сколько ехать", "скільки залиш", "сколько остал", "how long", "eta", "arrive", "коли будем", "когда будем", "далеко ще", "далеко еще")) return "eta";
  if (has(f, "орієнтир", "ориентир", "landmark", "що побачу", "что увижу")) return "landmarks";
  if (/^(веди|веди мене|маршрут до|поїхали до|поехали в|поехали до|їдемо до|едем в|как доехать|як доїхати|як дістатися|как добраться|take me to|navigate to|route to)( |$)/.test(f)) return "navigateTo";
  if (has(f, "привіт", "привет", "здрастуй", "здравств", "добрий день", "добрый день", "hello", "hi ", "hey")) return "greet";
  if (has(f, "дякую", "спасибі", "спасибо", "thanks", "thank you")) return "thanks";
  if (has(f, "що ти вмієш", "что ты умеешь", "допомог", "помощь", "what can you do", "help")) return "help";
  if (has(f, "як ти працюєш", "как ты работаешь", "що таке navia", "что такое navia", "how do you work", "about navia", "навіщо", "зачем")) return "about";
  return "unknown";
}

// ——— Words ———

const DIRS_UK = ["на північ", "на північний схід", "на схід", "на південний схід", "на південь", "на південний захід", "на захід", "на північний захід"];
const DIRS_EN = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

export function directionWords(bearingDeg: number | undefined, lang: Lang): string {
  if (bearingDeg == null || !Number.isFinite(bearingDeg)) return "";
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return lang === "uk" ? DIRS_UK[i]! : `to the ${DIRS_EN[i]!}`;
}

export function walkMinutes(distanceM: number): number {
  return Math.max(1, Math.round(distanceM / 75));
}

function placeLine(p: WorldPlace, lang: Lang): string {
  const dist = formatDistance(p.distanceM, lang);
  const dir = directionWords(p.bearingDeg, lang);
  const walk = p.distanceM <= 3000 ? (lang === "uk" ? `, ≈${walkMinutes(p.distanceM)} хв пішки` : `, ≈${walkMinutes(p.distanceM)} min walk`) : "";
  const addr = p.address && p.address !== p.name ? (lang === "uk" ? ` (${p.address})` : ` (${p.address})`) : "";
  return `${p.name}${addr} — ${dist}${dir ? ` ${dir}` : ""}${walk}`;
}

const KIND_WORDS: Record<PlaceKind, { uk: [string, string, string]; en: [string, string] }> = {
  // [nominative singular, "найближч…" form, plural genitive "немає даних про …"]
  shelter: { uk: ["укриття", "Найближче укриття", "укриття"], en: ["shelter", "shelters"] },
  resilience: { uk: ["пункт незламності", "Найближчий пункт незламності", "пункти незламності"], en: ["resilience point", "resilience points"] },
  fuel: { uk: ["АЗС", "Найближча АЗС", "АЗС"], en: ["fuel station", "fuel stations"] },
  charger: { uk: ["зарядна станція", "Найближча зарядна станція", "зарядні станції"], en: ["charging station", "charging stations"] },
  pharmacy: { uk: ["аптека", "Найближча аптека", "аптеки"], en: ["pharmacy", "pharmacies"] },
  hospital: { uk: ["медзаклад", "Найближчий медзаклад", "медзаклади"], en: ["medical facility", "medical facilities"] },
  atm: { uk: ["банк чи банкомат", "Найближчий банк або банкомат", "банки й банкомати"], en: ["bank or ATM", "banks and ATMs"] },
  water: { uk: ["питна вода", "Найближча питна вода", "точки питної води"], en: ["drinking water", "drinking water points"] },
  food: { uk: ["заклад харчування", "Найближчий заклад харчування", "заклади харчування"], en: ["place to eat", "places to eat"] },
  shop: { uk: ["магазин", "Найближчий магазин", "магазини"], en: ["shop", "shops"] },
};

function greetingWord(now: number, lang: Lang): string {
  const h = new Date(now).getHours();
  if (lang === "en") return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return h < 5 ? "Доброї ночі" : h < 11 ? "Доброго ранку" : h < 17 ? "Добрий день" : h < 23 ? "Добрий вечір" : "Доброї ночі";
}

function alertWhere(scope: "district" | "city" | "region" | undefined, lang: Lang): string {
  if (lang === "en") return scope === "region" ? "across the oblast" : scope === "city" ? "in the city" : "in your district";
  return scope === "region" ? "по всій області" : scope === "city" ? "у місті" : "у вашому районі";
}

// ——— Situation pieces ———

export function alertSentence(w: CopilotWorld): string {
  const uk = w.lang === "uk";
  const a = w.alert;
  if (!a || a.active == null) return uk ? "Статус тривоги зараз невідомий — тримайте офіційні сповіщення увімкненими." : "The air-alert status is unknown right now — keep official alerts on.";
  if (a.active) {
    const since = a.since ? (uk ? ` з ${formatClock(a.since, "uk")}` : ` since ${formatClock(a.since, "en")}`) : "";
    const why = a.reasons?.length ? ` (${a.reasons.join("; ")})` : "";
    return uk ? `Зараз повітряна тривога ${alertWhere(a.scope, "uk")}${since}${why}.` : `There is an air alert ${alertWhere(a.scope, "en")}${since}${why}.`;
  }
  if (a.otherDistricts) return uk ? `У вашому районі тривоги немає, але вона триває ще в ${a.otherDistricts} районах області.` : `No alert in your district, but ${a.otherDistricts} other districts of the oblast are under alert.`;
  return uk ? "Тривоги у вашому районі немає." : "No air alert in your district.";
}

export function regionalSentence(w: CopilotWorld): string {
  const r = w.regional;
  if (!r || !r.kindsText || (r.state !== "reported" && r.state !== "advisory")) return "";
  return w.lang === "uk" ? `В області ${r.state === "reported" ? "повідомляють" : "спостерігають"}: ${r.kindsText}.` : `The oblast reports: ${r.kindsText}.`;
}

function ageWords(s: number, uk: boolean): string {
  return s < 120 ? (uk ? `${Math.max(1, Math.round(s))} с тому` : `${Math.max(1, Math.round(s))} s ago`) : (uk ? `${Math.round(s / 60)} хв тому` : `${Math.round(s / 60)} min ago`);
}

export function gpsSentence(w: CopilotWorld): string {
  const uk = w.lang === "uk";
  const g = w.gps;
  if (!g.hasPosition && g.state === "LOST") return uk ? "GPS ще не визначив вашу позицію." : "GPS has not found your position yet.";
  if (g.positionMode === "DEAD_RECKONING") {
    const since = g.lastFixAgeS != null ? (uk ? ` (останній надійний сигнал — ${ageWords(g.lastFixAgeS, true)})` : ` (last trusted fix ${ageWords(g.lastFixAgeS, false)})`) : "";
    const head = g.state === "LOST" ? (uk ? "Сигнал GPS втрачено" : "GPS signal lost") : (uk ? "Сигнал GPS ненадійний — точки відкидаю" : "The GPS signal is unreliable — I'm ignoring its fixes");
    return uk ? `${head}${since}. Я в режимі штурмана: веду за маршрутом за рахунком шляху, позиція приблизна${g.uncertaintyM ? ` (±${Math.round(g.uncertaintyM)} м)` : ""}.` : `${head}${since}. I'm in navigator mode: guiding along the route by dead reckoning; the position is approximate${g.uncertaintyM ? ` (±${Math.round(g.uncertaintyM)} m)` : ""}.`;
  }
  if (g.positionMode === "MANUAL") return uk ? "GPS недоступний — ведемо від точки, яку ви вказали." : "GPS is unavailable — guiding from the point you set.";
  if (g.state === "NORMAL") return uk ? `GPS стабільний${g.accuracyM != null ? ` (±${Math.round(g.accuracyM)} м)` : ""}.` : `GPS is stable${g.accuracyM != null ? ` (±${Math.round(g.accuracyM)} m)` : ""}.`;
  if (g.state === "DEGRADED") {
    if (g.trendText) return uk ? `Сигнал GPS слабшає (${g.trendText}) — можлива втрата. Маршрут і орієнтири збережено, я поведу і без GPS.` : `The GPS signal is weakening (${g.trendText}) and may be lost. The route and landmarks are saved; I'll guide without GPS.`;
    return uk ? "GPS нестабільний: сумнівні точки я відсіюю, позиція може бути неточною." : "GPS is unstable: I filter out suspicious fixes; the position may be off.";
  }
  const age = g.lastFixAgeS != null ? (uk ? ` Остання надійна позиція — ${ageWords(g.lastFixAgeS, true)}.` : ` Last trusted position: ${ageWords(g.lastFixAgeS, false)}.`) : "";
  return uk ? `Сигнал GPS втрачено.${age}` : `GPS signal lost.${age}`;
}

export function routeSentence(w: CopilotWorld): string {
  const r = w.route;
  if (!r) return "";
  const uk = w.lang === "uk";
  const eta = r.etaS != null ? (uk ? `, прибуття ≈ о ${formatClock(w.now + r.etaS * 1000, "uk")}` : `, arriving ≈ ${formatClock(w.now + r.etaS * 1000, "en")}`) : "";
  return uk ? `Маршрут до «${r.destination}»: залишилось ${formatDistance(r.remainingM, "uk")}${eta}.` : `Route to “${r.destination}”: ${formatDistance(r.remainingM, "en")} to go${eta}.`;
}

function nearest(w: CopilotWorld, kind: PlaceKind): WorldPlace | null {
  return w.places[kind]?.[0] ?? null;
}

function routeAction(p: WorldPlace, mode: "walk" | "car", lang: Lang): CopilotAction {
  return {
    kind: "route", mode, place: { name: p.name, lat: p.location.lat, lon: p.location.lon },
    label: lang === "uk" ? (mode === "walk" ? `Вести пішки · ${formatDistance(p.distanceM, "uk")}` : `Вести авто · ${formatDistance(p.distanceM, "uk")}`) : (mode === "walk" ? `Walk there · ${formatDistance(p.distanceM, "en")}` : `Drive there · ${formatDistance(p.distanceM, "en")}`),
  };
}

// ——— Greeting and proactive insights ———

export function greeting(w: CopilotWorld): CopilotReply {
  const uk = w.lang === "uk";
  const hello = `${greetingWord(w.now, w.lang)}${w.userName ? `, ${w.userName}` : ""}.`;
  const parts = [hello, alertSentence(w), gpsSentence(w)];
  if (w.route) parts.push(routeSentence(w));
  const shelter = nearest(w, "shelter");
  const actions: CopilotAction[] = [];
  if (w.alert?.active) {
    if (shelter) { parts.push(uk ? `Найближче укриття: ${placeLine(shelter, "uk")}.` : `Nearest shelter: ${placeLine(shelter, "en")}.`); actions.push(routeAction(shelter, "walk", w.lang)); }
    actions.push({ kind: "safety", label: uk ? "Безпека поруч" : "Safety nearby" });
  }
  parts.push(uk ? "Питайте голосом або текстом — я поруч." : "Ask by voice or text — I'm here.");
  return { intent: "greet", text: parts.join(" "), actions: [...actions, ...suggestions(w).slice(0, 3)] };
}

export type Insight = { id: string; tone: "critical" | "warning" | "calm"; text: string; actions: CopilotAction[] };

/** What the co-pilot says on its own on the map, most important first. */
export function proactiveInsights(w: CopilotWorld): Insight[] {
  const uk = w.lang === "uk";
  const out: Insight[] = [];
  const shelter = nearest(w, "shelter");
  if (w.alert?.active) {
    const text = shelter
      ? `${alertSentence(w)} ${uk ? "Найближче укриття" : "Nearest shelter"}: ${placeLine(shelter, w.lang)}.`
      : `${alertSentence(w)} ${uk ? "Даних про укриття поруч немає — прямуйте до найближчого відомого вам укриття." : "No shelter data nearby — head to the nearest shelter you know."}`;
    out.push({ id: "alert", tone: "critical", text, actions: shelter ? [routeAction(shelter, "walk", w.lang), { kind: "safety", label: uk ? "Безпека" : "Safety" }] : [{ kind: "safety", label: uk ? "Безпека" : "Safety" }] });
  }
  if (w.gps.hasPosition || w.gps.lastFixAgeS != null) {
    if (w.gps.state === "LOST" || w.gps.positionMode === "DEAD_RECKONING") {
      out.push({ id: "gps", tone: "warning", text: `${gpsSentence(w)} ${w.route ? (uk ? "Їдьте за маршрутом — я підкажу повороти за орієнтирами." : "Keep to the route — I'll call turns by landmarks.") : (uk ? "Якщо рушаєте — побудуйте маршрут: без GPS я поведу за ним." : "If you're setting off, build a route: without GPS I'll guide along it.")}`, actions: [{ kind: "ask", label: uk ? "Що робити без GPS?" : "What to do without GPS?", question: uk ? "Що робити без GPS?" : "What to do without GPS?" }] });
    } else if (w.gps.state === "DEGRADED") {
      out.push({ id: "gps", tone: "warning", text: gpsSentence(w), actions: [{ kind: "ask", label: uk ? "Чому GPS нестабільний?" : "Why is GPS unstable?", question: uk ? "Чому GPS нестабільний?" : "Why is GPS unstable?" }] });
    }
  }
  if (!w.alert?.active && w.alert?.otherDistricts) out.push({ id: "region", tone: "warning", text: `${alertSentence(w)} ${regionalSentence(w)}`.trim(), actions: [] });
  if (out.length === 0) {
    const calm = [alertSentence(w), w.gps.state === "NORMAL" ? gpsSentence(w) : ""].filter(Boolean).join(" ");
    const tail = shelter ? (uk ? ` Найближче укриття — ${formatDistance(shelter.distanceM, "uk")} ${directionWords(shelter.bearingDeg, "uk")}.` : ` Nearest shelter: ${formatDistance(shelter.distanceM, "en")} ${directionWords(shelter.bearingDeg, "en")}.`) : "";
    out.push({ id: "calm", tone: "calm", text: `${calm}${tail}`, actions: [] });
  }
  return out;
}

/** Context-aware quick questions. */
export function suggestions(w: CopilotWorld): CopilotAction[] {
  const uk = w.lang === "uk";
  const q = (label: string): CopilotAction => ({ kind: "ask", label, question: label });
  const list: CopilotAction[] = [];
  if (w.alert?.active) list.push(q(uk ? "Де найближче укриття?" : "Where is the nearest shelter?"));
  if (w.gps.state !== "NORMAL" || w.gps.positionMode === "DEAD_RECKONING") list.push(q(uk ? "Де я зараз?" : "Where am I?"), q(uk ? "Що робити без GPS?" : "What to do without GPS?"));
  if (w.route) list.push(q(uk ? "Що далі?" : "What's next?"), q(uk ? "Коли приїдемо?" : "When do we arrive?"));
  list.push(q(uk ? "Що з тривогою?" : "What about the alert?"));
  if (!w.alert?.active) list.push(q(uk ? "Де укриття?" : "Where is a shelter?"));
  list.push(q(uk ? "Де я зараз?" : "Where am I?"), q(uk ? "Де АЗС?" : "Where is fuel?"), q(uk ? "Де аптека?" : "Where is a pharmacy?"));
  const seen = new Set<string>();
  return list.filter((a) => (a.kind === "ask" && !seen.has(a.question) ? (seen.add(a.question), true) : false)).slice(0, 5);
}

// ——— Describe-what-you-see matching ———

const STOP = new Set(["бачу", "вижу", "бачимо", "видим", "поруч", "рядом", "бил", "биля", "возле", "около", "навпроти", "напротив", "стою", "я", "тут", "там", "ось", "вот", "якийсь", "какой", "то", "и", "та", "вулиц", "улиц", "вул", "the", "see", "near", "next", "to", "a", "an", "i", "am", "at"]);

function tokens(text: string): string[] {
  return fold(text).split(" ").filter((t) => t.length >= 3 && !STOP.has(t) && !STOP.has(t.slice(0, 5)));
}

function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 4 && a.slice(0, Math.max(4, n - 2)) === b.slice(0, Math.max(4, n - 2));
}

/** Known landmarks/places whose names appear in the user's description, best first. */
export function matchDescription(text: string, candidates: WorldLandmark[]): WorldLandmark[] {
  const said = tokens(text);
  if (said.length === 0) return [];
  const scored = candidates.map((c) => {
    const nameTokens = tokens(c.name);
    const kindTokens = tokens(c.kindLabel);
    let score = 0;
    for (const s of said) {
      if (nameTokens.some((n) => tokenMatch(s, n))) score += 3;
      else if (kindTokens.some((k) => tokenMatch(s, k))) score += 1;
    }
    return { c, score: score + (c.onRoute ? 0.5 : 0) };
  }).filter((x) => x.score >= 3);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.c).slice(0, 3);
}

// ——— Answers ———

function situation(w: CopilotWorld): string {
  return [alertSentence(w), gpsSentence(w)].join(" ");
}

export function answer(question: string, w: CopilotWorld): CopilotReply {
  const uk = w.lang === "uk";
  const intent = detectIntent(question);
  const ask = (label: string): CopilotAction => ({ kind: "ask", label, question: label });

  switch (intent) {
    case "emergency": {
      const hospital = nearest(w, "hospital");
      const text = uk
        ? `Якщо є загроза життю — телефонуйте 112 або 103 (швидка) зараз. Назвіть адресу або орієнтир.${hospital ? ` Найближчий медзаклад: ${placeLine(hospital, "uk")}.` : ""}`
        : `If a life is at risk, call 112 or 103 (ambulance) now and give an address or landmark.${hospital ? ` Nearest medical facility: ${placeLine(hospital, "en")}.` : ""}`;
      const actions: CopilotAction[] = [{ kind: "call", label: uk ? "Подзвонити 112" : "Call 112", number: "112" }, { kind: "call", label: uk ? "Швидка 103" : "Ambulance 103", number: "103" }];
      if (hospital) actions.push(routeAction(hospital, "car", w.lang));
      return { intent, text, actions, ...(hospital ? { places: [hospital] } : {}) };
    }

    case "place": {
      const kind = detectKind(question) ?? "shelter";
      const list = (w.places[kind] ?? []).slice(0, 3);
      const words = KIND_WORDS[kind];
      const searchState = w.placeStates?.[kind];
      if (list.length === 0 && (searchState === "loading" || searchState === "idle" || searchState === undefined)) {
        return { intent, text: uk ? `Ще шукаю ${words.uk[2]} поруч — зачекайте кілька секунд і спитайте ще раз.` : `Still searching for ${words.en[1]} nearby — ask again in a few seconds.`, actions: [ask(question)] };
      }
      if (list.length === 0 && searchState === "error") {
        const offline = kind === "shelter" ? (uk ? " Під час тривоги без даних — капітальне приміщення без вікон, подалі від скла." : " During an alert without data: a solid room without windows, away from glass.") : "";
        return { intent, text: uk ? `Не вдалося завантажити ${words.uk[2]} — схоже, немає зв'язку з картою. Спробуйте ще раз.${offline}` : `Couldn't load ${words.en[1]} — no connection to the map data. Try again.${offline}`, actions: [ask(question)] };
      }
      if (list.length === 0) {
        if (kind === "resilience") {
          return { intent, text: uk ? "У відкритих даних поруч немає пунктів незламності. Актуальні адреси дає офіційний бот «Незламність» у Telegram або Viber." : "Open data has no resilience points nearby. The official “Nezlamnist” bot on Telegram or Viber has current addresses.", actions: [{ kind: "open", label: uk ? "Бот «Незламність» (Telegram)" : "Nezlamnist bot (Telegram)", url: "https://t.me/nezlamnistbot" }] };
        }
        if (kind === "shelter") {
          return { intent, text: uk ? "У відкритих даних поруч немає укриттів (шукала до 15 км). Уточніть найближче укриття у своїй громаді або в застосунку «Дія». Під час тривоги — капітальне приміщення без вікон, подалі від скла." : "Open data lists no shelters nearby (searched up to 15 km). Check with your community or the Diia app. During an alert, stay in a solid room without windows, away from glass.", actions: [{ kind: "safety", label: uk ? "Безпека" : "Safety" }] };
        }
        return { intent, text: uk ? `Поки не бачу ${words.uk[2]} поруч у даних NAVIA. Спробуйте ще раз за хвилину — я оновлю пошук.` : `I don't see ${words.en[1]} nearby in NAVIA's data yet. Try again in a minute — I'll refresh the search.`, actions: [ask(uk ? `Де ${words.uk[0]}?` : `Where is a ${words.en[0]}?`)] };
      }
      const first = list[0]!;
      const lines = list.map((p, i) => `${i + 1}. ${placeLine(p, w.lang)}`).join("\n");
      const caution = kind === "shelter" || kind === "resilience" ? (uk ? "\nДоступність і стан перевіряйте на місці." : "\nCheck access on arrival.") : "";
      // Only a far one is known and a source did not answer: say so.
      const gaps = w.placeGaps?.[kind] ?? [];
      const partial = gaps.length > 0 && first.distanceM > 1500
        ? (uk ? `\nУвага: ${gaps.join(", ")} зараз не відповідає — поруч можуть бути ближчі. Це найближче з того, що вдалося отримати.` : `\nNote: ${gaps.join(", ")} is not answering — there may be closer ones. This is the nearest I could get.`)
        : "";
      const hours = first.hours ? (uk ? `\nГрафік «${first.name}»: ${first.hours}` : `\nHours of “${first.name}”: ${first.hours}`) : "";
      // Shelters: on foot. Fuel and chargers: by car. Others: on foot when close.
      const walk = kind === "shelter" || (kind !== "fuel" && kind !== "charger" && first.distanceM <= 1500);
      const text = uk ? `${words.uk[1]}:\n${lines}${hours}${partial}${caution}` : `Nearest ${words.en[0]}:\n${lines}${hours}${partial}${caution}`;
      const actions: CopilotAction[] = [routeAction(first, walk ? "walk" : "car", w.lang)];
      if (walk && first.distanceM > 400 && kind !== "shelter") actions.push(routeAction(first, "car", w.lang));
      if (!walk && first.distanceM <= 2500) actions.push(routeAction(first, "walk", w.lang));
      return { intent, text, actions, places: list };
    }

    case "alert": {
      const parts = [alertSentence(w), regionalSentence(w)].filter(Boolean);
      const actions: CopilotAction[] = [];
      if (w.alert?.active) {
        const shelter = nearest(w, "shelter");
        if (shelter) { parts.push(uk ? `Найближче укриття: ${placeLine(shelter, "uk")}.` : `Nearest shelter: ${placeLine(shelter, "en")}.`); actions.push(routeAction(shelter, "walk", w.lang)); }
        parts.push(uk ? "Я не бачу, куди летять цілі, і не можу обіцяти безпеку — орієнтуйтеся на офіційні сигнали." : "I can't see where targets are heading and can't promise safety — follow official signals.");
        actions.push({ kind: "safety", label: uk ? "Безпека поруч" : "Safety nearby" });
      } else {
        parts.push(uk ? "Якщо тривога почнеться — скажу голосом і покажу укриття." : "If an alert starts, I'll tell you and show shelters.");
      }
      return { intent, text: parts.join(" "), actions };
    }

    case "gps": {
      const g = w.gps;
      const why = g.state === "NORMAL" ? "" : uk
        ? " Під час тривоги GPS часто глушать або підміняють (РЕБ): точка «стрибає» або зникає. Я відкидаю неправдоподібні стрибки й не показую їх вам."
        : " During alerts GPS is often jammed or spoofed (EW): the dot jumps or disappears. I reject implausible jumps and don't show them.";
      const plan = g.state === "NORMAL" ? "" : w.route
        ? (uk ? " Маршрут збережено: якщо сигнал зникне, поведу за ним, повороти підкажу за орієнтирами — підтверджуйте їх кнопкою «Я вже повернув»." : " The route is saved: if the signal drops I'll guide along it and call turns by landmarks — confirm them with “I've turned”.")
        : (uk ? " Побудуйте маршрут, поки сигнал ще є, — я запам'ятаю його та орієнтири." : " Build a route while there is still a signal — I'll memorise it and its landmarks.");
      return { intent, text: `${gpsSentence(w)}${why}${plan}`, actions: g.state === "NORMAL" ? [] : [ask(uk ? "Де я зараз?" : "Where am I?")] };
    }

    case "noGps": {
      // First what is happening right now (from the engine), then what to do.
      const g = w.gps;
      const r = w.route;
      const lost = g.mode === "navigator" || g.state === "LOST" || g.positionMode === "DEAD_RECKONING" || g.positionMode === "MANUAL";
      const now: string[] = [];
      if (lost) {
        now.push(gpsSentence(w));
        if (r?.next && !r.offRoute) {
          const cue = r.next.cue ? (uk ? `, ${r.next.cue}` : `, ${r.next.cue}`) : "";
          const road = r.next.road ? (uk ? ` на ${r.next.road}` : ` onto ${r.next.road}`) : "";
          now.push(uk ? `Наступний маневр: ${r.next.action}${road}${cue}. Після повороту натисніть «Я вже повернув» — я уточню позицію.` : `Next: ${r.next.action}${road}${cue}. After the turn tap “I've turned” so I can correct the position.`);
        } else if (!r) {
          now.push(uk ? "Активного маршруту немає — без GPS я можу вести лише за маршрутом, збудованим заздалегідь. Скажіть, що бачите навколо (вулицю, вивіску), — я порівняю з картою." : "There is no active route — without GPS I can only guide along a route built beforehand. Tell me what you see (a street, a sign) and I'll match it with the map.");
        }
      } else if (g.state === "DEGRADED" || g.mode === "degraded") {
        now.push(gpsSentence(w));
      } else {
        now.push(uk ? `Зараз сигнал GPS у нормі${g.accuracyM != null ? ` (±${Math.round(g.accuracyM)} м)` : ""}. Якщо він зникне:` : `The GPS signal is fine right now${g.accuracyM != null ? ` (±${Math.round(g.accuracyM)} m)` : ""}. If it drops:`);
      }
      const how = uk
        ? [
          lost ? "Як я веду без GPS:" : g.state === "DEGRADED" ? "Якщо сигнал зникне:" : "",
          "• рахую пройдене за швидкістю й датчиками руху телефона;",
          "• перед кожним поворотом називаю орієнтир — світлофор, АЗС, міст, переїзд;",
          "• після повороту натисніть «Я вже повернув» — я уточню позицію;",
          "• якщо загубилися — напишіть, що бачите (назву вулиці, вивіску, АЗС), і я порівняю з картою.",
          r ? (r.landmarkCount > 0 ? `На цьому маршруті я знаю ${r.landmarkCount} орієнтирів.` : "Орієнтирів уздовж цього маршруту поки немає — орієнтуйтеся за назвами вулиць і дорожніми знаками.") : "Порада: будуйте маршрут, поки сигнал є — я збережу його разом з орієнтирами й мапою.",
        ]
        : [
          lost ? "How I guide without GPS:" : g.state === "DEGRADED" ? "If the signal drops:" : "",
          "• I count the distance from speed and the phone's motion sensors;",
          "• before each turn I name a landmark — traffic lights, a fuel station, a bridge, a crossing;",
          "• after the turn tap “I've turned” so I can correct the position;",
          "• if you get lost, tell me what you see (a street name, a sign, a fuel station) and I'll match it with the map.",
          r ? (r.landmarkCount > 0 ? `On this route I know ${r.landmarkCount} landmarks.` : "There are no landmarks along this route yet — go by street names and road signs.") : "Tip: build the route while there is a signal — I'll save it with its landmarks and the map.",
        ];
      const text = [now.join(" "), ...how.filter(Boolean)].join("\n");
      const actions: CopilotAction[] = [];
      if (lost && r?.next) actions.push({ kind: "confirmTurn", label: uk ? "Я вже повернув" : "I've turned" });
      if (r?.next) actions.push(ask(uk ? "Що далі?" : "What's next?"));
      actions.push(ask(uk ? "Де я зараз?" : "Where am I?"));
      return { intent, text, actions };
    }

    case "whereAmI":
    case "lost":
      return whereAmI(w, intent);

    case "describe":
      return describe(question, w);

    case "routeNext": {
      const r = w.route;
      if (!r?.next) return { intent, text: uk ? "Активного маршруту немає. Скажіть, куди їдемо, — або оберіть місце на мапі." : "No active route. Tell me where to go, or pick a place on the map.", actions: [{ kind: "search", label: uk ? "Знайти місце" : "Find a place", query: "" }] };
      if (r.offRoute) return { intent, text: uk ? "Ви зійшли з маршруту — я перераховую шлях. Якщо GPS нестабільний, поверніться туди, де звернули." : "You've left the route — recalculating. If GPS is unstable, go back to where you turned off.", actions: [] };
      const dist = r.next.distanceM != null && w.gps.positionMode !== "DEAD_RECKONING" ? (uk ? `Через ${formatDistance(r.next.distanceM, "uk")}` : `In ${formatDistance(r.next.distanceM, "en")}`) : (uk ? "Скоро" : "Soon");
      const cue = r.next.cue ? `, ${r.next.cue},` : "";
      const road = r.next.road ? (uk ? ` на ${r.next.road}` : ` onto ${r.next.road}`) : "";
      const confirm = r.next.confirm ? ` ${r.next.confirm}` : "";
      const then = r.then ? (uk ? ` Потім — ${r.then}.` : ` Then ${r.then}.`) : "";
      const actions: CopilotAction[] = w.gps.positionMode === "DEAD_RECKONING" || w.gps.state === "LOST" ? [{ kind: "confirmTurn", label: uk ? "Я вже повернув" : "I've turned" }] : [];
      return { intent, text: `${dist}${cue} ${r.next.action}${road}.${confirm}${then}`, actions };
    }

    case "eta": {
      if (!w.route) return { intent, text: uk ? "Активного маршруту немає." : "No active route.", actions: [] };
      const r = w.route;
      const approx = w.gps.positionMode === "DEAD_RECKONING" ? (uk ? " Позиція зараз приблизна, тож час орієнтовний." : " The position is approximate now, so the time is an estimate.") : "";
      const time = r.etaS != null ? (uk ? ` Приблизно ${formatDuration(r.etaS, "uk")}, прибуття о ${formatClock(w.now + r.etaS * 1000, "uk")}.` : ` About ${formatDuration(r.etaS, "en")}, arriving at ${formatClock(w.now + r.etaS * 1000, "en")}.`) : "";
      return { intent, text: `${uk ? `До «${r.destination}» залишилось ${formatDistance(r.remainingM, "uk")}.` : `${formatDistance(r.remainingM, "en")} to “${r.destination}”.`}${time}${approx}`, actions: [] };
    }

    case "landmarks": {
      const r = w.route;
      if (!r) return { intent, text: uk ? "Орієнтири я збираю, коли будую маршрут. Побудуйте маршрут — і я назву їх на кожному повороті." : "I collect landmarks when a route is built. Build a route and I'll name them at every turn.", actions: [] };
      const next = r.next?.cue ? (uk ? ` Найближчий: ${r.next.cue}.` : ` Next: ${r.next.cue}.`) : "";
      return { intent, text: uk ? `На цьому маршруті я знаю ${r.landmarkCount} орієнтирів.${next}${r.ahead ? ` Попереду: ${r.ahead}.` : ""}` : `I know ${r.landmarkCount} landmarks on this route.${next}${r.ahead ? ` Ahead: ${r.ahead}.` : ""}`, actions: [] };
    }

    case "navigateTo": {
      const target = question.replace(/^(\s*)(веди( мене)?|маршрут до|поїхали до|поехали (в|до)|їдемо до|едем в|как доехать( до)?|як доїхати( до)?|як дістатися( до)?|как добраться( до)?|take me to|navigate to|route to)\s*/i, "").trim();
      const kind = detectKind(target);
      if (kind) return answer(target, w);
      return { intent, text: uk ? `Шукаю «${target}». Оберіть потрібне місце у списку — і я прокладу маршрут.` : `Searching for “${target}”. Pick the right place and I'll build the route.`, actions: [{ kind: "search", label: uk ? `Знайти «${target}»` : `Find “${target}”`, query: target }] };
    }

    case "photo":
      return { intent, text: uk ? "Розпізнавання місця за фото запрацює, коли підключимо сервер NAVIA. Зараз опишіть словами, що бачите: назву вулиці, вивіску, АЗС, церкву — я порівняю з картою й орієнтирами маршруту." : "Recognising a place from a photo will work once the NAVIA server is connected. For now, tell me what you see — a street name, a sign, a fuel station, a church — and I'll match it with the map.", actions: [ask(uk ? "Бачу " : "I see ")] };

    case "greet":
      return greeting(w);

    case "thanks":
      return { intent, text: uk ? "Завжди поруч. Спокійної дороги." : "Always here. Travel safe.", actions: [] };

    case "help":
      return {
        intent,
        text: uk
          ? "Я штурман NAVIA. Можу:\n• сказати, що з тривогою та GPS просто зараз;\n• знайти укриття, АЗС, аптеку, лікарню, банкомат — з відстанню й напрямком і прокласти маршрут;\n• вести без GPS за орієнтирами й підказати, де ви;\n• допомогти в екстреній ситуації (112/103).\nПитайте голосом або текстом."
          : "I'm the NAVIA co-pilot. I can:\n• tell you the alert and GPS status right now;\n• find shelters, fuel, pharmacies, hospitals, ATMs — with distance and direction — and build a route;\n• guide without GPS by landmarks and tell you where you are;\n• help in an emergency (112/103).\nAsk by voice or text.",
        actions: suggestions(w).slice(0, 4),
      };

    case "about":
      return { intent, text: uk ? "NAVIA — навігатор для дороги під час тривоги. Коли РЕБ глушить або підміняє GPS, звичайна навігація губиться. Я перевіряю кожну точку, відкидаю підробки, а без сигналу веду за збереженим маршрутом, датчиками руху й орієнтирами на кожному повороті. І завжди чесно кажу, наскільки впевнена в позиції." : "NAVIA is a navigator for travelling during air alerts. When EW jams or spoofs GPS, ordinary navigation gets lost. I check every fix, reject fakes, and without a signal I guide along the saved route using motion sensors and a landmark at every turn — always honest about how sure I am.", actions: [ask(uk ? "Що робити без GPS?" : "What to do without GPS?")] };

    default: {
      // A place name the user typed? Try the known places and landmarks.
      const hits = matchDescription(question, w.landmarks);
      if (hits.length) return describe(question, w);
      return { intent: "unknown", text: uk ? `Я вас почула, але поки не зрозуміла. ${situation(w)} Спробуйте так:` : `I heard you but didn't get that. ${situation(w)} Try:`, actions: suggestions(w).slice(0, 4) };
    }
  }
}

function whereAmI(w: CopilotWorld, intent: Intent): CopilotReply {
  const uk = w.lang === "uk";
  const g = w.gps;
  const actions: CopilotAction[] = [];
  const parts: string[] = [];
  if (g.positionMode === "DEAD_RECKONING" && w.route) {
    parts.push(uk ? `GPS недоступний. За маршрутом до «${w.route.destination}» ви приблизно` : `GPS is unavailable. Along the route to “${w.route.destination}” you are roughly`);
    if (w.route.behind && w.route.ahead) parts.push(uk ? `між «${w.route.behind}» і «${w.route.ahead}».` : `between “${w.route.behind}” and “${w.route.ahead}”.`);
    else if (w.route.ahead) parts.push(uk ? `перед «${w.route.ahead}».` : `before “${w.route.ahead}”.`);
    else if (w.route.behind) parts.push(uk ? `після «${w.route.behind}».` : `past “${w.route.behind}”.`);
    else parts.push(uk ? "на маршруті." : "on the route.");
    if (g.uncertaintyM) parts.push(uk ? `Точність ±${Math.round(g.uncertaintyM)} м.` : `Accuracy ±${Math.round(g.uncertaintyM)} m.`);
    if (w.route.next) parts.push(uk ? `Далі: ${w.route.next.cue ? `${w.route.next.cue} ` : ""}${w.route.next.action}.` : `Next: ${w.route.next.cue ? `${w.route.next.cue}, ` : ""}${w.route.next.action}.`);
    parts.push(uk ? "Якщо бачите вивіску чи назву вулиці — напишіть, я уточню." : "If you see a sign or a street name, tell me and I'll refine it.");
    actions.push({ kind: "confirmTurn", label: uk ? "Я вже повернув" : "I've turned" }, { kind: "ask", label: uk ? "Бачу " : "I see ", question: uk ? "Бачу " : "I see " });
    return { intent, text: parts.join(" "), actions };
  }
  if (g.state === "LOST" || !g.hasPosition) {
    const age = g.lastFixAgeS != null ? (uk ? `Остання надійна позиція була ${Math.max(1, Math.round(g.lastFixAgeS / 60))} хв тому${w.here?.street ? ` на ${w.here.street}` : w.here?.area ? ` (${w.here.area})` : ""}.` : `The last trusted position was ${Math.max(1, Math.round(g.lastFixAgeS / 60))} min ago${w.here?.street ? ` on ${w.here.street}` : ""}.`) : "";
    parts.push(uk ? `Зараз GPS не визначає вашу позицію. ${age}` : `GPS can't determine your position right now. ${age}`);
    parts.push(uk ? "Опишіть, що бачите навколо: назву вулиці, номер будинку, вивіску, АЗС, церкву — я порівняю з картою." : "Tell me what you see around: a street name, a house number, a sign, a fuel station, a church — I'll match it with the map.");
    actions.push({ kind: "ask", label: uk ? "Бачу " : "I see ", question: uk ? "Бачу " : "I see " });
    if (intent === "lost") actions.push({ kind: "call", label: uk ? "Подзвонити 112" : "Call 112", number: "112" });
    return { intent, text: parts.join(" "), actions };
  }
  const where = w.here?.street || w.here?.area;
  // "Ви тут: <address>" avoids declining arbitrary street names.
  const address = [w.here?.street, w.here?.area].filter(Boolean).join(", ");
  parts.push(where ? (uk ? `Ви тут: ${address}.` : `You are here: ${address}.`) : (uk ? "Ваша позиція на мапі — позначка NAVIA." : "Your position is the NAVIA marker on the map."));
  parts.push(gpsSentence(w));
  const around = (["shop", "pharmacy", "fuel", "atm"] as PlaceKind[]).map((k) => w.places[k]?.[0]).filter((p): p is WorldPlace => !!p && !!p.name).sort((a, b) => a.distanceM - b.distanceM)[0];
  if (around) parts.push(uk ? `Поруч: ${placeLine(around, "uk")}.` : `Nearby: ${placeLine(around, "en")}.`);
  if (w.route?.next) parts.push(uk ? `Далі за маршрутом: ${w.route.next.cue ? `${w.route.next.cue} ` : ""}${w.route.next.action}.` : `Next on the route: ${w.route.next.cue ? `${w.route.next.cue}, ` : ""}${w.route.next.action}.`);
  return { intent, text: parts.join(" "), actions };
}

function describe(question: string, w: CopilotWorld): CopilotReply {
  const uk = w.lang === "uk";
  const hits = matchDescription(question, w.landmarks);
  if (hits.length === 0) {
    return { intent: "describe", text: uk ? "Не знайшла цього серед відомих мені місць поруч і на маршруті. Спробуйте назву вулиці, номер будинку, бренд АЗС (ОККО, WOG, SOCAR) чи магазину." : "I couldn't find that among the places I know nearby or on the route. Try a street name, a house number, or a fuel/shop brand.", actions: [{ kind: "ask", label: uk ? "Бачу " : "I see ", question: uk ? "Бачу " : "I see " }] };
  }
  const best = hits[0]!;
  const others = hits.slice(1).map((h) => `«${h.name}»`).join(", ");
  const onRoute = best.onRoute && w.route;
  const text = uk
    ? `Схоже, ви біля «${best.name}» (${best.kindLabel})${onRoute ? " — це на нашому маршруті" : ""}.${others ? ` Або біля: ${others}.` : ""} ${onRoute ? "Натисніть «Я тут» — я уточню позицію на маршруті." : "Якщо це так — можу прокласти маршрут звідси."}`
    : `Looks like you're near “${best.name}” (${best.kindLabel})${onRoute ? " — it's on our route" : ""}.${others ? ` Or near: ${others}.` : ""} ${onRoute ? "Tap “I'm here” and I'll correct your position on the route." : "If so, I can build a route from here."}`;
  const actions: CopilotAction[] = [{ kind: "correctPosition", label: uk ? `Я тут: «${best.name}»` : `I'm here: “${best.name}”`, place: { name: best.name, lat: best.location.lat, lon: best.location.lon } }];
  return { intent: "describe", text, actions };
}
