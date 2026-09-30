// A reproducible trip world for testing and evaluating the AI co-pilot:
// the demo Kyiv (Maidan) -> Boryspil road, the vehicle placed at a chosen
// distance along it, DEMO_ROUTE_POIS as the place database, and switches
// for the failure modes the co-pilot must handle honestly (no network
// place search, routing failure, low position confidence, no route).
//
// Used by packages/core/test (with a scripted LLM, to test the plumbing)
// and by apps/ai-backend/eval (with the real model, to evaluate behaviour).

import type { ConfidenceBand, GNSSIntegrityState, LatLon, NavigationState } from "../src/types";
import type { Route, RouteRequest, RoutingProvider, MapMatchResult } from "../src/route-engine";
import { RouteProgressEngine } from "../src/route-engine";
import { DemoRoutingProvider } from "../src/demo-routing-provider";
import { DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_DESTINATION, DEMO_ROUTE_POIS, demoPointAlongRoad } from "../src/demo-data";
import { DemoGeocoderProvider } from "../src/geocoder";
import { LocalPlaceSearchProvider, type PlaceSearchProvider } from "../src/place-search";
import type { POI } from "../src/landmark-engine";
import { TripPlanner } from "../src/trip-planner";
import { EngineCopilotRuntime, type CopilotNavigationHost, type SavedPlace } from "../src/copilot/runtime";
import type { TrafficProvider } from "../src/traffic";
import type { PreferenceStore } from "../src/copilot/preferences";

export type WorldOptions = {
  /** Vehicle position, metres along the demo road from Maidan. Default 2 km. */
  alongM?: number;
  band?: ConfidenceBand;
  gnss?: GNSSIntegrityState;
  network?: boolean;
  /** Place database behaviour, or an explicit place list. */
  places?: "demo" | "none" | "failing" | "empty" | POI[];
  savedPlaces?: SavedPlace[];
  /** Start with no active route (e.g. "take me home" from idle). */
  noRoute?: boolean;
  /** Every routing call after the initial route fails (Valhalla down). */
  routingFails?: boolean;
  traffic?: TrafficProvider;
  now?: Date;
  /** Long-term driver preferences available to the co-pilot. */
  preferences?: PreferenceStore;
};

/** Tuesday 29 Sep 2026, 14:00 device-local time. */
export const WORLD_DEFAULT_NOW = new Date(2026, 8, 29, 14, 0, 0);

export const WORLD_SAVED_HOME: SavedPlace = { kind: "home", label: "Дім (Бориспіль, вул. Київський Шлях)", location: { lat: 50.3530, lon: 30.9420 } };

class SwitchableRoutingProvider implements RoutingProvider {
  failing = false;
  calls = 0;
  constructor(private inner: RoutingProvider) {}
  private check() {
    this.calls++;
    if (this.failing) throw new Error("routing backend unreachable (simulated)");
  }
  async route(r: RouteRequest): Promise<Route> { this.check(); return this.inner.route(r); }
  async searchAlternatives(r: RouteRequest): Promise<Route[]> { this.check(); return this.inner.searchAlternatives(r); }
  async match(p: LatLon[]): Promise<MapMatchResult> { return this.inner.match(p); }
}

class FailingPlaces implements PlaceSearchProvider {
  readonly source = "osm-online" as const;
  async searchAlongPolyline(): Promise<POI[]> { throw new Error("Overpass returned 504 Gateway Timeout"); }
  async searchAround(): Promise<POI[]> { throw new Error("Overpass returned 504 Gateway Timeout"); }
}

/**
 * Holds a fixed vehicle position; route progress fields (next step,
 * remaining distance) are computed by the real RouteProgressEngine for
 * whatever route is active, and applyRoute swaps it like the real engines.
 */
export class FixedPositionHost implements CopilotNavigationHost {
  route: Route | null = null;
  private progress = new RouteProgressEngine();
  constructor(public state: NavigationState) {}
  getState(): NavigationState {
    const pos = this.state.position?.position;
    if (!this.route || !pos) return this.state;
    const p = this.progress.computeProgress(this.route, pos, this.state.speedMps);
    return { ...this.state, routeProgressM: p.distanceCompletedM, routeRemainingM: p.distanceRemainingM, nextStep: p.nextStep };
  }
  getRoute(): Route | null { return this.route; }
  applyRoute(route: Route): void { this.route = route; }
}

export type World = {
  runtime: EngineCopilotRuntime;
  host: FixedPositionHost;
  planner: TripPlanner;
  routing: SwitchableRoutingProvider;
  position: LatLon;
  /** Move the world clock (reminders, "minutes ago"). */
  setNow: (d: Date) => void;
};

export async function buildWorld(opts: WorldOptions = {}): Promise<World> {
  const alongM = opts.alongM ?? 2_000;
  const position = demoPointAlongRoad(alongM, 0);
  const band = opts.band ?? "HIGH";
  const confidence = { HIGH: 0.9, MEDIUM: 0.6, LOW: 0.35, UNKNOWN: 0.1 }[band];
  const now = opts.now ?? WORLD_DEFAULT_NOW;
  const clock = { now };
  const state: NavigationState = {
    mode: opts.noRoute ? "IDLE" : band === "LOW" || band === "UNKNOWN" ? "POSITION_UNCERTAIN" : "ACTIVE",
    position: { position: { ...position, timestamp: now.getTime(), accuracyM: band === "HIGH" ? 5 : 40, source: "FUSED" }, confidence, band, source: "FUSED" },
    trustedPosition: null,
    gnss: opts.gnss ?? (band === "HIGH" ? "NORMAL" : "DEGRADED"),
    confidence, confidenceBand: band,
    speedMps: 16.7, headingDeg: 100,
    routeProgressM: alongM, routeRemainingM: 0, nextStep: null, nearbyLandmarks: [],
    offRoute: false, networkAvailable: opts.network ?? true, offlineMapAvailable: false,
    lastTrustedFixAt: now.getTime(), updatedAt: now.getTime(),
  };
  const host = new FixedPositionHost(state);
  const routing = new SwitchableRoutingProvider(new DemoRoutingProvider(DEMO_KYIV_TO_BORYSPIL_GRAPH));
  const planner = new TripPlanner(routing);
  if (!opts.noRoute) {
    planner.setDestination({ label: "Бориспіль", location: DEMO_DESTINATION });
    host.route = await planner.route(DEMO_ORIGIN);
  }
  routing.failing = opts.routingFails ?? false;

  const placesMode = opts.places ?? "demo";
  const places: PlaceSearchProvider | null =
    Array.isArray(placesMode) ? new LocalPlaceSearchProvider(placesMode, "demo")
    : placesMode === "none" ? null
      : placesMode === "failing" ? new FailingPlaces()
        : new LocalPlaceSearchProvider(placesMode === "empty" ? [] : DEMO_ROUTE_POIS, "demo");

  const runtime = new EngineCopilotRuntime({
    host,
    planner,
    places,
    ...(opts.traffic ? { traffic: opts.traffic } : {}),
    geocoder: new DemoGeocoderProvider([
      { label: "Бориспіль, аеропорт «Бориспіль»", location: { lat: 50.3450, lon: 30.8947 } },
      { label: "Бориспіль, центр", location: DEMO_DESTINATION },
      { label: "Бровари, центр", location: { lat: 50.5110, lon: 30.7909 } },
    ]),
    savedPlaces: () => opts.savedPlaces ?? [],
    localPois: () => DEMO_ROUTE_POIS,
    ...(opts.preferences ? { preferences: opts.preferences } : {}),
    now: () => clock.now,
  });
  return { runtime, host, planner, routing, position, setNow: (d: Date) => { clock.now = d; } };
}
