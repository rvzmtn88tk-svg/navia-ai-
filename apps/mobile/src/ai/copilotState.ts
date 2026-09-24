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
