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
//
// The AI co-pilot (NaviaCopilot) is wired here too: one per mode, each over
// its engine, its TripPlanner (destination + stops + road preferences) and
// its place source — live OSM (Overpass) in real mode, the labelled demo
// fixture in Demo Mode. The LLM is only reached through the NAVIA AI backend
// and only while the driver has AI context sharing switched on.
import { create } from "zustand";
import {
  NavigationEngine, DemoEngine, TripPlanner, NaviaCopilot, EngineCopilotRuntime, BackendLLMClient,
  LocalPlaceSearchProvider, OverpassPlaceSearchProvider,
  DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_POIS, DEMO_ROUTE_POIS,
  type NavigationState, type Route, type LatLon, type SavedPlace,
} from "@navia/core";
import { OnlineValhallaProvider } from "../providers/OnlineValhallaProvider";
import { OnlineGeocoderProvider } from "../providers/OnlineGeocoderProvider";
import { config } from "../config";

const idleState: NavigationState = {
  mode: "IDLE", position: null, trustedPosition: null, gnss: "NORMAL",
  confidence: 0, confidenceBand: "UNKNOWN", speedMps: null, headingDeg: null,
  routeProgressM: 0, routeRemainingM: 0, nextStep: null, nearbyLandmarks: [],
  offRoute: false, networkAvailable: true, offlineMapAvailable: false,
  lastTrustedFixAt: null, updatedAt: 0,
};

export const routingProvider = new OnlineValhallaProvider();
// resilient: keep guiding to the destination when GPS is jammed or spoofed
// (road-constrained particle filter + gyro + accelerometer; see
// docs/GNSS_DENIED_REPORT.md). Online routes come with no local road graph,
// so the route itself is the road network; expo-sensors reports
// accelerometer in g and gyro in rad/s (MotionPreprocessor defaults), and the
// gravity sign / vibration thresholds are learned from GPS while it is good.
export const navigationEngine = new NavigationEngine({ routingProvider, resilient: true });
export const demoEngine = new DemoEngine({
  graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS,
});

/** Trip plans (destination, stops, road preferences) — every (re)route goes through these. */
export const tripPlanner = new TripPlanner(routingProvider);
export const demoTripPlanner = new TripPlanner(demoEngine.getRoutingProvider());
demoTripPlanner.setDestination({ label: "Бориспіль (demo)", location: DEMO_DESTINATION });

const DEMO_PLACES = [...DEMO_POIS, ...DEMO_ROUTE_POIS];

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
  /** Home/work for "take me home". Session-only, like recentDestinations. */
  savedPlaces: SavedPlace[];
  savePlace: (p: SavedPlace) => void;
  /** Spec section 30: "Send location context to AI" — conservative default OFF. */
  aiContextConsent: boolean;
  setAiContextConsent: (v: boolean) => void;
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
  savedPlaces: [],
  savePlace: (p) => set((s) => ({ savedPlaces: [...s.savedPlaces.filter((x) => x.kind !== p.kind), p] })),
  aiContextConsent: false,
  setAiContextConsent: (v) => set({ aiContextConsent: v }),
  refresh: () => {
    const { isDemoMode } = get();
    const engine = isDemoMode ? demoEngine : navigationEngine;
    set({ state: engine.getState(), route: engine.getRoute() });
  },
}));

/** The engine currently driving the app — real GPS, or DemoEngine's synthetic-but-real-pipeline samples. */
export function activeEngine(): NavigationEngine | DemoEngine {
  return useNaviaStore.getState().isDemoMode ? demoEngine : navigationEngine;
}

export function activePlanner(): TripPlanner {
  return useNaviaStore.getState().isDemoMode ? demoTripPlanner : tripPlanner;
}

// --- AI co-pilot ---

const llm = config.aiBackendUrl
  ? new BackendLLMClient({ baseUrl: config.aiBackendUrl, clientToken: config.aiClientToken })
  : null;

const overpass = config.overpassUrl ? new OverpassPlaceSearchProvider({ endpoint: config.overpassUrl }) : null;
const demoPlaces = new LocalPlaceSearchProvider(DEMO_PLACES, "demo");
const geocoder = new OnlineGeocoderProvider();
const aiEnabled = () => useNaviaStore.getState().aiContextConsent;
const savedPlaces = () => useNaviaStore.getState().savedPlaces;

export const realCopilot = new NaviaCopilot({
  runtime: new EngineCopilotRuntime({
    host: navigationEngine,
    planner: tripPlanner,
    // Online OSM search only while the network is up; otherwise the co-pilot
    // reports place search as unavailable (the offline POI index plugs in
    // here as a LocalPlaceSearchProvider once scripts/data has produced it).
    places: () => (navigationEngine.getState().networkAvailable ? overpass : null),
    geocoder,
    savedPlaces,
  }),
  llm,
  aiEnabled,
});

export const demoCopilot = new NaviaCopilot({
  runtime: new EngineCopilotRuntime({
    host: demoEngine,
    planner: demoTripPlanner,
    places: demoPlaces,
    geocoder,
    savedPlaces,
    localPois: () => DEMO_PLACES,
  }),
  llm,
  aiEnabled,
});

export function activeCopilot(): NaviaCopilot {
  return useNaviaStore.getState().isDemoMode ? demoCopilot : realCopilot;
}

export function isSmartCopilotConfigured(): boolean {
  return llm != null;
}
