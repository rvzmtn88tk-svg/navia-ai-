// The per-turn <trip_state> block: a compact, line-oriented snapshot of the
// facts a driver's question most often needs (≈100–250 tokens), so simple
// questions ("how long left?", "what's next?", "what about GPS?") are
// answered with zero tool calls, while anything bigger (places, geometry,
// alternatives) is fetched on demand through tools. No coordinates, no
// polylines, no raw POI lists.

import type { NavigationState, RouteStep } from "../types";
import type { CopilotRuntime, CopilotSession } from "./runtime";
import { arrivalClock, buildRouteContext } from "./tool-executor";
import { UnavailableTrafficProvider } from "../traffic";

const r1 = (x: number) => Math.round(x * 10) / 10;
const km = (m: number) => (m < 10_000 ? r1(m / 1000) : Math.round(m / 1000));

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function maneuverLine(step: RouteStep | null, distanceM: number | null, state: NavigationState): string {
  if (!step) return "none";
  const road = step.roadName ? ` onto ${step.roadName}` : "";
  const sigma = state.positioning?.maneuverUncertaintyM;
  // GNSS-independent positioning knows how uncertain the distance is: give it with its error bar while that is still useful.
  if (state.confidenceBand === "LOW" && sigma != null && sigma <= 150 && distanceM != null) {
    return `${step.maneuver}${road} in about ${Math.round(distanceM / 10) * 10} m (±${Math.round(sigma / 10) * 10} m)`;
  }
  if (state.confidenceBand === "LOW" || state.confidenceBand === "UNKNOWN") {
    return `${step.maneuver}${road} (distance withheld: position uncertain)`;
  }
  return distanceM != null ? `${step.maneuver}${road} in ${Math.round(distanceM / 10) * 10} m` : `${step.maneuver}${road}`;
}

function positioningLine(state: NavigationState): string | null {
  const p = state.positioning;
  if (!p) return null;
  const since = p.secondsSinceTrustedFix;
  const ago = since == null ? "none yet" : since < 90 ? `${Math.round(since)} s ago` : `${Math.round(since / 60)} min ago`;
  const how = p.source === "DEAD_RECKONING"
    ? `no usable GPS: road map + ${p.imuAvailable ? "gyroscope/accelerometer + " : ""}speed model`
    : p.source === "FUSED" ? "GPS blended with motion sensors" : "GPS";
  return `positioning: source=${p.source} (${how}) gnss_verdict=${p.gnssVerdict}` +
    `${p.gnssSuspectedSpoofing ? " suspected_spoofing=yes" : ""} uncertainty=±${Math.round(p.uncertaintyM)} m` +
    ` motion_sensors=${p.imuAvailable ? "yes" : "no"} last_trusted_fix=${ago}`;
}

export function buildTripSnapshot(runtime: CopilotRuntime, session: CopilotSession): string {
  const now = runtime.now();
  const { state, route } = runtime.getNavigation();
  const plan = runtime.planner.getPlan();
  const lines: string[] = [];
  lines.push(`time: ${clock(now)}`);
  lines.push(
    `nav: mode=${state.mode} gnss=${state.gnss} position_confidence=${state.confidenceBand}` +
    ` network=${state.networkAvailable ? "online" : "offline"}${state.offRoute ? " off_route=yes" : ""}`,
  );
  const positioning = positioningLine(state);
  if (positioning) lines.push(positioning);
  lines.push(`speed: ${state.speedMps != null ? `${Math.round(state.speedMps * 3.6)} km/h` : "unknown"}`);

  const rc = buildRouteContext(runtime);
  if (route && rc) {
    // Current road = the road of the step being driven now.
    let cum = 0;
    let currentStep: RouteStep | null = null;
    let nextStep: RouteStep | null = null;
    let toNextM: number | null = null;
    for (let i = 0; i < route.steps.length; i++) {
      const end = cum + route.steps[i]!.distanceM;
      if (rc.alongNowM < end || i === route.steps.length - 1) {
        currentStep = route.steps[i]!;
        nextStep = route.steps[i + 1] ?? null;
        toNextM = nextStep ? Math.max(0, end - rc.alongNowM) : null;
        break;
      }
      cum = end;
    }
    // The resilient navigator tracks the distance to the next maneuver itself.
    if (state.positioning && state.nextStep && state.nextManeuverDistanceM != null) {
      nextStep = state.nextStep;
      toNextM = state.nextManeuverDistanceM;
    }
    if (currentStep?.roadName) lines.push(`road: ${currentStep.roadName}`);
    lines.push(`next_maneuver: ${maneuverLine(nextStep, toNextM, state)}`);
    lines.push(
      `destination: ${plan.destination?.label ?? "unnamed"} | remaining: ${km(rc.remainingM)} km, ` +
      `${Math.round(rc.remainingS / 60)} min, arrival ${arrivalClock(now, rc.remainingS)} (routing-engine estimate)`,
    );
    const stops = plan.stops.map((s) => {
      const p = rc.index.project(s.location, rc.alongNowM - 50);
      return `${s.id} ${s.label}${p ? ` (${km(Math.max(0, p.alongM - rc.alongNowM))} km ahead)` : ""}`;
    });
    lines.push(`stops: ${stops.length > 0 ? stops.join("; ") : "none"}`);
    const prefs = route.appliedPreferences ?? [];
    const unsupported = route.unsupportedPreferences ?? [];
    lines.push(
      `route: provider=${route.source} avoid=${prefs.length ? prefs.join(",") : "none"}` +
      `${unsupported.length ? ` unsupported=${unsupported.join(",")}` : ""}`,
    );
  } else if (route) {
    lines.push(`route: active (provider=${route.source}) but current position unknown`);
    lines.push(`destination: ${plan.destination?.label ?? "unnamed"}`);
  } else {
    lines.push(`route: none (not navigating)${plan.destination ? ` | planned destination: ${plan.destination.label}` : ""}`);
  }

  const places = runtime.places();
  lines.push(`data: places=${places ? places.source : "unavailable"} traffic=${runtime.traffic() instanceof UnavailableTrafficProvider ? "unavailable" : "connected"}`);

  if (session.pending) {
    lines.push(`pending_action: ${session.pending.tool} — "${session.pending.summary}" — awaiting driver's yes/no`);
  }
  if (session.recentResults.length > 0) {
    lines.push(`last_results: ${session.recentResults.slice(0, 5).map((r) => r.line).join("; ")}`);
  }
  return `<trip_state>\n${lines.join("\n")}\n</trip_state>`;
}
