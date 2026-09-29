// NAVIA navigator — LAYER 3: scenario handlers, one per intent, in a registry.
// A handler reads the Snapshot (layer 1) and returns a Draft: short lines
// built from real values, buttons, a tone, and which snapshot fields it used
// (so tests can check every answer is grounded). A new scenario = a new
// handler + registerHandler(); nothing else changes.
// Pure; unit-tested.
import { answer as classicAnswer, directionWords, walkMinutes, type CopilotAction, type WorldPlace } from "../copilotBrain";
import { formatClock, formatDistance, formatDuration } from "../../i18n/format";
import { placeKindOf, type NavigatorIntent } from "./intents";
import type { Snapshot } from "./snapshot";

export type Tone = "calm" | "warning" | "critical";
export type Draft = {
  lines: string[];
  actions: CopilotAction[];
  tone: Tone;
  /** Snapshot fields the answer is built from ("gnss.sinceFixS", "route.next", …). */
  used: string[];
  /** The data the answer needed but did not have (answered honestly). */
  missing?: string[];
  /** Places to show as cards under the answer. */
  places?: WorldPlace[];
  /** An honest "don't know / no such data" (with the reason), not a guess. */
  honest?: boolean;
};
/** The previous answer, for "repeat" and "why did you answer so". */
export type LastAnswer = { question: string; intent: NavigatorIntent; text: string; used: string[]; missing: string[]; snapshot: Snapshot };
export type HandlerContext = { question: string; lastReply: string | null; last?: LastAnswer | null; options?: NavigatorIntent[] };
export type Handler = (s: Snapshot, ctx: HandlerContext) => Draft;

const registry = new Map<NavigatorIntent, Handler>();
export function registerHandler(intent: NavigatorIntent, handler: Handler): void {
  registry.set(intent, handler);
}
export function handlerFor(intent: NavigatorIntent): Handler {
  return registry.get(intent) ?? registry.get("unknown")!;
}
export function registeredIntents(): NavigatorIntent[] {
  return [...registry.keys()];
}

// ——— words ———
const L = (s: Snapshot, uk: string, en: string) => (s.lang === "uk" ? uk : en);
const m = (v: number) => Math.max(1, Math.round(v));
const dist = (s: Snapshot, meters: number) => formatDistance(meters, s.lang);
function ago(s: Snapshot, sec: number): string {
  if (sec < 1.5) return L(s, "щойно", "just now");
  return sec < 120 ? L(s, `${m(sec)} с тому`, `${m(sec)} s ago`) : L(s, `${m(sec / 60)} хв тому`, `${m(sec / 60)} min ago`);
}
const ask = (label: string): CopilotAction => ({ kind: "ask", label, question: label });
const turned = (s: Snapshot): CopilotAction => ({ kind: "confirmTurn", label: L(s, "Поворот пройдено", "I've turned") });
const dr = (s: Snapshot) => s.gnss.mode === "navigator";

function nextLine(s: Snapshot, prefix: boolean): string | null {
  const n = s.route?.next;
  if (!n) return null;
  const road = n.road ? L(s, ` на ${n.road}`, ` onto ${n.road}`) : "";
  const cue = n.cue ? `, ${n.cue}` : "";
  // Without GPS the distance is an estimate: say "about", never exact metres.
  const when = n.distanceM == null ? "" : dr(s) ? L(s, `, приблизно через ${dist(s, n.distanceM)}`, `, in about ${dist(s, n.distanceM)}`) : L(s, `, через ${dist(s, n.distanceM)}`, `, in ${dist(s, n.distanceM)}`);
  const head = prefix ? L(s, "Далі: ", "Next: ") : "";
  return `${head}${n.action}${road}${cue}${when}.`;
}

function gpsLine(s: Snapshot): { line: string; used: string[] } {
  const g = s.gnss;
  if (g.mode === "navigator") {
    const since = g.sinceFixS != null ? L(s, ` ${ago(s, g.sinceFixS)}`, ` ${ago(s, g.sinceFixS)}`) : "";
    const what = g.state === "LOST" ? L(s, `Сигнал GPS втрачено${since}.`, `GPS signal lost${since}.`) : L(s, `Сигнал GPS ненадійний, його точки відкидаються (останній надійний${since}).`, `The GPS signal is unreliable and its fixes are ignored (last trusted fix${since}).`);
    return { line: what, used: ["gnss.state", "gnss.mode", "gnss.sinceFixS"] };
  }
  if (g.mode === "degraded") {
    const acc = g.accuracyM != null ? L(s, `: точність ±${m(g.accuracyM)} м`, `: accuracy ±${m(g.accuracyM)} m`) : "";
    const trend = g.trend ? ` (${g.trend})` : "";
    return { line: L(s, `Сигнал GPS нестабільний${acc}${trend}.`, `The GPS signal is unstable${acc}${trend}.`), used: ["gnss.mode", "gnss.accuracyM", "gnss.trend"] };
  }
  if (!s.position.known) return { line: L(s, "GPS ще не визначив позицію.", "GPS has not found your position yet."), used: ["position.known"] };
  const age = s.gnss.sinceFixS != null ? L(s, `, останній сигнал ${ago(s, s.gnss.sinceFixS)}`, `, last fix ${ago(s, s.gnss.sinceFixS)}`) : "";
  const acc = g.accuracyM != null ? L(s, `, точність ±${m(g.accuracyM)} м`, `, accuracy ±${m(g.accuracyM)} m`) : "";
  return { line: L(s, `GPS у нормі${age}${acc}.`, `GPS is fine${age}${acc}.`), used: ["gnss.state", "gnss.sinceFixS", "gnss.accuracyM"] };
}

function howIGuide(s: Snapshot): string {
  const unc = s.position.uncertaintyM != null ? L(s, `, похибка зараз ±${m(s.position.uncertaintyM)} м`, `, error now ±${m(s.position.uncertaintyM)} m`) : "";
  return s.position.source === "MANUAL"
    ? L(s, `Веду від точки, яку ви вказали${unc}.`, `Guiding from the point you set${unc}.`)
    : L(s, `Веду вас за маршрутом за рахунком шляху${unc}.`, `Guiding you along the route by dead reckoning${unc}.`);
}

function nearestShelter(s: Snapshot): WorldPlace | null {
  return s.places.shelter?.[0] ?? null;
}
function shelterLine(s: Snapshot, p: WorldPlace): string {
  const dir = p.bearingDeg != null ? ` ${directionWords(p.bearingDeg, s.lang)}` : "";
  return L(s, `Найближче укриття: ${p.name} — ${dist(s, p.distanceM)}${dir}, ≈${walkMinutes(p.distanceM)} хв пішки.`, `Nearest shelter: ${p.name} — ${dist(s, p.distanceM)}${dir}, ≈${walkMinutes(p.distanceM)} min on foot.`);
}
function walkTo(s: Snapshot, p: WorldPlace): CopilotAction {
  return { kind: "route", mode: "walk", place: { name: p.name, lat: p.location.lat, lon: p.location.lon }, label: L(s, `Вести пішки · ${dist(s, p.distanceM)}`, `Walk there · ${dist(s, p.distanceM)}`) };
}

/** The classic co-pilot's answer for scenarios it already covers well
 * (place search with sources, describe, emergency, where am I). */
function classic(s: Snapshot, question: string, used: string[], tone: Tone = "calm"): Draft {
  const r = classicAnswer(question, s.world);
  return { lines: [r.text], actions: r.actions, tone, used, ...(r.places ? { places: r.places } : {}) };
}

// ——— handlers ———

/** "What if the signal is gone for long": how fast the estimate degrades. */
function longOutage(s: Snapshot): { line: string; used: string[] } | null {
  const rate = s.fields.drErrorGrowthMPerMin;
  if (rate == null) return { line: L(s, "Чим довше без сигналу, тим менш точна позиція за рахунком шляху; як швидко росте похибка — невідомо без даних про швидкість. Щойно сигнал повернеться, позицію буде виправлено одразу.", "The longer without a signal, the less accurate dead reckoning gets; how fast is unknown without speed data. As soon as the signal returns, the position is corrected at once."), used: ["fields.speedMps"] };
  return { line: L(s, `Чим довше без сигналу, тим більша похибка: за цієї швидкості вона росте приблизно на ${m(rate)} м за хвилину. Щойно сигнал повернеться, позицію буде виправлено одразу.`, `The longer without a signal, the larger the error: at this speed it grows by about ${m(rate)} m a minute. As soon as the signal returns, the position is corrected at once.`), used: ["fields.drErrorGrowthMPerMin"] };
}
const LONG = /надовг|надолг|довго|долго|тривал|длител|for long|a long time/i;

registerHandler("signalLost", (s, ctx) => {
  const g = gpsLine(s);
  if (LONG.test(ctx.question)) {
    const lo = longOutage(s)!;
    const now = s.gnss.mode === "normal" ? L(s, "Зараз сигнал є.", "The signal is there now.") : g.line;
    return { lines: [now, lo.line], actions: [], tone: s.gnss.mode === "normal" ? "calm" : "warning", used: [...g.used, ...lo.used] };
  }
  if (s.gnss.mode === "navigator") {
    const lines = [g.line];
    const used = [...g.used, "position.source", "position.uncertaintyM"];
    if (s.route && !s.route.offRoute) {
      // Crisis: three sentences — what happened and how NAVIA guides, the next
      // turn, what to do. Landmarks and "when will it return" on request.
      const unc = s.position.uncertaintyM != null ? L(s, `, похибка зараз ±${m(s.position.uncertaintyM)} м`, `, error now ±${m(s.position.uncertaintyM)} m`) : "";
      lines[0] = g.line.replace(/\.$/, "") + L(s, ` — веду за маршрутом за рахунком шляху${unc}.`, ` — guiding along the route by dead reckoning${unc}.`);
      const next = nextLine(s, true);
      if (next) { lines.push(next); used.push("route.next"); }
      lines.push(L(s, "Тримайтеся маршруту й знаків; після повороту натисніть «Поворот пройдено».", "Keep to the route and signs; after the turn tap “I've turned”."));
      return { lines, actions: [turned(s), ask(L(s, "Що далі?", "What's next?")), ask(L(s, "Де я зараз?", "Where am I?"))], tone: "critical", used: [...used, "route"] };
    }
    const where = s.position.street ?? s.position.area;
    lines.push(where ? L(s, `Остання надійна позиція: ${where}.`, `Last trusted position: ${where}.`) : L(s, "Показую останню підтверджену позицію на мапі.", "The map shows the last confirmed position."));
    lines.push(s.route?.offRoute
      ? L(s, "Ви поза маршрутом, тож рахунок шляху не допоможе. Поверніться туди, де звернули, або скажіть, що бачите навколо (вулицю, вивіску), — я порівняю з картою.", "You're off the route, so dead reckoning can't help. Go back to where you turned, or tell me what you see (a street, a sign) and I'll match it with the map.")
      : L(s, "Маршруту немає, тому вести без GPS можу лише за описом: скажіть, що бачите навколо (вулицю, вивіску, АЗС), — я порівняю з картою. Маршрут краще будувати, поки сигнал є.", "There's no route, so without GPS I can only go by description: tell me what you see (a street, a sign, a fuel station) and I'll match it with the map. Build routes while there is a signal."));
    return { lines, actions: [ask(L(s, "Бачу ", "I see ")), ask(L(s, "Де я зараз?", "Where am I?"))], tone: "critical", used: [...g.used, "position.street", "route"] };
  }
  if (s.gnss.mode === "degraded") {
    const plan = s.route
      ? L(s, "Поки навігація йде за GPS; якщо сигнал зникне — буде перехід на рахунок шляху за маршрутом, і NAVIA про це скаже.", "Navigation still follows GPS; if the signal drops, it switches to dead reckoning along the route and NAVIA will say so.")
      : L(s, "Сигнал ще є — побудуйте маршрут зараз, без GPS я зможу вести лише за ним.", "There is still a signal — build a route now; without GPS I can only guide along one.");
    return { lines: [g.line, plan], actions: s.route ? [ask(L(s, "Що далі?", "What's next?"))] : [{ kind: "search", label: L(s, "Знайти місце", "Find a place"), query: "" }], tone: "warning", used: [...g.used, "route"] };
  }
  return {
    lines: [g.line.replace(/\.$/, L(s, " — сигнал зараз є.", " — the signal is there now.")), L(s, "Якщо він зникне: я скажу про це й поведу за маршрутом за рахунком шляху, а повороти підкажу за орієнтирами.", "If it drops: I'll tell you and guide along the route by dead reckoning, calling turns by landmarks.")],
    actions: [], tone: "calm", used: [...g.used, "route"],
  };
});

registerHandler("gpsStatus", (s) => {
  const g = gpsLine(s);
  const lines = [g.line];
  const used = [...g.used];
  if (s.gnss.mode === "navigator") { lines.push(howIGuide(s)); used.push("position.source", "position.uncertaintyM"); }
  else if (s.gnss.mode === "degraded") lines.push(L(s, "Сумнівні точки відкидаю; якщо сигнал зникне — поведу за маршрутом.", "I reject suspicious fixes; if the signal drops, I'll guide along the route."));
  return { lines, actions: s.gnss.mode === "normal" ? [] : [ask(L(s, "Що робити без GPS?", "What to do without GPS?"))], tone: s.gnss.mode === "normal" ? "calm" : s.gnss.mode === "degraded" ? "warning" : "critical", used };
});

const noRoute = (s: Snapshot, about: "turns" | "eta" | "track" = "turns"): Draft => ({
  lines: [
    about === "eta" ? L(s, "Маршрут не прокладено — рахувати, скільки лишилось і коли приїдемо, немає до чого.", "There's no route, so there's nothing to count the distance or arrival time to.")
      : about === "track" ? L(s, "Маршрут не прокладено — перевірити, чи правильно ви їдете, немає з чим.", "There's no route to check your way against.")
        : L(s, "Маршрут не прокладено — підказувати повороти ні з чого.", "There's no route, so there are no turns to call."),
    L(s, "Скажіть, куди їдемо, або оберіть місце на мапі.", "Tell me where to go or pick a place on the map."),
  ],
  actions: [{ kind: "search", label: L(s, "Знайти місце", "Find a place"), query: "" }], tone: "calm", used: ["route"], missing: ["route"],
});

registerHandler("routeNext", (s) => {
  if (!s.route) return noRoute(s);
  if (s.route.offRoute) return handlerFor("reroute")(s, { question: "", lastReply: null });
  const next = nextLine(s, false);
  if (!next) return { lines: [L(s, `Прямо до «${s.route.destination}», поворотів більше немає.`, `Straight on to “${s.route.destination}”, no more turns.`)], actions: [], tone: "calm", used: ["route.next", "route.destination"] };
  const lines = [next.charAt(0).toUpperCase() + next.slice(1)];
  if (s.route.next?.confirm) lines.push(s.route.next.confirm);
  if (s.route.then) lines.push(L(s, `Потім — ${s.route.then}.`, `Then ${s.route.then}.`));
  if (dr(s)) lines.push(L(s, "Без GPS відстань приблизна — після повороту натисніть «Поворот пройдено».", "Without GPS the distance is approximate — tap “I've turned” after the turn."));
  return { lines, actions: dr(s) ? [turned(s)] : [], tone: dr(s) ? "warning" : "calm", used: ["route.next", "route.then", "gnss.mode"] };
});

registerHandler("onRoute", (s) => {
  if (!s.route) return noRoute(s, "track");
  if (s.route.offRoute) return handlerFor("reroute")(s, { question: "", lastReply: null });
  const next = nextLine(s, true);
  if (dr(s)) {
    const where = s.route.behind || s.route.ahead ? L(s, ` Ви приблизно ${s.route.behind ? `після «${s.route.behind}»` : ""}${s.route.behind && s.route.ahead ? " і " : ""}${s.route.ahead ? `перед «${s.route.ahead}»` : ""}.`, ` You're roughly ${s.route.behind ? `past “${s.route.behind}”` : ""}${s.route.behind && s.route.ahead ? " and " : ""}${s.route.ahead ? `before “${s.route.ahead}”` : ""}.`) : "";
    return { lines: [L(s, "Без GPS підтвердити не можу: за рахунком шляху ви на маршруті.", "Without GPS I can't confirm it: by dead reckoning you're on the route.") + where, next ?? "", L(s, "Звіртеся з назвою вулиці чи орієнтиром.", "Check a street name or a landmark.")].filter(Boolean), actions: [turned(s), ask(L(s, "Бачу ", "I see "))], tone: "warning", used: ["route.offRoute", "gnss.mode", "route.behind", "route.ahead", "route.next"] };
  }
  return { lines: [L(s, `Так, ви на маршруті до «${s.route.destination}», залишилось ${dist(s, s.route.remainingM)}.`, `Yes, you're on the route to “${s.route.destination}”, ${dist(s, s.route.remainingM)} to go.`), next ?? ""].filter(Boolean), actions: [], tone: "calm", used: ["route.offRoute", "route.destination", "route.remainingM", "route.next"] };
});

registerHandler("reroute", (s) => {
  if (!s.route) return noRoute(s, "track");
  if (s.route.offRoute) {
    if (s.gnss.mode !== "normal") return { lines: [L(s, "Ви зійшли з маршруту, а сигнал GPS ненадійний — перебудувати маршрут не можу.", "You've left the route and the GPS signal is unreliable — I can't rebuild the route."), L(s, "Поверніться туди, де звернули, і далі за маршрутом; або скажіть, що бачите навколо.", "Go back to where you turned and continue on the route, or tell me what you see.")], actions: [ask(L(s, "Бачу ", "I see "))], tone: "critical", used: ["route.offRoute", "gnss.mode"] };
    if (!s.online) return { lines: [L(s, "Ви зійшли з маршруту. Інтернету немає — новий маршрут не збудую.", "You've left the route. There's no internet, so I can't build a new route."), L(s, "Поверніться на маршрут — він збережений на телефоні.", "Go back to the route — it's saved on the phone.")], actions: [], tone: "warning", used: ["route.offRoute", "online"] };
    return { lines: [s.fields.reroutingInProgress
      ? L(s, `Так, ви зійшли з маршруту. Новий маршрут до «${s.route.destination}» уже будується.`, `Yes, you've left the route. A new route to “${s.route.destination}” is being built.`)
      : L(s, `Так, ви зійшли з маршруту — шлях до «${s.route.destination}» буде перебудовано від вашої позиції.`, `Yes, you've left the route — the way to “${s.route.destination}” will be rebuilt from where you are.`)], actions: [], tone: "warning", used: ["route.offRoute", "route.destination", "online", "gnss.mode", "fields.reroutingInProgress"] };
  }
  return { lines: [L(s, "Ні, ви на маршруті.", "No, you're on the route."), nextLine(s, true) ?? "", L(s, "Якщо звернете не туди, я помічу це, щойно GPS підтвердить відхилення, і перебудую шлях.", "If you take a wrong turn, I'll notice as soon as GPS confirms it and rebuild the way.")].filter(Boolean), actions: [], tone: "calm", used: ["route.offRoute", "route.next"] };
});

registerHandler("eta", (s) => {
  if (!s.route) return noRoute(s, "eta");
  const eta = s.route.etaS != null ? L(s, `, прибуття ≈ о ${formatClock(s.at + s.route.etaS * 1000, "uk")} (${formatDuration(s.route.etaS, "uk")})`, `, arriving ≈ ${formatClock(s.at + s.route.etaS * 1000, "en")} (${formatDuration(s.route.etaS, "en")})`) : "";
  const lines = [L(s, `До «${s.route.destination}» залишилось ${dist(s, s.route.remainingM)}${eta}.`, `${dist(s, s.route.remainingM)} to “${s.route.destination}”${eta}.`)];
  if (dr(s)) lines.push(L(s, "Без GPS час і відстань орієнтовні.", "Without GPS the time and distance are estimates."));
  return { lines, actions: [], tone: "calm", used: ["route.remainingM", "route.etaS", "route.destination", "gnss.mode"], ...(s.route.etaS == null ? { missing: ["route.etaS"] } : {}) };
});

registerHandler("whereAmI", (s, ctx) => {
  const lost = /заблук|заблуд|загуб|потерял|lost/i.test(ctx.question);
  const where = [s.position.street, s.position.area].filter(Boolean).join(", ");
  const lines: string[] = [];
  const used: string[] = [];
  if (dr(s)) {
    lines.push(where ? L(s, `Остання підтверджена позиція: ${where}${s.gnss.sinceFixS != null ? ` (${ago(s, s.gnss.sinceFixS)})` : ""}.`, `Last confirmed position: ${where}.`) : L(s, "Підтвердженої позиції зараз немає.", "There's no confirmed position right now."));
    used.push("position.street", "position.area", "gnss.sinceFixS");
    if (s.route && !s.route.offRoute) {
      lines.push(L(s, `Зараз — за рахунком шляху, на маршруті до «${s.route.destination}»${s.position.uncertaintyM != null ? `, похибка ±${m(s.position.uncertaintyM)} м` : ""}.`, `Now: by dead reckoning, on the route to “${s.route.destination}”.`));
      if (s.route.behind || s.route.ahead) lines.push(L(s, `Між ${s.route.behind ? `«${s.route.behind}»` : "стартом"} і ${s.route.ahead ? `«${s.route.ahead}»` : "наступним орієнтиром"}.`, `Between ${s.route.behind ?? "the start"} and ${s.route.ahead ?? "the next landmark"}.`));
      const next = nextLine(s, true);
      if (next) lines.push(next);
      used.push("route.destination", "position.uncertaintyM", "route.behind", "route.ahead", "route.next");
    }
    lines.push(L(s, "Якщо бачите назву вулиці, вивіску чи АЗС — напишіть «бачу …», позицію буде уточнено.", "If you see a street name, a sign or a fuel station, type “I see …” to refine the position."));
    return { lines, actions: [turned(s), ask(L(s, "Бачу ", "I see "))], tone: "warning", used };
  }
  if (!s.position.known) return { lines: [L(s, "GPS ще не визначив позицію. Опишіть, що бачите навколо.", "GPS has not found your position yet. Describe what you see around.")], actions: [ask(L(s, "Бачу ", "I see "))], tone: "warning", used: ["position.known"], missing: ["position"] };
  lines.push(where ? L(s, `Ви тут: ${where}.`, `You are here: ${where}.`) : L(s, "Ваша позиція — позначка NAVIA на мапі (назва вулиці ще не визначена).", "Your position is the NAVIA marker on the map (street not resolved yet)."));
  used.push("position.street", "position.area");
  const g = gpsLine(s);
  lines.push(g.line); used.push(...g.used);
  if (s.route && !s.route.offRoute) { const next = nextLine(s, true); if (next) { lines.push(next); used.push("route.next"); } }
  if (lost) lines.push(L(s, "Якщо потрібна допомога — 112.", "If you need help, call 112."));
  return { lines, actions: lost ? [{ kind: "call", label: L(s, "Подзвонити 112", "Call 112"), number: "112" }] : [], tone: "calm", used, ...(where ? {} : { missing: ["position.street"] }) };
});

registerHandler("shelter", (s) => {
  const lines: string[] = [];
  const used = ["places.shelter", "placeStates.shelter", "placeGaps.shelter", "alert.active"];
  const tone: Tone = s.alert?.active ? "critical" : "calm";
  if (s.alert?.active) lines.push(L(s, "Тривога — йдіть в укриття зараз.", "Air alert — go to a shelter now."));
  const list = (s.places.shelter ?? []).slice(0, 3);
  const state = s.placeStates.shelter;
  if (list.length === 0) {
    if (state === "loading" || state === "idle" || state === undefined) lines.push(L(s, "Ще шукаю укриття поруч — кілька секунд. Під час тривоги без даних: капітальне приміщення без вікон, подалі від скла.", "Still searching for shelters nearby — a few seconds. During an alert without data: a solid room without windows, away from glass."));
    else if (state === "error") lines.push(L(s, "Не вдалося завантажити укриття: немає зв'язку, а в офлайн-пакеті поруч їх немає. Капітальне приміщення без вікон, подалі від скла.", "Couldn't load shelters: no connection, and the offline package has none nearby. A solid room without windows, away from glass."));
    else lines.push(L(s, "У відкритих даних поруч укриттів немає. Уточніть у громаді чи в «Дії»; під час тривоги — капітальне приміщення без вікон.", "Open data lists no shelters nearby. Check with your community or Diia; during an alert, a solid room without windows."));
    return { lines, actions: [{ kind: "safety", label: L(s, "Безпека", "Safety") }], tone, used, missing: ["places.shelter"] };
  }
  // Crisis: three sentences — (alert) go now / the nearest / the others + a note.
  lines.push(shelterLine(s, list[0]!));
  const gaps = s.placeGaps.shelter ?? [];
  const note = gaps.length && list[0]!.distanceM > 1500
    ? L(s, `${gaps.join(", ")} зараз не відповідає — можуть бути ближчі`, `${gaps.join(", ")} is not answering — there may be closer ones`)
    : L(s, "доступність перевіряйте на місці", "check access on arrival");
  const others = list.slice(1).map((p) => `${p.name} — ${dist(s, p.distanceM)}`).join("; ");
  if (others) lines.push(L(s, `Ще: ${others}; ${note}.`, `Also: ${others}; ${note}.`));
  else lines.push(note.charAt(0).toUpperCase() + note.slice(1) + ".");
  return { lines, actions: [walkTo(s, list[0]!)], tone, used, places: list };
});

registerHandler("alert", (s, ctx) => {
  const d = classic(s, "що з тривогою", ["alert.active", "alert.scope", "alert.since", "alert.reasons", "places.shelter"], s.alert?.active ? "critical" : "calm");
  if (!s.alert || s.alert.active == null) d.missing = ["alert"];
  return d;
});

registerHandler("place", (s, ctx) => {
  // A typo-tolerant category, then the place search answer for it.
  const k = placeKindOf(ctx.question);
  const q = k ? L(s, `де ${k.canonical}`, `where is ${k.canonical}`) : ctx.question;
  const d = classic(s, q, [`places.${k?.kind ?? "?"}`, `placeStates.${k?.kind ?? "?"}`, `placeGaps.${k?.kind ?? "?"}`]);
  if (k && !(s.places[k.kind]?.length)) d.missing = [`places.${k.kind}`];
  return d;
});

registerHandler("emergency", (s) => {
  const where = [s.position.street, s.position.area].filter(Boolean).join(", ");
  const lines = [
    L(s, "Телефонуйте 112 (або 103 — швидка) зараз.", "Call 112 (or 103 — ambulance) now."),
    where ? L(s, `Назвіть місце: ${where}${dr(s) ? " (приблизно — GPS немає)" : ""}.`, `Give the place: ${where}${dr(s) ? " (approximate — no GPS)" : ""}.`) : L(s, "Назвіть найближчий орієнтир — адресу, АЗС, зупинку.", "Name the nearest landmark — an address, a fuel station, a stop."),
    L(s, "Не рухайте постраждалого без потреби; якщо кровотеча — тисніть на рану.", "Don't move the injured person unless needed; if bleeding, press on the wound."),
  ];
  return { lines, actions: [{ kind: "call", label: L(s, "Подзвонити 112", "Call 112"), number: "112" }, { kind: "call", label: L(s, "Швидка 103", "Ambulance 103"), number: "103" }], tone: "critical", used: ["position.street", "position.area", "gnss.mode"] };
});
registerHandler("classic", (s, ctx) => classic(s, ctx.question, ["world"]));

registerHandler("status", (s) => {
  const lines: string[] = [];
  const used: string[] = [];
  let tone: Tone = "calm";
  const shelter = nearestShelter(s);
  if (s.alert?.active) {
    // Crisis: the alert and the shelter in one sentence, then GPS, then the trip.
    const where = L(s, s.alert.scope === "region" ? "по області" : s.alert.scope === "city" ? "у місті" : "у вашому районі", s.alert.scope === "region" ? "across the oblast" : s.alert.scope === "city" ? "in the city" : "in your district");
    const since = s.alert.since ? L(s, ` з ${formatClock(s.alert.since, s.lang)}`, ` since ${formatClock(s.alert.since, s.lang)}`) : "";
    lines.push(shelter
      ? L(s, `Тривога ${where}${since}: найближче укриття — ${shelter.name}, ${dist(s, shelter.distanceM)}.`, `Air alert ${where}${since}: nearest shelter ${shelter.name}, ${dist(s, shelter.distanceM)}.`)
      : L(s, `Тривога ${where}${since}; даних про укриття поруч немає.`, `Air alert ${where}${since}; no shelter data nearby.`));
    used.push("alert.active", "alert.scope", "alert.since", "places.shelter");
    tone = "critical";
  } else if (s.alert?.active === false) { lines.push(L(s, "Тривоги у вашому районі немає.", "No air alert in your area.")); used.push("alert.active"); }
  else { lines.push(L(s, "Статус тривоги зараз невідомий.", "The air alert status is unknown right now.")); used.push("alert"); }
  const g = gpsLine(s);
  lines.push(g.line);
  used.push(...g.used);
  if (s.gnss.mode === "navigator") { lines[lines.length - 1] = g.line.replace(/\.$/, "") + L(s, " — веду за рахунком шляху.", " — guiding by dead reckoning."); tone = "critical"; }
  else if (s.gnss.mode === "degraded" && tone === "calm") tone = "warning";
  if (s.route) {
    const trip = s.route.offRoute ? L(s, "Ви поза маршрутом", "You're off the route") : L(s, `До «${s.route.destination}» — ${dist(s, s.route.remainingM)}`, `${dist(s, s.route.remainingM)} to “${s.route.destination}”`);
    const next = s.route.offRoute || tone === "critical" ? null : nextLine(s, false);
    lines.push(next ? `${trip}; ${L(s, "далі", "next")}: ${next.charAt(0).toLowerCase()}${next.slice(1)}` : `${trip}.`);
    used.push("route.offRoute", "route.remainingM", "route.next");
  }
  if (!s.online) { lines.push(L(s, "Інтернету немає — працюю з тим, що збережено на телефоні.", "No internet — working from what's saved on the phone.")); used.push("online"); }
  return { lines, actions: s.alert?.active && shelter ? [walkTo(s, shelter)] : [], tone, used };
});

registerHandler("repeat", (s, ctx) => ctx.lastReply
  ? { lines: [ctx.lastReply], actions: [], tone: "calm", used: ["lastReply"] }
  : { lines: [L(s, "У цій розмові ще не було відповіді, яку можна повторити.", "I haven't said anything yet in this conversation.")], actions: [], tone: "calm", used: [], missing: ["lastReply"] });

// ——— explain: which real data an answer was built from ———

const INTENT_WORDS: Record<NavigatorIntent, string> = {
  repeat: "повтор", explain: "пояснення", emergency: "екстрена ситуація", signalLost: "втрата сигналу GPS", gpsStatus: "стан GPS",
  onRoute: "чи правильно їдете", reroute: "відхилення від маршруту", routeNext: "наступний маневр", eta: "скільки лишилось",
  whereAmI: "де ви", shelter: "укриття", alert: "тривога", status: "загальна обстановка", place: "місця поруч",
  noData: "дані, яких NAVIA не має", smalltalk: "розмова", classic: "загальне питання", unknown: "нерозпізнане питання",
  general: "загальне питання (мовна модель)", speed: "швидкість", dataSource: "реальні дані чи демо", frustration: "невдоволення відповіддю", confidence: "точність позиції", routeWhy: "чому цей маршрут", shelterWhy: "чи найближче укриття", emotion: "страх, паніка", offline: "робота без інтернету", clarify: "уточнення",
};

/** A snapshot field in words, with its value at the time of the answer. */
export function fieldWords(field: string, s: Snapshot): string | null {
  const r = s.route;
  switch (field) {
    case "gnss.state": return `стан GNSS від рушія навігації: ${s.gnss.state === "NORMAL" ? "норма" : s.gnss.state === "DEGRADED" ? "погіршений" : "втрачено"}`;
    case "gnss.mode": return `режим: ${s.gnss.mode === "normal" ? "звичайний" : s.gnss.mode === "degraded" ? "сигнал нестабільний" : "штурман (рахунок шляху)"}`;
    case "gnss.sinceFixS": return s.gnss.sinceFixS != null ? `останній надійний сигнал: ${ago(s, s.gnss.sinceFixS)}` : null;
    case "gnss.accuracyM": return s.gnss.accuracyM != null ? `точність сигналу ±${m(s.gnss.accuracyM)} м` : null;
    case "gnss.trend": return s.gnss.trend ? `ознаки погіршення: ${s.gnss.trend}` : null;
    case "position.source": return `джерело позиції: ${s.position.source === "GNSS" ? "супутники" : s.position.source === "FUSED" ? "супутники + датчики" : s.position.source === "DEAD_RECKONING" ? "рахунок шляху" : s.position.source === "MANUAL" ? "точка, вказана вручну" : "немає"}`;
    case "position.uncertaintyM": return s.position.uncertaintyM != null ? `похибка позиції ±${m(s.position.uncertaintyM)} м` : null;
    case "position.street": return s.position.street ? `вулиця: ${s.position.street}` : null;
    case "position.area": return s.position.area ? `район: ${s.position.area}` : null;
    case "position.known": return s.position.known ? "позиція відома" : "позиції немає";
    case "route": case "route.destination": return r ? `маршрут до «${r.destination}»` : "маршруту немає";
    case "route.next": return r?.next ? `наступний маневр: ${r.next.action}${r.next.road ? ` на ${r.next.road}` : ""}${r.next.distanceM != null ? `, ${dist(s, r.next.distanceM)}` : ""}` : null;
    case "route.then": return r?.then ? `потім: ${r.then}` : null;
    case "route.remainingM": return r ? `лишилось ${dist(s, r.remainingM)}` : null;
    case "route.etaS": return r?.etaS != null ? `час у дорозі ≈ ${formatDuration(r.etaS, "uk")}` : null;
    case "route.offRoute": return r ? (r.offRoute ? "ви поза маршрутом" : "ви на маршруті") : null;
    case "route.landmarks": return r ? `орієнтирів на маршруті: ${r.landmarks}` : null;
    case "route.behind": return r?.behind ? `позаду: ${r.behind}` : null;
    case "route.ahead": return r?.ahead ? `попереду: ${r.ahead}` : null;
    case "alert": case "alert.active": return s.alert?.active == null ? "статус тривоги невідомий" : s.alert.active ? "тривога активна" : "тривоги немає";
    case "alert.scope": return s.alert?.scope ? `де тривога: ${s.alert.scope === "region" ? "область" : s.alert.scope === "city" ? "місто" : "ваш район"}` : null;
    case "alert.since": return s.alert?.since ? `оголошено о ${formatClock(s.alert.since, "uk")}` : null;
    case "places.shelter": { const p = s.places.shelter?.[0]; return p ? `найближче укриття: ${p.name}, ${dist(s, p.distanceM)}` : "укриттів у даних немає"; }
    case "online": return s.online ? "інтернет є" : "інтернету немає";
    case "lastReply": return "попередня відповідь";
    case "fields.drErrorGrowthMPerMin": return s.fields.drErrorGrowthMPerMin != null ? `ріст похибки без GPS ≈ ${m(s.fields.drErrorGrowthMPerMin)} м/хв за поточної швидкості` : null;
    case "fields.speedMps": return s.fields.speedMps != null ? `швидкість ${Math.round(s.fields.speedMps * 3.6)} км/год` : "швидкість невідома";
    case "fields.positionConfidence": return `впевненість у позиції ${Math.round(s.fields.positionConfidence * 100)} % (${s.fields.positionConfidenceBand})`;
    case "fields.positionSource": return `джерело позиції: ${s.fields.positionSource}`;
    case "fields.reroutingInProgress": return s.fields.reroutingInProgress ? "новий маршрут будується" : null;
    case "fields.offlinePackageAvailable": return s.fields.offlinePackageAvailable == null ? "стан офлайн-пакета невідомий" : s.fields.offlinePackageAvailable ? "офлайн-пакет «Київ + область» є" : "офлайн-пакета немає";
    case "fields.nearbyShelters": return s.fields.nearbyShelters.length ? `укриття за відстанню: ${s.fields.nearbyShelters.slice(0, 3).map((p) => `${p.label} ${dist(s, p.distanceM)}`).join(", ")}` : "укриттів у даних немає";
    case "fields.snapshotTimestamp": return `дані на ${formatClock(s.fields.snapshotTimestamp, "uk")}`;
    default: return null;
  }
}

registerHandler("explain", (s, ctx) => {
  const last = ctx.last;
  if (!last) return { lines: [L(s, "Пояснювати ще нічого: у цій розмові ще не було відповіді.", "Nothing to explain yet: there has been no answer in this conversation.")], actions: [], tone: "calm", used: [], missing: ["lastAnswer"], honest: true };
  const facts = [...new Set(last.used.map((f) => fieldWords(f, last.snapshot)).filter((x): x is string => !!x))];
  const lack = [...new Set(last.missing.map((f) => fieldWords(f, last.snapshot) ?? f))];
  const at = formatClock(last.snapshot.at, s.lang);
  const lines = [L(s, `Питання «${last.question}» розпізнано як «${INTENT_WORDS[last.intent]}».`, `The question “${last.question}” was recognised as “${last.intent}”.`)];
  if (facts.length) lines.push(L(s, `Відповідь — з даних NAVIA на ${at}: ${facts.slice(0, 4).join("; ")}.`, `The answer comes from NAVIA's data as of ${at}: ${facts.slice(0, 4).join("; ")}.`));
  else lines.push(L(s, "Ця відповідь не спиралась на дані навігації — це загальне пояснення можливостей.", "That answer did not rely on navigation data — it was a general explanation."));
  if (lack.length) lines.push(L(s, `Чого в даних не було: ${lack.join("; ")} — тому відповідь про це чесно каже.`, `Missing from the data: ${lack.join("; ")} — so the answer says so.`));
  return { lines, actions: [], tone: "calm", used: ["lastAnswer"] };
});

// ——— data NAVIA does not have ———

function noDataTopic(q: string): { uk: string; en: string; why: string } {
  const f = q.toLocaleLowerCase("uk-UA");
  if (/пробк|затор|траф|traffic|корок/.test(f)) return { uk: "пробки", en: "traffic", why: "NAVIA не отримує даних про трафік — навігатор працює без онлайн-сервісів трафіку, щоб не залежати від зв'язку під час тривоги" };
  if (/погод|дощ|дожд|сніг|снег|ожелед|гололед|туман|видим|вітер|ветер|weather|rain|snow|wind|visib|температур/.test(f)) return { uk: "погоду й видимість", en: "the weather and visibility", why: "прогнозу погоди й даних про видимість у NAVIA немає" };
  if (/комендант|curfew/.test(f)) return { uk: "комендантську годину", en: "the curfew", why: "її час у вашому місті NAVIA не знає — перевірте в оголошеннях місцевої влади" };
  if (/(^|\s)(міст|мосту?|мості|bridge)(\s|\?|$)/.test(f)) return { uk: "стан мосту", en: "the bridge", why: "даних про перекриття мостів і доріг у реальному часі NAVIA не має" };
  if (/камер|радар|штраф|speed/.test(f)) return { uk: "камери й штрафи", en: "cameras and fines", why: "бази камер і радарів у NAVIA немає" };
  if (/дтп|авар|accident|ремонт|roadwork|перекр|блокпост|checkpoint/.test(f)) return { uk: "ДТП, ремонти й перекриття", en: "accidents, roadworks and closures", why: "даних про події на дорогах у реальному часі NAVIA не має" };
  if (/бензин|пальн|топлив|курс|цін|цен|кошту|стоит|(^|\s)почому(\s|\?|$)|(^|\s)почём?(\s|\?|$)|price/.test(f)) return { uk: "ціни й курси", en: "prices and rates", why: "цін і курсів у NAVIA немає" };
  return { uk: "це", en: "that", why: "NAVIA — навігатор і штурман для дороги; новин, розваг чи довідки на загальні теми в ньому немає" };
}

registerHandler("noData", (s, ctx) => {
  const t = noDataTopic(ctx.question);
  const lines: string[] = [];
  // An accident may be the driver's own: safety first.
  if (/дтп|авар|accident/i.test(ctx.question)) lines.push(L(s, "Якщо ви потрапили в ДТП або є постраждалі — телефонуйте 112 (швидка — 103).", "If you were in an accident or someone is hurt, call 112."));
  lines.push(L(s, `Про ${t.uk} сказати не можу: ${t.why}.`, `I can't tell you about ${t.en}: NAVIA has no such data.`));
  const used: string[] = [];
  if (s.route) {
    lines.push(L(s, `Що відомо: до «${s.route.destination}» лишилось ${dist(s, s.route.remainingM)}${s.route.etaS != null ? `, розрахунково ${formatDuration(s.route.etaS, "uk")} — без урахування трафіку` : ""}.`, `What is known: ${dist(s, s.route.remainingM)} to “${s.route.destination}”${s.route.etaS != null ? `, about ${formatDuration(s.route.etaS, "en")} without traffic` : ""}.`));
    used.push("route.remainingM", "route.etaS");
  } else {
    const g = gpsLine(s);
    lines.push(g.line);
    used.push(...g.used);
  }
  return { lines, actions: [], tone: "calm", used, missing: [t.uk] };
});

// ——— small talk: short, then the situation in one line ———

registerHandler("smalltalk", (s, ctx) => {
  const f = ctx.question.toLocaleLowerCase("uk-UA");
  const thanks = /дяку|спасиб|thank|мерси/.test(f);
  const who = /хто ти|ти хто|кто ты|ты кто|who are you/.test(f);
  const head = who
    ? L(s, "Це NAVIA — штурман для дороги під час тривог і глушіння GPS: веде за маршрутом навіть без сигналу й підказує, де укриття.", "This is NAVIA — a navigator for driving during air alerts and GPS jamming.")
    : thanks ? L(s, "Будь ласка.", "You're welcome.")
      : L(s, "На зв'язку.", "Here with you.");
  const g = gpsLine(s);
  const lines = [head, g.line];
  if (s.alert?.active) lines.push(L(s, "Увага: тривога у вашому районі.", "Note: air alert in your area."));
  else if (s.route && !s.route.offRoute) { const n = nextLine(s, true); if (n) lines.push(n); }
  return { lines, actions: [], tone: s.alert?.active ? "critical" : "calm", used: [...g.used, "alert.active", "route.next"] };
});


// ——— position confidence (А) ———

registerHandler("confidence", (s) => {
  const f = s.fields;
  const pct = Math.round(f.positionConfidence * 100);
  const band = ({ HIGH: L(s, "висока", "high"), MEDIUM: L(s, "середня", "medium"), LOW: L(s, "низька", "low"), UNKNOWN: L(s, "невідома", "unknown") } as Record<string, string>)[f.positionConfidenceBand] ?? f.positionConfidenceBand;
  const used = ["fields.positionSource", "fields.positionConfidence", "gnss.accuracyM", "position.uncertaintyM"];
  if (!s.position.known) return { lines: [L(s, "Ні: позиції зараз немає — GPS ще не дав жодної точки, а маршруту для рахунку шляху немає.", "No: there's no position yet — GPS has given no fix and there's no route for dead reckoning.")], actions: [], tone: "warning", used: ["position.known"], missing: ["position"], honest: true };
  if (s.gnss.mode === "navigator") {
    const unc = s.position.uncertaintyM != null ? L(s, `, похибка ±${m(s.position.uncertaintyM)} м`, `, error ±${m(s.position.uncertaintyM)} m`) : "";
    const rate = f.drErrorGrowthMPerMin != null ? L(s, ` і росте ≈ ${m(f.drErrorGrowthMPerMin)} м/хв`, ` and growing ≈ ${m(f.drErrorGrowthMPerMin)} m/min`) : "";
    return { lines: [L(s, `Не повністю: GPS немає ${s.gnss.sinceFixS != null ? ago(s, s.gnss.sinceFixS).replace(" тому", "") : ""}, позиція — за рахунком шляху.`.replace("немає , ", "немає, "), `Not fully: no GPS, the position is dead-reckoned.`), L(s, `Впевненість ${band} (${pct} %)${unc}${rate}.`, `Confidence ${band} (${pct} %)${unc}${rate}.`)], actions: [], tone: "warning", used: [...used, "gnss.sinceFixS", "fields.drErrorGrowthMPerMin"] };
  }
  const acc = s.gnss.accuracyM != null ? L(s, `, точність ±${m(s.gnss.accuracyM)} м`, `, accuracy ±${m(s.gnss.accuracyM)} m`) : "";
  const src = f.positionSource === "FUSED" ? L(s, "GPS + датчики телефона", "GPS + phone sensors") : L(s, "GPS", "GPS");
  if (s.gnss.mode === "degraded") return { lines: [L(s, `Частково: джерело — ${src}, але сигнал нестабільний${acc}.`, `Partly: the source is ${src}, but the signal is unstable${acc}.`), L(s, `Впевненість ${band} (${pct} %); позиція може трохи стрибати.`, `Confidence ${band} (${pct} %); the position may jump a little.`)], actions: [], tone: "warning", used };
  return { lines: [L(s, `Так, позиція достовірна: джерело — ${src}${acc}.`, `Yes, the position is reliable: source ${src}${acc}.`), L(s, `Впевненість ${band} (${pct} %).`, `Confidence ${band} (${pct} %).`)], actions: [], tone: "calm", used };
});

// ——— why this route (В) ———

registerHandler("routeWhy", (s) => {
  if (!s.route) return noRoute(s);
  const how = s.route.mode === "walk" ? L(s, "пішохідний", "walking") : L(s, "автомобільний", "driving");
  const eta = s.route.etaS != null ? L(s, `, ≈ ${formatDuration(s.route.etaS, "uk")}`, `, ≈ ${formatDuration(s.route.etaS, "en")}`) : "";
  return {
    lines: [
      L(s, `Маршрут прокладено сервісом Valhalla за картою OpenStreetMap як найшвидший ${how}: ${dist(s, s.route.remainingM)} до «${s.route.destination}»${eta}.`, `The route was built by Valhalla on OpenStreetMap as the fastest ${how} one: ${dist(s, s.route.remainingM)} to “${s.route.destination}”${eta}.`),
      L(s, "Інших варіантів сервіс не повертав, тож порівняти з ними в метрах чи хвилинах нема з чим; пробки не враховуються — даних про них немає.", "The service returned no alternatives, so there's nothing to compare in metres or minutes; traffic isn't considered — there's no traffic data."),
    ],
    actions: [], tone: "calm", used: ["route.remainingM", "route.etaS", "route.destination", "route.mode"], missing: ["alternatives"],
  };
});

// ——— is it really the nearest shelter (Г) ———

registerHandler("shelterWhy", (s) => {
  const list = (s.places.shelter ?? []).slice(0, 3);
  if (list.length === 0) return handlerFor("shelter")(s, { question: "", lastReply: null });
  const ord = ["перше", "друге", "третє"], ordEn = ["first", "second", "third"];
  const top = list.map((p, i) => `${L(s, ord[i]!, ordEn[i]!)} — ${p.name}, ${dist(s, p.distanceM)}`).join("; ");
  const Top = top.charAt(0).toUpperCase() + top.slice(1);
  const src = [...new Set(list.map((p) => p.source).filter(Boolean))].join(", ");
  return {
    lines: [
      L(s, `Так, найближче з відомих: укриття відсортовані за відстанню від вас по прямій. ${Top}.`, `Yes, the nearest known: shelters are sorted by straight-line distance from you. ${Top}.`),
      L(s, `Дані${src ? ` (${src})` : ""} на ${formatClock(s.at, s.lang)}; пішки по вулицях шлях може бути довшим.`, `Data${src ? ` (${src})` : ""} as of ${formatClock(s.at, s.lang)}; on foot the way along streets may be longer.`),
    ],
    actions: [walkTo(s, list[0]!)], tone: s.alert?.active ? "critical" : "calm", used: ["places.shelter", "fields.nearbyShelters", "fields.snapshotTimestamp"], places: list,
  };
});

// ——— fear, panic (З): short, calm, one concrete step ———

registerHandler("emotion", (s) => {
  const lines = [L(s, "Розумію, NAVIA поруч і стежить за ситуацією.", "I understand; NAVIA is here and watching the situation.")];
  const used: string[] = ["alert.active", "gnss.mode", "route"];
  const shelter = nearestShelter(s);
  let step: string;
  let actions: CopilotAction[] = [];
  if (s.alert?.active) {
    lines.push(shelter ? L(s, `Тривога: найближче укриття — ${shelter.name}, ${dist(s, shelter.distanceM)}.`, `Air alert: nearest shelter ${shelter.name}, ${dist(s, shelter.distanceM)}.`) : L(s, "Тривога; даних про укриття поруч немає.", "Air alert; no shelter data nearby."));
    step = shelter ? L(s, "Зараз одне: йдіть до укриття — кнопка нижче.", "One thing now: go to the shelter — button below.") : L(s, "Зараз одне: капітальне приміщення без вікон, подалі від скла.", "One thing now: a solid room without windows, away from glass.");
    if (shelter) actions = [walkTo(s, shelter)];
    used.push("places.shelter");
  } else {
    const gps = s.gnss.mode === "normal" ? L(s, "GPS у нормі", "GPS is fine") : s.gnss.mode === "degraded" ? L(s, "GPS нестабільний, але працює", "GPS is unstable but working") : L(s, "GPS немає, але маршрут ведеться за рахунком шляху", "no GPS, but the route is followed by dead reckoning");
    const route = s.route ? (s.route.offRoute ? L(s, "ви поза маршрутом", "you're off the route") : L(s, `до «${s.route.destination}» ${dist(s, s.route.remainingM)}`, `${dist(s, s.route.remainingM)} to “${s.route.destination}”`)) : L(s, "маршруту немає", "no route");
    lines.push(L(s, `Зараз: ${gps}, ${route}.`, `Now: ${gps}, ${route}.`));
    step = s.route && (s.motion.speedKmh ?? 0) > 5
      ? L(s, "Зараз одне: зменште швидкість і, де безпечно, зупиніться на кілька вдихів.", "One thing now: slow down and, where safe, stop for a few breaths.")
      : L(s, "Зараз одне: кілька повільних вдихів; якщо комусь потрібна допомога — 112.", "One thing now: a few slow breaths; if someone needs help, call 112.");
    used.push("route.remainingM", "motion.speedKmh");
  }
  lines.push(step);
  return { lines, actions, tone: s.alert?.active ? "critical" : "warning", used };
});

// ——— speed: the real value from the motion data; the limit is not known ———

registerHandler("speed", (s) => {
  const v = s.motion.speedKmh;
  if (v == null) return { lines: [L(s, "Швидкість зараз невідома: даних руху немає.", "Your speed is unknown right now: no motion data.")], actions: [], tone: "calm", used: ["motion.speedKmh"], missing: ["motion.speedKmh"], honest: true };
  const estimate = s.gnss.mode === "navigator" ? L(s, " (оцінка без GPS)", " (estimated without GPS)") : "";
  return {
    lines: [
      L(s, `Швидкість зараз — ${v} км/год${estimate}.`, `Speed now: ${v} km/h${estimate}.`),
      L(s, "Обмеження швидкості на цій ділянці NAVIA не знає — орієнтуйтеся на знаки.", "NAVIA doesn't know the speed limit here — follow the signs."),
    ],
    actions: [], tone: "calm", used: ["motion.speedKmh", "gnss.mode"], missing: ["speedLimit"],
  };
});

// ——— real data or demo, and how fresh it is ———

registerHandler("dataSource", (s) => {
  const lines: string[] = [];
  const used = ["fields.isDemoMode", "position.source", "gnss.sinceFixS", "online"];
  if (s.fields.isDemoMode) lines.push(L(s, "Зараз демо-режим: позиція й маршрут навчальні, не ваші реальні.", "Demo mode is on: the position and route are for practice, not your real ones."));
  else {
    const src = s.position.source === "GNSS" ? L(s, "супутники", "satellites") : s.position.source === "FUSED" ? L(s, "супутники й датчики телефона", "satellites and the phone's sensors") : s.position.source === "DEAD_RECKONING" ? L(s, "рахунок шляху без GPS", "dead reckoning without GPS") : s.position.source === "MANUAL" ? L(s, "точка, вказана вручну", "a point set by hand") : null;
    const age = s.gnss.sinceFixS != null ? L(s, `, останній сигнал ${ago(s, s.gnss.sinceFixS)}`, `, last fix ${ago(s, s.gnss.sinceFixS)}`) : "";
    lines.push(src ? L(s, `Дані реальні: позиція — ${src}${age}.`, `The data is real: position from ${src}${age}.`) : L(s, "Реальної позиції зараз немає.", "There is no real position right now."));
  }
  if (s.fields.nearbyShelters.some((x) => x.source === "demo")) lines.push(L(s, "Частина укриттів — демонстраційні, не з відкритих даних.", "Some shelters are demo ones, not from open data."));
  lines.push(s.online ? L(s, "Інтернет є, дані про тривоги оновлюються.", "Online: alert data is updating.") : L(s, "Інтернету немає: тривоги не оновлюються, карта й укриття — збережені на телефоні.", "Offline: alerts are not updating; map and shelters are the ones saved on the phone."));
  return { lines, actions: [], tone: "calm", used };
});

// ——— irritation: no excuses, one useful line ———

registerHandler("frustration", (s) => {
  const lines = [L(s, "Скажіть коротко, що потрібно, — відповім по суті.", "Say briefly what you need and you'll get a straight answer.")];
  const used: string[] = [];
  const shelter = nearestShelter(s);
  if (s.alert?.active && shelter) { lines.push(L(s, `Зараз головне: тривога, укриття — ${shelter.name}, ${dist(s, shelter.distanceM)}.`, `Most important now: air alert, shelter ${shelter.name}, ${dist(s, shelter.distanceM)}.`)); used.push("alert.active", "places.shelter"); }
  else if (s.route && !s.route.offRoute) { const n = nextLine(s, true); if (n) { lines.push(n); used.push("route.next"); } }
  else { const g = gpsLine(s); lines.push(g.line); used.push(...g.used); }
  return { lines, actions: [ask(L(s, "Куди далі?", "What's next?")), ask(L(s, "Де укриття?", "Where's a shelter?"))], tone: "calm", used };
});

// ——— no internet (И) ———

registerHandler("offline", (s) => {
  const pkg = s.fields.offlinePackageAvailable;
  const lines = [s.online ? L(s, "Інтернет зараз є.", "There's internet now.") : L(s, "Інтернету немає. GPS і ведення за маршрутом працюють і без нього.", "No internet. GPS and route guidance work without it.")];
  lines.push(pkg == null ? L(s, "Чи є на телефоні офлайн-пакет — невідомо (стан не прочитано).", "Whether the offline package is on the phone is unknown (status not read).")
    : pkg ? L(s, "Офлайн-пакет «Київ + область» є: карта, пошук і укриття працюють без мережі.", "The Kyiv + oblast offline package is here: map, search and shelters work without network.")
      : L(s, "Офлайн-пакета немає: без мережі працює лише карта, збережена вздовж маршруту.", "No offline package: without network only the map saved along the route works."));
  if (!s.online) lines.push(s.route ? L(s, "Маршрут, прокладений раніше, веде й далі; новий без інтернету не прокласти.", "The route built earlier keeps guiding; a new one can't be built without internet.") : L(s, "Новий маршрут без інтернету не прокласти.", "A new route can't be built without internet."));
  return { lines, actions: [], tone: s.online ? "calm" : "warning", used: ["online", "fields.offlinePackageAvailable", "route"], ...(pkg == null ? { missing: ["fields.offlinePackageAvailable"] } : {}) };
});

// ——— not sure what is asked: ask back ———

const TOPIC: Partial<Record<NavigatorIntent, [string, string]>> = {
  explain: ["те, чому попередня відповідь саме така", "why the previous answer was so"],
  signalLost: ["втрату сигналу GPS", "losing the GPS signal"], gpsStatus: ["стан GPS", "the GPS status"], confidence: ["точність вашої позиції", "how accurate your position is"],
  routeNext: ["наступний поворот", "the next turn"], eta: ["скільки лишилось їхати", "how far is left"], onRoute: ["чи правильно ви їдете", "whether you're on the right way"],
  reroute: ["відхилення від маршруту", "leaving the route"], routeWhy: ["чому саме цей маршрут", "why this route"], whereAmI: ["де ви зараз", "where you are"],
  shelter: ["найближче укриття", "the nearest shelter"], shelterWhy: ["чи це найближче укриття", "whether it's the nearest shelter"], alert: ["тривогу", "the air alert"],
  status: ["загальну обстановку", "the overall situation"], offline: ["роботу без інтернету", "working without internet"], emotion: ["що робити, коли страшно", "what to do when scared"],
  noData: ["дані, яких у NAVIA немає", "data NAVIA doesn't have"], place: ["місця поруч", "places nearby"],
  speed: ["вашу швидкість", "your speed"], dataSource: ["чи дані реальні", "whether the data is real"],
};

registerHandler("clarify", (s, ctx) => {
  const opts = (ctx.options ?? []).filter((o) => TOPIC[o]).slice(0, 2);
  const words = opts.map((o) => L(s, TOPIC[o]![0], TOPIC[o]![1]));
  const q = words.length === 2 ? L(s, `Уточніть, будь ласка: ви питаєте про ${words[0]} чи про ${words[1]}?`, `Could you clarify: are you asking about ${words[0]} or about ${words[1]}?`)
    : words.length === 1 ? L(s, `Уточніть, будь ласка: ви питаєте про ${words[0]}?`, `Could you clarify: are you asking about ${words[0]}?`)
      : L(s, "Уточніть, будь ласка, про що питання.", "Could you clarify the question?");
  const asks: Record<string, [string, string]> = { explain: ["Чому ти так відповів?", "Why did you say that?"], signalLost: ["Що робити без GPS?", "What to do without GPS?"], gpsStatus: ["Що з GPS?", "What about GPS?"], confidence: ["Наскільки точна моя позиція?", "How accurate is my position?"], routeNext: ["Куди далі?", "What's next?"], eta: ["Скільки лишилось?", "How far is left?"], onRoute: ["Я правильно їду?", "Am I on the right way?"], reroute: ["Я з'їхав з маршруту?", "Did I leave the route?"], routeWhy: ["Чому цей маршрут?", "Why this route?"], whereAmI: ["Де я?", "Where am I?"], shelter: ["Де укриття?", "Where's a shelter?"], shelterWhy: ["Це точно найближче укриття?", "Is it really the nearest shelter?"], alert: ["Що з тривогою?", "What about the alert?"], status: ["Статус", "Status"], offline: ["Що працює без інтернету?", "What works offline?"], emotion: ["Мені страшно", "I'm scared"], noData: ["Які є дані?", "What data is there?"], place: ["Що є поруч?", "What's nearby?"] };
  return { lines: [q], actions: opts.map((o) => ask(L(s, asks[o]![0], asks[o]![1]))), tone: "calm", used: [], missing: ["intent"], honest: true };
});

// "general": answered by the language model (askSmart); this handler is used
// only when its wording did not pass the snapshot check.
registerHandler("general", (s, ctx) => handlerFor("unknown")(s, ctx));

registerHandler("unknown", (s) => ({
  lines: [
    L(s, "Мовна модель зараз недоступна, тож на це питання відповісти не вийде. Про дорогу — маршрут, GPS, тривоги, укриття, місця поруч, роботу без інтернету — відповідь є завжди.", "The language model is not available right now, so this question can't be answered. About the road — route, GPS, alerts, shelters, places nearby, working offline — there is always an answer."),
    L(s, "Спробуйте, наприклад: «куди далі», «що з GPS», «де укриття».", "Try, for example: “what's next”, “what about GPS”, “where's a shelter”."),
  ],
  actions: [ask(L(s, "Що далі?", "What's next?")), ask(L(s, "Де укриття?", "Where's a shelter?")), ask(L(s, "Статус", "Status"))],
  tone: "calm", used: [], missing: ["intent"], honest: true,
}));
