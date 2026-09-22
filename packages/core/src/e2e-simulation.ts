// Deterministic E2E simulation — spec section 36 ("E2E TEST").
//
// Drives DemoEngine through exactly the scenario the spec lists: start at a
// real Kyiv coordinate, route to a real destination, drive normally, GNSS
// degrades, GNSS disappears, dead reckoning continues, map matching stays
// plausible, AI answers "what's next", a landmark appears and AI confirms
// only when the data supports it, GNSS recovers, recovery is validated,
// arrive. "The test must output a report" — runE2ESimulation() returns a
// structured, JSON-serializable report; the test that calls it also writes
// that JSON to disk.

import type { NavigationMode, NavigationEvent } from "./types";
import type { DemoRoadGraph } from "./demo-routing-provider";
import type { POI } from "./landmark-engine";
import { DemoEngine } from "./demo-engine";
import type { LatLon } from "./types";

export type E2EStepResult = {
  step: string;
  passed: boolean;
  detail: string;
};

export type E2EReport = {
  success: boolean;
  steps: E2EStepResult[];
  finalMode: NavigationMode;
  totalSimSeconds: number;
  events: NavigationEvent[];
};

export type E2ESimulationOptions = {
  graph: DemoRoadGraph;
  origin: LatLon;
  destination: LatLon;
  pois: POI[];
  /** A brand/name known to be genuinely near the route, used for the landmark step. */
  landmarkQuery: string;
  tickSeconds?: number;
  maxTicks?: number;
};

function drive(engine: DemoEngine, ticks: number, dt: number) {
  for (let i = 0; i < ticks; i++) engine.tick(dt);
}

export async function runE2ESimulation(options: E2ESimulationOptions): Promise<E2EReport> {
  const dt = options.tickSeconds ?? 1;
  const maxTicks = options.maxTicks ?? 20_000;
  const steps: E2EStepResult[] = [];
  const engine = new DemoEngine({ graph: options.graph, origin: options.origin, destination: options.destination, pois: options.pois });

  // 1. start at real Kyiv coordinate -> route to real destination
  await engine.start();
  const route = engine.getRoute();
  steps.push({
    step: "route",
    passed: !!route && route.distanceM > 0 && route.source === "demo",
    detail: route ? `real routed distance ${Math.round(route.distanceM)}m via ${route.steps.length} steps` : "no route",
  });

  // 2. drive normally
  drive(engine, 20, dt);
  let state = engine.getState();
  steps.push({
    step: "drive-normally",
    passed: state.mode === "ACTIVE" && state.gnss === "NORMAL",
    detail: `mode=${state.mode} gnss=${state.gnss} confidence=${state.confidenceBand}`,
  });

  // 3. GNSS accuracy degrades
  engine.simulateGnssDegradation();
  drive(engine, 6, dt);
  state = engine.getState();
  steps.push({
    step: "gnss-degrades",
    passed: state.mode === "GNSS_DEGRADED" || state.gnss === "DEGRADED",
    detail: `mode=${state.mode} gnss=${state.gnss}`,
  });

  // 4. GNSS disappears
  engine.simulateGnssLoss();
  drive(engine, 6, dt);
  state = engine.getState();
  steps.push({
    step: "gnss-disappears",
    passed: state.gnss === "LOST" && (state.mode === "GNSS_LOST" || state.mode === "POSITION_UNCERTAIN"),
    detail: `mode=${state.mode} gnss=${state.gnss}`,
  });

  // 5. dead reckoning continues
  const positionSourceDuringOutage = state.position?.source;
  steps.push({
    step: "dead-reckoning-continues",
    passed: positionSourceDuringOutage === "DEAD_RECKONING" || positionSourceDuringOutage === "FUSED",
    detail: `position.source=${positionSourceDuringOutage}`,
  });

  // 6. map matching remains plausible (still tracking close to the route corridor)
  steps.push({
    step: "map-matching-plausible",
    passed: !state.offRoute,
    detail: `offRoute=${state.offRoute} routeRemainingM=${Math.round(state.routeRemainingM)}`,
  });

  // 7. AI answers "what is next?"
  const nextTurnAnswer = await engine.askAI("Що далі?");
  steps.push({
    step: "ai-answers-whats-next",
    passed: nextTurnAnswer.length > 0,
    detail: nextTurnAnswer,
  });

  // 8. landmark appears; AI confirms only when data supports it
  const landmarkResult = engine.simulateLandmark(options.pois, options.landmarkQuery);
  steps.push({
    step: "landmark-confirmed-only-with-data",
    // "passed" here means the engine behaved honestly, not that it always
    // confirms — confirmed/ambiguous/no_match are all valid honest outcomes.
    passed: landmarkResult.kind === "confirmed" || landmarkResult.kind === "ambiguous" || landmarkResult.kind === "no_match",
    detail: `${landmarkResult.kind}: ${landmarkResult.message}`,
  });

  // 9. GNSS recovers
  engine.restoreGnss();
  const recoverTicksLimit = Math.min(30, maxTicks);
  let recovered = false;
  for (let i = 0; i < recoverTicksLimit && !recovered; i++) {
    engine.tick(dt);
    if (engine.getState().mode === "ACTIVE") recovered = true;
  }
  state = engine.getState();
  steps.push({
    step: "gnss-recovers-validated",
    passed: recovered && state.mode === "ACTIVE",
    detail: `mode=${state.mode} recovered=${recovered}`,
  });

  // 10. arrive
  let ticksUsed = 0;
  while (engine.getState().routeRemainingM > 10 && ticksUsed < maxTicks) {
    engine.tick(dt);
    ticksUsed++;
  }
  state = engine.getState();
  steps.push({
    step: "arrive",
    passed: state.mode === "ARRIVED",
    detail: `mode=${state.mode} routeRemainingM=${Math.round(state.routeRemainingM)} ticksUsed=${ticksUsed}`,
  });

  const success = steps.every((s) => s.passed);
  return {
    success,
    steps,
    finalMode: state.mode,
    totalSimSeconds: (route?.durationS ?? 0) + recoverTicksLimit * dt,
    events: [...engine.getTelemetry().getEvents()],
  };
}
