// "Navigator mode": what NAVIA tells the driver when the GNSS signal gets
// worse, is lost, and comes back. The mode is read from the engine state
// (GNSSIntegrityState, early-warning trend, position source); every message
// is built from the same state, so the voice, the banner and the co-pilot say
// the same thing. Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import { gpsDetails, type PositionSourceKind } from "../engine/liveStatus";
import { formatDistance, type Lang } from "../i18n/format";

/** normal — GNSS fine; degraded — unstable or getting worse (not lost yet);
 * navigator — GNSS lost: NAVIA guides by dead reckoning along the route. */
export type NavigatorMode = "normal" | "degraded" | "navigator";

export function navigatorModeOf(state: NavigationState): NavigatorMode {
  // The engine's integrity state and its route position mode — not the source
  // of one position sample (between two sparse fixes that is dead reckoning
  // while the signal is only degrading).
  if (state.gnss === "LOST" || state.positionMode === "DEAD_RECKONING" || state.positionMode === "MANUAL") return "navigator";
  if (state.gnss === "DEGRADED" || state.gnssTrend?.level === "degrading" || state.gnssTrend?.level === "lost") return "degraded";
  return "normal";
}

/** The facts a message may state — all from the engine. */
export type ModeFacts = {
  gnss: NavigationState["gnss"];
  accuracyM: number | null;
  uncertaintyM: number | null;
  source: PositionSourceKind;
  lastTrustedFixAgeS: number | null;
  /** Early-warning reasons already in words ("точність ±38 м · оновлення приходять рідше"). */
  reasons?: string;
  hasRoute: boolean;
  /** Upcoming maneuver in words ("поверніть праворуч на вулицю Шевченка"). */
  next?: { text: string; distanceM: number | null } | null;
};

export function modeFacts(state: NavigationState, extra: { reasons?: string; hasRoute: boolean; next?: ModeFacts["next"] }): ModeFacts {
  const d = gpsDetails(state);
  return { gnss: d.gnss, accuracyM: d.accuracyM, uncertaintyM: d.uncertaintyM, source: d.source, lastTrustedFixAgeS: d.lastTrustedFixAgeS, ...extra };
}

export type ModeEventKind = "degraded" | "navigator" | "recovered" | "stable";
export type ModeEvent = { kind: ModeEventKind; from: NavigatorMode | null; to: NavigatorMode; atMs: number; text: string; spoken: boolean };

function m(v: number): number {
  return Math.max(1, Math.round(v));
}

function ago(s: number, uk: boolean): string {
  return s < 120 ? (uk ? `${m(s)} с тому` : `${m(s)} s ago`) : (uk ? `${m(s / 60)} хв тому` : `${m(s / 60)} min ago`);
}

/** The message for a mode change, from the current engine facts. */
export function modeMessage(kind: ModeEventKind, f: ModeFacts, lang: Lang): string {
  const uk = lang === "uk";
  switch (kind) {
    case "degraded": {
      const detail = [f.accuracyM != null ? (uk ? `точність ±${m(f.accuracyM)} м` : `accuracy ±${m(f.accuracyM)} m`) : null, f.reasons || null].filter(Boolean).join(", ");
      const plan = f.hasRoute
        ? (uk ? " Маршрут збережено — якщо сигнал зникне, я поведу за ним." : " The route is saved — if the signal drops I'll guide along it.")
        : (uk ? " Побудуйте маршрут, поки сигнал є." : " Build a route while there is a signal.");
      return (uk ? `Сигнал GPS нестабільний${detail ? ` (${detail})` : ""}.` : `The GPS signal is unstable${detail ? ` (${detail})` : ""}.`) + plan;
    }
    case "navigator": {
      if (!f.hasRoute) {
        const age = f.lastTrustedFixAgeS != null ? (uk ? ` Показую останню підтверджену позицію (${ago(f.lastTrustedFixAgeS, uk)}).` : ` Showing the last confirmed position (${ago(f.lastTrustedFixAgeS, uk)}).`) : "";
        return (uk ? "Сигнал GPS втрачено." : "GPS signal lost.") + age;
      }
      const how = f.source === "MANUAL"
        ? (uk ? "веду вас від точки, яку ви вказали" : "guiding you from the point you set")
        : (uk ? "веду вас за маршрутом за рахунком шляху" : "guiding you along the route by dead reckoning");
      const approx = f.uncertaintyM != null ? (uk ? `, позиція приблизна (±${m(f.uncertaintyM)} м)` : `, the position is approximate (±${m(f.uncertaintyM)} m)`) : (uk ? ", позиція приблизна" : ", the position is approximate");
      const next = f.next
        ? (uk ? ` Далі — ${f.next.text}${f.next.distanceM != null ? `, приблизно через ${formatDistance(f.next.distanceM, "uk")}` : ""}.` : ` Next: ${f.next.text}${f.next.distanceM != null ? `, in about ${formatDistance(f.next.distanceM, "en")}` : ""}.`)
        : "";
      // LOST: no fixes. Otherwise fixes still come but are too poor to trust.
      const head = f.gnss === "LOST"
        ? (uk ? "Сигнал GPS втрачено." : "GPS signal lost.")
        : (uk ? "Сигнал GPS ненадійний — точки відкидаю." : "The GPS signal is unreliable — I'm ignoring its fixes.");
      return (uk ? `${head} Режим штурмана: ${how}${approx}.` : `${head} Navigator mode: ${how}${approx}.`) + next;
    }
    case "recovered": {
      const acc = f.accuracyM != null ? (uk ? ` (±${m(f.accuracyM)} м)` : ` (±${m(f.accuracyM)} m)`) : "";
      const still = f.gnss === "DEGRADED" ? (uk ? ", але сигнал ще нестабільний" : ", but the signal is still unstable") : "";
      return uk ? `GPS відновлено${acc}. Режим штурмана вимкнено — позицію підтверджено${still}.` : `GPS restored${acc}. Navigator mode off — position confirmed${still}.`;
    }
    case "stable": {
      const acc = f.accuracyM != null ? (uk ? ` (±${m(f.accuracyM)} м)` : ` (±${m(f.accuracyM)} m)`) : "";
      return uk ? `Сигнал GPS знову стабільний${acc}.` : `The GPS signal is stable again${acc}.`;
    }
  }
}

/**
 * Follows the mode and reports each change once: degraded (spoken),
 * navigator on (spoken), navigator off (spoken), degraded → normal (on
 * screen only). Entering navigation already degraded or lost is reported too.
 */
export class NavigatorModeTracker {
  private mode: NavigatorMode | null = null;
  readonly log: ModeEvent[] = [];

  current(): NavigatorMode | null {
    return this.mode;
  }

  reset(): void {
    this.mode = null;
    this.log.length = 0;
  }

  update(state: NavigationState, facts: ModeFacts, lang: Lang, nowMs: number): ModeEvent | null {
    const to = navigatorModeOf(state);
    const from = this.mode;
    // A loss is announced only after the signal was seen working on this trip:
    // before that "LOST" means "no fix yet" (or a state left over from before
    // the trip). A start without GPS (a point set by hand, dead reckoning) is
    // announced.
    if (from === null && to === "navigator" && state.positionMode !== "MANUAL" && state.positionMode !== "DEAD_RECKONING") return null;
    if (to === from) return null;
    this.mode = to;
    let kind: ModeEventKind | null = null;
    if (to === "navigator") kind = "navigator";
    else if (from === "navigator") kind = "recovered";
    else if (to === "degraded") kind = "degraded";
    else if (from === "degraded") kind = "stable";
    if (!kind) return null; // first look: all normal
    const event: ModeEvent = { kind, from, to, atMs: nowMs, text: modeMessage(kind, facts, lang), spoken: kind !== "stable" };
    this.log.push(event);
    return event;
  }
}
