// Singleton engine instances + the store that makes their state reactive
// for screens. This is the ONLY place NavigationEngine/DemoEngine get
// constructed and pushed into — per the user's explicit "screens must only
// get data, display it, and send user actions" rule, no screen touches
// @navia/core's engines directly except through this controller.
//
// Real mode vs Demo Mode share the exact same NavigationState shape and the
// exact same production engines underneath (DemoEngine, like
// NavigationEngine, is built entirely from GNSSMonitor/SensorFusionEngine/
// RouteProgressEngine/OffRouteDetector/NavigationStateMachine — see
// packages/core/src/demo-engine.ts) — only the sample SOURCE differs (real
// sensors vs. DemoEngine's synthetic-but-real-pipeline samples). `isDemoMode`
// is exposed so the UI can show an unmissable "DEMO MODE" banner, per the
// user's explicit "user must never confuse it with real GPS" instruction.
import { create } from "zustand";
import {
  NavigationEngine, DemoEngine, DeterministicDemoAIProvider,
  DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_POIS,
  type NavigationState, type Route, type LatLon,
} from "@navia/core";
import { OnlineValhallaProvider } from "../providers/OnlineValhallaProvider";

const idleState: NavigationState = {
  mode: "IDLE", position: null, trustedPosition: null, gnss: "NORMAL",
  confidence: 0, confidenceBand: "UNKNOWN", speedMps: null, headingDeg: null,
  routeProgressM: 0, routeRemainingM: 0, nextStep: null, nearbyLandmarks: [],
  offRoute: false, networkAvailable: true, offlineMapAvailable: false,
  lastTrustedFixAt: null, updatedAt: 0,
};

export const routingProvider = new OnlineValhallaProvider();
export const navigationEngine = new NavigationEngine({ routingProvider });
export const demoEngine = new DemoEngine({
  graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS,
});
export const aiProvider = new DeterministicDemoAIProvider();

export type RecentDestination = { label: string; lat: number; lon: number; visitedAt: number };

type NaviaStore = {
  isDemoMode: boolean;
  setDemoMode: (v: boolean) => void;
  state: NavigationState;
  route: Route | null;
  destination: LatLon | null;
  setDestination: (d: LatLon | null) => void;
  /** Session-only (not persisted across app restarts — no AsyncStorage
   * wired up in this pass, see LIMITATIONS.md) list of recently navigated destinations. */
  recentDestinations: RecentDestination[];
  addRecentDestination: (d: RecentDestination) => void;
  /** Pushes a fresh read of the active engine's state/route into the store — call after every push/tick. */
  refresh: () => void;
};

export const useNaviaStore = create<NaviaStore>((set, get) => ({
  isDemoMode: false,
  setDemoMode: (v) => set({ isDemoMode: v }),
  state: idleState,
  route: null,
  destination: null,
  setDestination: (d) => set({ destination: d }),
  recentDestinations: [],
  addRecentDestination: (d) =>
    set((s) => ({ recentDestinations: [d, ...s.recentDestinations.filter((r) => r.label !== d.label)].slice(0, 8) })),
  refresh: () => {
    const { isDemoMode } = get();
    const engine = isDemoMode ? demoEngine : navigationEngine;
    set({ state: engine.getState(), route: engine.getRoute() });
  },
}));

/** The engine currently driving the app — real GPS, or DemoEngine's synthetic-but-real pipeline. */
export function activeEngine(): NavigationEngine | DemoEngine {
  return useNaviaStore.getState().isDemoMode ? demoEngine : navigationEngine;
}
