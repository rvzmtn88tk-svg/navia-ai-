// NAVIA navigator — LAYER 5 (response generator) and the entry points that
// tie the layers together, plus LAYER 4 (proactive messages).
//   question → classify (2) → handler (3) on the snapshot (1) → generate (5)
//   state change → ProactiveMonitor (4) → generate (5) → voice (interrupts)
// Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import { NavigatorModeTracker, modeFacts } from "../../navigation/navigatorMode";
import { classify, type NavigatorIntent } from "./intents";
import { fieldWords, handlerFor, type Draft, type LastAnswer, type Tone } from "./handlers";
import type { Snapshot } from "./snapshot";
import type { CopilotAction, WorldPlace } from "../copilotBrain";
import { formatClock } from "../../i18n/format";

export type NavigatorReply = {
  intent: NavigatorIntent;
  text: string;
  /** The same answer for the voice: no bullets, no line breaks. */
  speech: string;
  actions: CopilotAction[];
  tone: Tone;
  used: string[];
  missing: string[];
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

export class Navigator {
  private lastReply: string | null = null;
  private last: LastAnswer | null = null;

  /** `forced`: the intent recognised by the server's language model (it
   * decides only what is asked; the answer still comes from the snapshot). */
  ask(question: string, snapshot: Snapshot, forced?: NavigatorIntent): NavigatorReply {
    const t0 = now();
    const intent = forced ?? classify(question);
    const draft = handlerFor(intent)(snapshot, { question, lastReply: this.lastReply, last: this.last });
    // Only fields that really had a value (so "why" never cites empty data).
    draft.used = draft.used.filter((f) => f === "lastAnswer" || f === "lastReply" || f.startsWith("places") || f.startsWith("placeStates") || f.startsWith("placeGaps") || fieldWords(f, snapshot) !== null);
    const { text, speech } = generate(draft);
    if (intent !== "repeat" && intent !== "explain") {
      this.lastReply = text;
      this.last = { question, intent, text, used: draft.used, missing: draft.missing ?? [], snapshot };
    }
    return { intent, text, speech, actions: draft.actions, tone: draft.tone, used: draft.used, missing: draft.missing ?? [], computeMs: now() - t0, ...(draft.places ? { places: draft.places } : {}) };
  }
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
