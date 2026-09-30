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
  NavigationEngine, DemoEngine, DeterministicDemoAIProvider, TripPlanner, NaviaCopilot, EngineCopilotRuntime, BackendLLMClient,
  LocalPlaceSearchProvider, OverpassPlaceSearchProvider, FallbackPlaceSearchProvider, SpeedMemory, ActiveTripCache, PreferenceStore, ProactiveEngine,
  DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_POIS, DEMO_ROUTE_POIS,
  type NavigationState, type Route, type LatLon, type GNSSRawSample, type SavedPlace,
} from "@navia/core";
import { OnlineValhallaProvider } from "../providers/OnlineValhallaProvider";
import { OnlineGeocoderProvider } from "../providers/OnlineGeocoderProvider";
import { DeviceKeyValueStore } from "../providers/DeviceKeyValueStore";
import { config } from "../config";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import type { AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import { nextAlertEndedAt } from "./liveStatus";
import { usePlacesStore } from "../store/placesStore";
import { TilePlaceSearchProvider, tileLocalizationData } from "../providers/vectorTiles";
import { useNearbyStore } from "../store/nearbyStore";
import { streetAt } from "../providers/streetAt";
import { trafficProvider } from "../providers/trafficFlow";

const idleState: NavigationState = {
  mode: "IDLE", position: null, trustedPosition: null, gnss: "LOST",
  confidence: 0, confidenceBand: "UNKNOWN", speedMps: null, headingDeg: null,
  routeProgressM: 0, routeRemainingM: 0, nextStep: null, nearbyLandmarks: [],
  offRoute: false, networkAvailable: true, offlineMapAvailable: false,
  lastTrustedFixAt: null, updatedAt: 0,
};

export const routingProvider = new OnlineValhallaProvider();
// resilient (road-constrained particle filter + gyro + accelerometer, see
// docs/GNSS_DENIED_REPORT.md) stays OFF until it has been driven on a phone:
// the route dead reckoning tested on the iPhone (route-dead-reckoning.ts)
// remains the GNSS-denied path. Turning it on is this one flag.
/** How fast this driver really goes on each stretch (learned with GPS, used without it); kept on the phone. */
const SPEED_MEMORY_KEY = "navia.speedMemory.v1";
export const speedMemory = (() => {
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { getItemSync(k: string): string | null } }).default;
    const raw = kv.getItemSync(SPEED_MEMORY_KEY);
    return new SpeedMemory(raw ? JSON.parse(raw) : undefined);
  } catch { return new SpeedMemory(); }
})();
export function saveSpeedMemory(): void {
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { setItemAsync(k: string, v: string): Promise<void> } }).default;
    void kv.setItemAsync(SPEED_MEMORY_KEY, JSON.stringify(speedMemory.toJSON())).catch(() => {});
  } catch { /* storage unavailable */ }
}

export const navigationEngine = new NavigationEngine({ routingProvider, resilient: false, speedMemory });

/** Device key-value storage (expo-sqlite) and the active trip saved in it, so losing internet or restarting the app doesn't end navigation. */
export const deviceStore = new DeviceKeyValueStore();
export const activeTripCache = new ActiveTripCache(deviceStore);
/** The driver's long-term preferences (saved only when they state one; see PreferenceStore). */
export const preferenceStore = new PreferenceStore(deviceStore);
void preferenceStore.load();
export const demoEngine = new DemoEngine({
  graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS,
});

/** Trip plans (destination, stops, road preferences) — every (re)route goes through these. */
export const tripPlanner = new TripPlanner(routingProvider);
export const demoTripPlanner = new TripPlanner(demoEngine.getRoutingProvider());
demoTripPlanner.setDestination({ label: "Бориспіль (demo)", location: DEMO_DESTINATION });

const DEMO_PLACES = [...DEMO_POIS, ...DEMO_ROUTE_POIS];

type NaviaStore = {
  isDemoMode: boolean;
  setDemoMode: (v: boolean) => void;
  state: NavigationState;
  route: Route | null;
  currentFix: GNSSRawSample | null;
  setCurrentFix: (fix: GNSSRawSample | null) => void;
  /** Latest plausible fix that is not good enough for navigation (drawn with its error circle; see approxFix.ts). */
  approxFix: GNSSRawSample | null;
  setApproxFix: (fix: GNSSRawSample | null) => void;
  alert: GeolocatedAirAlert | null;
  setAlert: (alert: GeolocatedAirAlert | null) => void;
  /** When the last alert at the user's place ended (null while one is active or none ended). */
  alertEndedAt: number | null;
  airThreatSummary: AirThreatSummary | null;
  setAirThreatSummary: (summary: AirThreatSummary | null) => void;
  destination: LatLon | null;
  setDestination: (d: LatLon | null) => void;
  /** A new route is being built after leaving the old one. */
  rerouting: boolean;
  setRerouting: (v: boolean) => void;
  /** Home/work the co-pilot set this session; the driver's own Home/Work and
   * recent places are persisted in store/placesStore.ts. */
  savedPlaces: SavedPlace[];
  savePlace: (p: SavedPlace) => void;
  /** Spec section 30: "Send location context to AI" — conservative default OFF, asked once on first use, remembered. */
  aiContextConsent: boolean;
  /** The driver has answered the consent question (either way). */
  aiConsentAsked: boolean;
  setAiContextConsent: (v: boolean) => void;
  /** Pushes a fresh read of the active engine's state/route into the store — call after every push/tick. */
  refresh: () => void;
};

export const useNaviaStore = create<NaviaStore>((set, get) => ({
  isDemoMode: false,
  setDemoMode: (v) => set({ isDemoMode: v }),
  state: idleState,
  route: null,
  currentFix: null,
  setCurrentFix: (fix) => set({ currentFix: fix, approxFix: null }),
  approxFix: null,
  setApproxFix: (fix) => set({ approxFix: fix }),
  alert: null,
  alertEndedAt: null,
  setAlert: (alert) => set((s) => ({ alert, alertEndedAt: nextAlertEndedAt(s.alert, alert, s.alertEndedAt, Date.now()) })),
  airThreatSummary: null,
  setAirThreatSummary: (airThreatSummary) => set({ airThreatSummary }),
  destination: null,
  setDestination: (d) => set({ destination: d }),
  rerouting: false,
  setRerouting: (rerouting) => set({ rerouting }),
  savedPlaces: [],
  savePlace: (p) => set((s) => ({ savedPlaces: [...s.savedPlaces.filter((x) => x.kind !== p.kind), p] })),
  aiContextConsent: false,
  aiConsentAsked: false,
  setAiContextConsent: (v) => {
    set({ aiContextConsent: v, aiConsentAsked: true });
    void deviceStore.setItem(AI_CONSENT_KEY, v ? "yes" : "no").catch(() => {});
  },
  refresh: () => {
    const { isDemoMode } = get();
    const engine = isDemoMode ? demoEngine : navigationEngine;
    set({ state: engine.getState(), route: engine.getRoute() });
  },
}));

const AI_CONSENT_KEY = "navia.aiConsent.v1";
void deviceStore.getItem(AI_CONSENT_KEY).then((v) => {
  if (v === "yes" || v === "no") useNaviaStore.setState({ aiContextConsent: v === "yes", aiConsentAsked: true });
}).catch(() => {});

/** The engine currently driving the app — real GPS, or DemoEngine's synthetic-but-real-pipeline samples. */
export function activeEngine(): NavigationEngine | DemoEngine {
  return useNaviaStore.getState().isDemoMode ? demoEngine : navigationEngine;
}

export function activePlanner(): TripPlanner {
  return useNaviaStore.getState().isDemoMode ? demoTripPlanner : tripPlanner;
}

// --- AI co-pilot ---

// The co-pilot talks to the NAVIA proxy (server/navia-proxy, /v1/copilot/complete):
// the same server and key as the language engine; nothing secret in the app.
const llm = config.aiProxyUrl
  ? new BackendLLMClient({ baseUrl: config.aiProxyUrl, clientToken: config.aiClientToken ?? undefined })
  : null;

const overpass = config.overpassUrl ? new OverpassPlaceSearchProvider({ endpoint: config.overpassUrl }) : null;
// Map tiles first (keyless CDN, the same data the map shows; reachable where the
// public Overpass servers are not), Overpass as the fallback (opening hours, brands).
const placeSearch = new FallbackPlaceSearchProvider([new TilePlaceSearchProvider(), ...(overpass ? [overpass] : [])]);
const demoPlaces = new LocalPlaceSearchProvider(DEMO_PLACES, "demo");
const geocoder = new OnlineGeocoderProvider();
const aiEnabled = () => useNaviaStore.getState().aiContextConsent;
/** "Додому" / "на роботу": the Home and Work the driver saved in the app (persisted), plus any set by the co-pilot this session. */
const savedPlaces = (): SavedPlace[] => {
  const { home, work } = usePlacesStore.getState();
  const fromApp: SavedPlace[] = [
    ...(home ? [{ kind: "home" as const, label: home.label, location: { lat: home.lat, lon: home.lon } }] : []),
    ...(work ? [{ kind: "work" as const, label: work.label, location: { lat: work.lat, lon: work.lon } }] : []),
  ];
  const session = useNaviaStore.getState().savedPlaces.filter((p) => !fromApp.some((a) => a.kind === p.kind));
  return [...fromApp, ...session];
};

const realRuntime = new EngineCopilotRuntime({
  host: navigationEngine,
  planner: tripPlanner,
  // Online OSM search only while the network is up; otherwise the co-pilot
  // reports place search as unavailable (the offline POI index plugs in
  // here as a LocalPlaceSearchProvider once scripts/data has produced it).
  places: () => (navigationEngine.getState().networkAvailable ? placeSearch : null),
  traffic: trafficProvider(),
  geocoder,
  savedPlaces,
  preferences: preferenceStore,
  // "I see a Fora and a junction": real map features around the estimate (map tiles).
  mapFeatures: (center, radiusM) => tileLocalizationData(center, radiusM),
  // A coarse fix (±65 m indoors, no known Wi-Fi) still tells the co-pilot roughly where we are.
  approximatePosition: () => {
    const a = useNaviaStore.getState().approxFix;
    return a && a.accuracyM != null ? { location: { lat: a.lat, lon: a.lon }, accuracyM: a.accuracyM, ageS: Math.round((Date.now() - a.timestamp) / 1000) } : null;
  },
  describePlace: (p) => streetAt(p),
  // Alert status and the shelters already loaded for the Safety panel.
  safetyInfo: () => {
    const alert = useNaviaStore.getState().alert;
    const nearby = useNearbyStore.getState().byCategory;
    const shelters = [...(nearby.shelter?.places ?? []), ...(nearby.resilience?.places ?? [])]
      .map((p) => ({ id: p.id, name: p.name, location: p.location, kind: p.category, source: p.source }));
    return {
      alert: alert ? { active: alert.active, area: alert.locationLabel || alert.region, since: alert.since, source: alert.source, checkedAt: alert.updatedAt } : null,
      shelters,
    };
  },
});
export const realCopilot = new NaviaCopilot({ runtime: realRuntime, llm, aiEnabled });

const demoRuntime = new EngineCopilotRuntime({
  host: demoEngine,
  planner: demoTripPlanner,
  places: demoPlaces,
  geocoder,
  savedPlaces,
  localPois: () => DEMO_PLACES,
  preferences: preferenceStore,
});
export const demoCopilot = new NaviaCopilot({ runtime: demoRuntime, llm, aiEnabled });

// NAVIA speaking up on its own (reminders the driver asked for, big traffic
// delays when a traffic feed exists), rate-limited — see ProactiveEngine.
const realProactive = new ProactiveEngine(realCopilot, realRuntime);
const demoProactive = new ProactiveEngine(demoCopilot, demoRuntime);
export function activeProactive(): ProactiveEngine {
  return useNaviaStore.getState().isDemoMode ? demoProactive : realProactive;
}

export function activeCopilot(): NaviaCopilot {
  return useNaviaStore.getState().isDemoMode ? demoCopilot : realCopilot;
}

export function isSmartCopilotConfigured(): boolean {
  return llm != null;
}

// The car's own speed from an OBD adapter (Settings → Автомобіль), when the driver switched it on.
export function startVehicleSpeed(): void {
  const { obdEnabled, startObd } = require("../vehicle/obdService") as typeof import("../vehicle/obdService");
  if (obdEnabled()) void startObd((mps) => navigationEngine.setVehicleSpeed(mps, Date.now()));
}
