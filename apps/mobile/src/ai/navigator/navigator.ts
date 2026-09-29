// NAVIA navigator — LAYER 5 (response generator) and the entry points that
// tie the layers together, plus LAYER 4 (proactive messages).
//   question → classify (2) → handler (3) on the snapshot (1) → generate (5)
//   state change → ProactiveMonitor (4) → generate (5) → voice (interrupts)
// Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import { NavigatorModeTracker, modeFacts } from "../../navigation/navigatorMode";
import { understand, type NavigatorIntent } from "./intents";
import { fieldWords, handlerFor, type Draft, type LastAnswer, type Tone } from "./handlers";
import type { Snapshot } from "./snapshot";
import type { CopilotAction, WorldPlace } from "../copilotBrain";
import { formatClock } from "../../i18n/format";

export type NavigatorReply = {
  intent: NavigatorIntent;
  /** Which level understood the question. */
  engine?: "rules" | "llm";
  text: string;
  /** The same answer for the voice: no bullets, no line breaks. */
  speech: string;
  actions: CopilotAction[];
  tone: Tone;
  /** Snapshot fields the answer is built from (programme: requiresData). */
  used: string[];
  missing: string[];
  /** An honest refusal / "not known" with a reason. */
  honest: boolean;
  /** Layer 2 confidence (0..1) of the understood intent. */
  confidence: number;
  /** Time to compute the answer (ms). */
  computeMs: number;
  places?: WorldPlace[];
};

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** LAYER 5: one voice for every answer — short, confident, no filler. */
export function generate(draft: Draft): { text: string; speech: string } {
  const seen = new Set<string>();
  const lines = draft.lines
    .flatMap((l) => l.split("\n"))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !seen.has(l) && (seen.add(l), true));
  const text = lines.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join("\n");
  const speech = lines
    .map((l) => l.replace(/^\s*(\d+\.|•)\s*/, "").replace(/[«»“”]/g, "").replace(/±/g, "плюс-мінус "))
    .map((l) => (/[.!?:]$/.test(l) ? l : `${l}.`))
    .join(" ");
  return { text, speech };
}

const CRISIS_INTENTS = new Set<NavigatorIntent>(["signalLost", "shelter", "shelterWhy", "alert", "emotion", "emergency"]);

/** Keeps the first `max` sentences of the lines (a line may hold several). */
export function capSentences(lines: string[], max: number): string[] {
  const out: string[] = [];
  let count = 0;
  for (const line of lines) {
    const parts = line.split(/(?<=[.!?])\s+(?=[А-ЯІЇЄҐA-Z«“])/).filter((x) => x.trim());
    const keep: string[] = [];
    for (const p of parts) { if (count >= max) break; keep.push(p); count++; }
    if (keep.length) out.push(keep.join(" "));
    if (count >= max) break;
  }
  return out;
}

export class Navigator {
  private lastReply: string | null = null;

  previousAnswer(): string | null {
    return this.lastReply;
  }
  private last: LastAnswer | null = null;

  /** `forced`: the intent recognised by the server's language model (it
   * decides only what is asked; the answer still comes from the snapshot). */
  ask(question: string, snapshot: Snapshot, forced?: NavigatorIntent): NavigatorReply {
    const t0 = now();
    const u = forced ? { intent: forced, confidence: 1, options: [] as NavigatorIntent[] } : understand(question);
    const intent = u.intent;
    // The previous answer is part of the context ("repeat").
    snapshot = { ...snapshot, fields: { ...snapshot.fields, lastNavaResponse: this.lastReply } };
    const draft = handlerFor(intent)(snapshot, { question, lastReply: this.lastReply, last: this.last, options: u.options });
    // Only fields that really had a value (so "why" never cites empty data).
    draft.used = draft.used.filter((f) => f === "lastAnswer" || f === "lastReply" || f.startsWith("places") || f.startsWith("placeStates") || f.startsWith("placeGaps") || fieldWords(f, snapshot) !== null);
    // Crisis answers (alert, shelter, lost signal, fear, critical tone): at
    // most three sentences — the handlers put the essential first; this is
    // the safety net (programme 2.5).
    if (draft.tone === "critical" || CRISIS_INTENTS.has(intent)) draft.lines = capSentences(draft.lines, 3);
    const { text, speech } = generate(draft);
    if (intent !== "repeat" && intent !== "explain" && intent !== "clarify") {
      this.lastReply = text;
      this.last = { question, intent, text, used: draft.used, missing: draft.missing ?? [], snapshot };
    }
    const honest = draft.honest ?? (intent === "noData" || intent === "unknown" || (draft.missing?.length ?? 0) > 0);
    return { intent, text, speech, actions: draft.actions, tone: draft.tone, used: draft.used, missing: draft.missing ?? [], honest, confidence: u.confidence, computeMs: now() - t0, ...(draft.places ? { places: draft.places } : {}) };
  }
}

/** Above this local confidence the phone answers at once, without the server. */
export const LOCAL_SURE = 0.85;
const GENERIC = new Set<NavigatorIntent>(["unknown", "smalltalk", "classic", "noData", "general"]);

/**
 * Questions asking for advice, an explanation or something to be written
 * ("що робити, якщо…", "як…", "чи можна…", "що таке…", "порадь", "розкажи",
 * "напиши", "переклади"…). A keyword in them ("укриття", "аптечка",
 * "бензин") makes the rules sure of a topic, but the person is not asking
 * for the nearest shelter or pharmacy — the language model answers these.
 * Direct questions about the trip ("як далеко", "як доїхати") stay local.
 */
const ADVICE = new RegExp([
  "(що|шо|что|чо) (робити|делать|треба|нужно) (якщо|коли|як|если|когда)",
  "(^|\\s)(як|как)\\s(?!далеко|довго (ще )?їхати|долго (ещё |еще )?ехать|доїхати|доехать|проїхати|проехать|туди|туда|ти\\??$|ты\\??$|справи|дела|там)",
  "(чи|або) можна", "можно ли", "(що|шо|что) (таке|такое|означає|значит)", "(чим|чем) (відрізняється|отличается)", "навіщо|зачем|нащо",
  "порадь|посоветуй|підкажи як|подскажи как|розкажи|расскажи|напиши|поясни|объясни|переклади|переведи",
  "анекдот|жарт|шутк|вірш|стих|пісн|песн|музик|рецепт",
  // The car itself: warning lights, engine, battery, tyres — general knowledge, not the trip.
  "check engine|чек енджин|лампочк|перегрі|перегре|двигун|мотор|акумулятор|аккумулятор|колес|шин[аиуо]|пробив|масл[оа]|антифриз|тосол|гальм|тормоз|стартер|генератор",
  "(що|шо|что) (має|повинно|должно) бути|(що|что) (взяти|брать|взять)",
  "\\bhow (do|to|can|should)\\b|\\bwhat (is|should i do if)\\b|\\btell me\\b|\\bwrite\\b|\\bexplain\\b",
].join("|"), "i");

/** When a language model is available: must this question go to it? (Otherwise the phone answers at once.) */
export function wantsModel(question: string, local: { intent: NavigatorIntent; confidence: number }): boolean {
  if (local.intent === "unknown" || local.intent === "clarify" || local.confidence < LOCAL_SURE) return true;
  // Life and the last answer: always at once, on the phone.
  if (local.intent === "emergency" || local.intent === "repeat" || local.intent === "explain") return false;
  return ADVICE.test(question.toLowerCase());
}

/**
 * Layer 2 with the language engine: a confident on-device understanding
 * answers at once; otherwise the server's language model (when available)
 * decides what is asked, and the answer is still built from the snapshot by
 * the handler for that intent. The model's own wording is used only for
 * questions no handler covers, and only when every fact in it is in the
 * snapshot (checkGrounded). No server → the on-device rules (fallback).
 */
export async function askSmart(nav: Navigator, question: string, snapshot: Snapshot): Promise<NavigatorReply> {
  const local = understand(question);
  if (!wantsModel(question, local)) return { ...nav.ask(question, snapshot), engine: "rules" };
  const { understandRemote } = require("./languageEngine") as typeof import("./languageEngine");
  const remote = await understandRemote(question, snapshot, nav.previousAnswer());
  if (!remote || remote.intent === "unknown") return { ...nav.ask(question, snapshot), engine: "rules" };
  const reply = nav.ask(question, snapshot, remote.intent);
  // Fear, loneliness, tiredness outside an alert: the model's own words (a
  // real conversation); during an alert the handler's shelter answer stays.
  const ownWords = GENERIC.has(remote.intent) || (remote.intent === "emotion" && snapshot.alert?.active !== true);
  if (ownWords && remote.answer) {
    const { checkGrounded } = require("./grounding") as typeof import("./grounding");
    if (checkGrounded(remote.answer, snapshot, { general: remote.intent !== "noData" }).ok) {
      const { text, speech } = generate({ lines: [remote.answer], actions: [], tone: reply.tone, used: [] });
      return { ...reply, text, speech, engine: "llm" };
    }
  }
  return { ...reply, engine: "llm" };
}

// ——— LAYER 4: proactive ———

export type ProactiveKind = "gnssDegraded" | "gnssLost" | "gnssRecovered" | "gnssStable" | "alertStarted" | "alertEnded" | "offRoute" | "backOnRoute";
export type ProactiveEvent = { kind: ProactiveKind; priority: number; text: string; speech: string; spoken: boolean; atMs: number };

/** Higher = more urgent; an urgent message interrupts whatever is speaking. */
const PRIORITY: Record<ProactiveKind, number> = { alertStarted: 100, gnssLost: 90, offRoute: 80, gnssDegraded: 70, gnssRecovered: 60, alertEnded: 50, backOnRoute: 40, gnssStable: 10 };

/**
 * Watches the snapshot and reports each critical change once, most urgent
 * first: air alert start/end, GNSS degraded / lost / recovered, off-route /
 * back on route. Nothing is reported on the first look (no "change" yet),
 * except an alert already active at the start of navigation.
 */
export class ProactiveMonitor {
  private gnss = new NavigatorModeTracker();
  private alertActive: boolean | null = null;
  private offRoute: boolean | null = null;
  readonly log: ProactiveEvent[] = [];

  update(state: NavigationState, s: Snapshot, atMs = Date.now()): ProactiveEvent[] {
    const out: ProactiveEvent[] = [];
    const push = (kind: ProactiveKind, lines: string[], spoken = true) => {
      const { text, speech } = generate({ lines, actions: [], tone: "calm", used: [] });
      out.push({ kind, priority: PRIORITY[kind], text, speech, spoken, atMs });
    };
    const uk = s.lang === "uk";

    // GNSS: the same tracker and words as the navigation banner.
    const next = s.route?.next ? { text: s.route.next.road ? `${s.route.next.action} ${uk ? "на" : "onto"} ${s.route.next.road}` : s.route.next.action, distanceM: s.route.next.distanceM } : null;
    const ev = this.gnss.update(state, modeFacts(state, { reasons: s.gnss.trend ?? undefined, hasRoute: !!s.route, next }), s.lang, atMs);
    if (ev) {
      const kind: ProactiveKind = ev.kind === "navigator" ? "gnssLost" : ev.kind === "degraded" ? "gnssDegraded" : ev.kind === "recovered" ? "gnssRecovered" : "gnssStable";
      push(kind, [ev.text], ev.spoken);
    }

    // Air alert at the user's place.
    const active = s.alert?.active ?? null;
    if (active != null && active !== this.alertActive) {
      const first = this.alertActive === null;
      this.alertActive = active;
      if (active) {
        const where = s.alert?.scope === "region" ? (uk ? "по всій області" : "across the oblast") : s.alert?.scope === "city" ? (uk ? "у місті" : "in the city") : (uk ? "у вашому районі" : "in your district");
        const shelter = s.places.shelter?.[0];
        push("alertStarted", [
          uk ? `Увага! Повітряна тривога ${where}${s.alert?.since ? ` з ${formatClock(s.alert.since, "uk")}` : ""}.` : `Attention! Air alert ${where}${s.alert?.since ? ` since ${formatClock(s.alert.since, "en")}` : ""}.`,
          shelter ? (uk ? `Найближче укриття — ${shelter.name}, ${Math.round(shelter.distanceM)} метрів.` : `Nearest shelter: ${shelter.name}, ${Math.round(shelter.distanceM)} metres.`) : (uk ? "Даних про укриття поруч немає — знайдіть капітальне приміщення без вікон." : "No shelter data nearby — find a solid room without windows."),
        ]);
      } else if (!first) {
        push("alertEnded", [uk ? "Тривогу у вашому районі скасовано." : "The air alert for your area has ended."]);
      }
    }

    // Off route (only meaningful with a route).
    if (s.route) {
      const off = s.route.offRoute;
      if (off !== this.offRoute) {
        const first = this.offRoute === null;
        this.offRoute = off;
        if (off) push("offRoute", [uk ? "Ви відхилилися від маршруту." : "You've left the route.", s.gnss.mode !== "normal" ? (uk ? "Сигнал GPS ненадійний — поверніться туди, де звернули." : "The GPS signal is unreliable — go back to where you turned.") : s.online ? (uk ? "Перебудовую шлях." : "Rebuilding the way.") : (uk ? "Інтернету немає — поверніться на збережений маршрут." : "No internet — go back to the saved route.")]);
        else if (!first) push("backOnRoute", [uk ? "Ви знову на маршруті." : "You're back on the route."], false);
      }
    } else {
      this.offRoute = null;
    }

    out.sort((a, b) => b.priority - a.priority);
    this.log.push(...out);
    return out;
  }

  reset(): void {
    this.gnss.reset();
    this.alertActive = null;
    this.offRoute = null;
    this.log.length = 0;
  }
}
