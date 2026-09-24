// Builds the co-pilot's view of the world: a small structured snapshot of
// navigation state. Deliberately contains no coordinates — only road names,
// districts, distances and statuses (privacy: see docs/NAVIA_TZ.md).
// Pure; unit-tested.

export type CopilotStateInput = {
  lang: "uk" | "en";
  gnss: string;
  confidenceBand: string;
  destinationLabel?: string | null;
  nextStep?: { maneuver: string; roadName: string; roundaboutExit?: number } | null;
  nextStepDistanceM?: number | null;
  routeRemainingM?: number | null;
  etaSeconds?: number | null;
  offRoute?: boolean;
  alert?: { active: boolean | null; locationLabel?: string; since?: number } | null;
  regionSummary?: string | null;
  places?: { name: string; category: string; distanceM: number }[];
};

export type CopilotState = {
  lang: "uk" | "en";
  gnss: "NORMAL" | "DEGRADED" | "LOST";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  destination?: string;
  district?: string;
  nextManeuver?: { maneuver: string; distanceM: number | null; roadName?: string; roundaboutExit?: number };
  remainingM?: number;
  etaMin?: number;
  offRoute?: boolean;
  alert?: { active: boolean | null; area?: string; sinceTime?: string };
  regionSummary?: string;
  nearbyPlaces?: { name: string; category: string; distanceM: number }[];
};

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function buildCopilotState(input: CopilotStateInput): CopilotState {
  const gnss = input.gnss === "NORMAL" || input.gnss === "DEGRADED" ? input.gnss : "LOST";
  const confidence = (["HIGH", "MEDIUM", "LOW"] as const).find((b) => b === input.confidenceBand) ?? "UNKNOWN";
  return {
    lang: input.lang,
    gnss,
    confidence,
    ...(input.destinationLabel ? { destination: input.destinationLabel } : {}),
    ...(input.alert?.locationLabel ? { district: input.alert.locationLabel } : {}),
    ...(input.nextStep ? {
      nextManeuver: {
        maneuver: input.nextStep.maneuver,
        distanceM: input.nextStepDistanceM != null ? Math.round(input.nextStepDistanceM) : null,
        ...(input.nextStep.roadName ? { roadName: input.nextStep.roadName } : {}),
        ...(input.nextStep.roundaboutExit ? { roundaboutExit: input.nextStep.roundaboutExit } : {}),
      },
    } : {}),
    ...(input.routeRemainingM ? { remainingM: Math.round(input.routeRemainingM) } : {}),
    ...(input.etaSeconds ? { etaMin: Math.round(input.etaSeconds / 60) } : {}),
    ...(input.offRoute != null ? { offRoute: input.offRoute } : {}),
    ...(input.alert ? { alert: { active: input.alert.active, ...(input.alert.locationLabel ? { area: input.alert.locationLabel } : {}), ...(input.alert.since ? { sinceTime: hhmm(input.alert.since) } : {}) } } : {}),
    ...(input.regionSummary ? { regionSummary: input.regionSummary } : {}),
    ...(input.places?.length ? { nearbyPlaces: input.places.slice(0, 10).map((p) => ({ name: p.name, category: p.category, distanceM: Math.round(p.distanceM) })) } : {}),
  };
}

// ——— Richer snapshot for the Claude co-pilot, from the on-device world ———

import type { CopilotWorld } from "./copilotBrain";
import { directionWords, walkMinutes } from "./copilotBrain";

export type CopilotStateV2 = CopilotState & {
  positionMode?: "GNSS" | "DEAD_RECKONING" | "MANUAL";
  uncertaintyM?: number;
  lastFixMinAgo?: number;
  street?: string;
  alertDetail?: { scope?: string; level?: string; reasons?: string[]; otherDistricts?: number };
  routeCue?: string;
  routeConfirm?: string;
  landmarkBehind?: string;
  landmarkAhead?: string;
  landmarkCount?: number;
  places?: { name: string; kind: string; distanceM: number; direction?: string; walkMin?: number }[];
};

/** Everything the co-pilot knows, in words and distances only — never coordinates. */
export function stateFromWorld(w: CopilotWorld): CopilotStateV2 {
  const places = Object.values(w.places).flatMap((list) => (list ?? []).slice(0, 3))
    .sort((a, b) => a.distanceM - b.distanceM).slice(0, 12)
    .map((p) => ({ name: p.name, kind: p.kind, distanceM: Math.round(p.distanceM), ...(p.bearingDeg != null ? { direction: directionWords(p.bearingDeg, w.lang) } : {}), ...(p.distanceM <= 3000 ? { walkMin: walkMinutes(p.distanceM) } : {}) }));
  const r = w.route;
  return {
    lang: w.lang,
    gnss: w.gps.state,
    confidence: w.gps.positionMode === "DEAD_RECKONING" ? "LOW" : w.gps.state === "NORMAL" ? "HIGH" : w.gps.state === "DEGRADED" ? "MEDIUM" : "UNKNOWN",
    ...(w.gps.positionMode ? { positionMode: w.gps.positionMode } : {}),
    ...(w.gps.uncertaintyM ? { uncertaintyM: Math.round(w.gps.uncertaintyM) } : {}),
    ...(w.gps.lastFixAgeS != null ? { lastFixMinAgo: Math.round(w.gps.lastFixAgeS / 60) } : {}),
    ...(w.here?.area ? { district: w.here.area } : {}),
    ...(w.here?.street ? { street: w.here.street } : {}),
    ...(r ? {
      destination: r.destination,
      remainingM: Math.round(r.remainingM),
      ...(r.etaS != null ? { etaMin: Math.round(r.etaS / 60) } : {}),
      offRoute: r.offRoute,
      ...(r.next ? { nextManeuver: { maneuver: r.next.action, distanceM: r.next.distanceM != null ? Math.round(r.next.distanceM) : null, ...(r.next.road ? { roadName: r.next.road } : {}) } } : {}),
      ...(r.next?.cue ? { routeCue: r.next.cue } : {}),
      ...(r.next?.confirm ? { routeConfirm: r.next.confirm } : {}),
      ...(r.behind ? { landmarkBehind: r.behind } : {}),
      ...(r.ahead ? { landmarkAhead: r.ahead } : {}),
      landmarkCount: r.landmarkCount,
    } : {}),
    ...(w.alert ? {
      alert: { active: w.alert.active, ...(w.alert.area ? { area: w.alert.area } : {}) },
      alertDetail: { ...(w.alert.scope ? { scope: w.alert.scope } : {}), ...(w.alert.level ? { level: w.alert.level } : {}), ...(w.alert.reasons ? { reasons: w.alert.reasons } : {}), ...(w.alert.otherDistricts ? { otherDistricts: w.alert.otherDistricts } : {}) },
    } : {}),
    ...(w.regional?.kindsText ? { regionSummary: `${w.regional.state}: ${w.regional.kindsText}` } : {}),
    ...(places.length ? { places } : {}),
  };
}
