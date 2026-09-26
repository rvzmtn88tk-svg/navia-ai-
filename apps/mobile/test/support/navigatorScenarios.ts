// Demo Mode states for navigator tests: every scenario is a real DemoEngine
// state turned into a Snapshot the same way the app does it.
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine, haversineMeters, initialBearing, type NavigationState } from "@navia/core";
import { worldGps } from "../../src/ai/worldGps";
import { actionWords, type StepLike } from "../../src/voice/guidance";
import { buildSnapshot, type Snapshot } from "../../src/ai/navigator/snapshot";
import type { CopilotWorld, WorldPlace } from "../../src/ai/copilotBrain";

export type Extras = { alert?: CopilotWorld["alert"]; route?: boolean; online?: boolean };
export type Scenario = { key: string; name: string; state: NavigationState; snapshot: Snapshot };

export const NOW = 1_000_000_000;

function shelters(state: NavigationState): WorldPlace[] {
  const here = state.position?.position;
  if (!here) return [];
  const mk = (name: string, dLat: number, dLon: number): WorldPlace => {
    const location = { lat: here.lat + dLat, lon: here.lon + dLon };
    return { id: name, name, kind: "shelter", location, distanceM: haversineMeters(here, location), bearingDeg: initialBearing(here, location) };
  };
  return [mk("Укриття школи №12", 0.0027, 0), mk("Паркінг ТЦ", 0.009, 0.004)].sort((a, b) => a.distanceM - b.distanceM);
}

function pharmacies(state: NavigationState): WorldPlace[] {
  const here = state.position?.position;
  if (!here) return [];
  const location = { lat: here.lat - 0.004, lon: here.lon + 0.002 };
  return [{ id: "ph", name: "Аптека Доброго Дня", kind: "pharmacy", location, distanceM: haversineMeters(here, location), bearingDeg: initialBearing(here, location) }];
}

export function worldFrom(state: NavigationState, x: Extras = {}): CopilotWorld {
  const onRoute = x.route !== false && state.mode !== "IDLE";
  const next = state.nextStep && onRoute ? actionWords(state.nextStep as StepLike, "uk") : null;
  return {
    lang: "uk", now: NOW, remote: false, landmarks: [],
    gps: worldGps(state, { hasPosition: !!state.position }),
    ...(x.alert ? { alert: x.alert } : { alert: { active: false } }),
    here: { street: "Бориспільське шосе", area: "Київ" },
    places: { shelter: shelters(state), pharmacy: pharmacies(state) },
    placeStates: { shelter: "ready", pharmacy: "ready", fuel: "ready", resilience: "ready" },
    ...(onRoute ? { route: {
      destination: "Бориспіль (Демо)", mode: "car" as const, remainingM: state.routeRemainingM, etaS: state.etaSeconds ?? null, offRoute: state.offRoute, landmarkCount: 0,
      ...(next && state.nextStep?.maneuver !== "arrive" ? { next: { ...next, distanceM: state.nextStepDistanceM ?? null } } : {}),
    } } : {}),
  };
}

async function engine(): Promise<DemoEngine> {
  const d = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await d.start();
  return d;
}
const ticks = (d: DemoEngine, n: number): NavigationState => { let s = d.getState(); for (let i = 0; i < n; i++) s = d.tick(1); return s; };
function tickUntil(d: DemoEngine, ok: (s: NavigationState) => boolean, max = 300): NavigationState {
  let s = d.getState();
  for (let i = 0; i < max && !ok(s); i++) s = d.tick(1);
  if (!ok(s)) throw new Error("scenario state not reached");
  return s;
}

/** The seven situations: норма (no route, standing), звичайний рух, деградація, втрата, відновлення, тривога, відхилення. */
export async function sevenSituations(): Promise<Scenario[]> {
  const out: Scenario[] = [];
  const add = (key: string, name: string, state: NavigationState, x: Extras = {}) => out.push({ key, name, state, snapshot: buildSnapshot({ state, world: worldFrom(state, x), online: x.online ?? true, now: NOW }) });
  let d = await engine();
  const moving = ticks(d, 12);
  add("normal", "норма (без маршруту)", moving, { route: false });
  add("driving", "звичайний рух", moving);
  add("alert", "тривога", moving, { alert: { active: true, scope: "district", since: NOW - 5 * 60_000, reasons: ["Повітряна тривога"] } });
  d.simulateGradualGnssLoss();
  add("degraded", "деградація", tickUntil(d, (s) => s.gnss === "DEGRADED"));
  tickUntil(d, (s) => s.gnss === "LOST");
  add("lost", "втрата сигналу", ticks(d, 12));
  d.restoreGnss();
  add("recovered", "відновлення", tickUntil(d, (s) => s.gnss === "NORMAL"));
  d = await engine();
  ticks(d, 8);
  d.simulateOffRoute();
  add("offroute", "відхилення від маршруту", tickUntil(d, (s) => s.offRoute));
  return out;
}
