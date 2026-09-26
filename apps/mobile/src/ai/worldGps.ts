// The co-pilot's view of GPS, from the active engine's state (Demo Mode
// included): the same facts as the map beacon, its panel and the navigator
// mode — engine clock, engine position source. Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import { gpsDetails } from "../engine/liveStatus";
import { navigatorModeOf } from "../navigation/navigatorMode";
import type { CopilotWorld } from "./copilotBrain";

export function worldGps(state: NavigationState, opts: { hasPosition: boolean; fixAccuracyM?: number | null; trendText?: string }): CopilotWorld["gps"] {
  const d = gpsDetails(state);
  return {
    state: state.gnss === "NORMAL" || state.gnss === "DEGRADED" ? state.gnss : "LOST",
    accuracyM: d.accuracyM ?? (state.gnss !== "LOST" ? opts.fixAccuracyM ?? null : null),
    lastFixAgeS: d.lastTrustedFixAgeS,
    // The engine's route position mode; Demo Mode has none, there dead
    // reckoning counts only once GNSS is LOST (a sample without a fix while
    // the signal is merely degraded is not "no GPS").
    positionMode: state.positionMode ?? (state.gnss === "LOST" && d.source === "DEAD_RECKONING" ? "DEAD_RECKONING" : d.source === "NONE" ? null : "GNSS"),
    uncertaintyM: d.uncertaintyM,
    hasPosition: opts.hasPosition,
    mode: navigatorModeOf(state),
    ...(opts.trendText ? { trendText: opts.trendText } : {}),
  };
}
