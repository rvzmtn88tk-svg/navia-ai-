// TripPlanner — the trip the driver asked for: destination, ordered
// intermediate stops, and road-type preferences. It turns that plan into a
// RouteRequest for whatever RoutingProvider is active, so reroutes (off-route
// recovery, "add a coffee stop", "avoid unpaved roads") all go through one
// place and never drop a stop or a preference.

import type { LatLon } from "./types";
import type { Route, RouteRequest, RoutePreferences, RoutingProvider } from "./route-engine";
import { haversineMeters } from "./geodesy";
import { RouteGeometryIndex } from "./route-geometry";

export type TripStop = {
  id: string;
  label: string;
  location: LatLon;
  category?: string;
  addedAt: number;
};

export type TripDestination = { label: string; location: LatLon };

export type TripPlan = {
  destination: TripDestination | null;
  stops: TripStop[];
  preferences: RoutePreferences;
};

/** Sort stops by where they fall along `route` (unchanged order when there is no route). */
export function orderStopsAlongRoute<T extends { location: LatLon }>(stops: T[], route: Route | null): T[] {
  if (!route || route.geometry.length < 2) return [...stops];
  const index = new RouteGeometryIndex(route.geometry);
  return stops
    .map((s, i) => ({ s, i, along: index.project(s.location)?.alongM ?? Infinity }))
    .sort((a, b) => a.along - b.along || a.i - b.i)
    .map((x) => x.s);
}

/** A stop counts as visited once the vehicle passes within this distance of it. */
export const STOP_VISITED_RADIUS_M = 60;

export class TripPlanner {
  private plan: TripPlan = { destination: null, stops: [], preferences: {} };
  private stopSeq = 0;

  constructor(private routing: RoutingProvider) {}

  setRoutingProvider(routing: RoutingProvider): void {
    this.routing = routing;
  }

  getPlan(): TripPlan {
    return { destination: this.plan.destination, stops: [...this.plan.stops], preferences: { ...this.plan.preferences } };
  }

  setDestination(destination: TripDestination, opts: { keepStops?: boolean } = {}): void {
    this.plan = { ...this.plan, destination, stops: opts.keepStops ? this.plan.stops : [] };
  }

  /** Restore a saved plan (e.g. the active trip cached on the phone before an app restart). */
  restore(plan: TripPlan): void {
    this.plan = { destination: plan.destination, stops: plan.stops.map((s) => ({ ...s })), preferences: { ...plan.preferences } };
    for (const s of plan.stops) {
      const n = Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0);
      if (n > this.stopSeq) this.stopSeq = n;
    }
  }

  clear(): void {
    this.plan = { destination: null, stops: [], preferences: {} };
  }

  /**
   * Insert a stop in driving order: stops are kept sorted by where they
   * fall along `currentRoute` (falling back to appending before the
   * destination when there is no route to project onto).
   */
  addStop(stop: Omit<TripStop, "id" | "addedAt">, currentRoute: Route | null, now = Date.now()): TripStop {
    const created: TripStop = { ...stop, id: `s${++this.stopSeq}`, addedAt: now };
    this.plan = { ...this.plan, stops: orderStopsAlongRoute([...this.plan.stops, created], currentRoute) };
    return created;
  }

  removeStop(id: string): TripStop | null {
    const found = this.plan.stops.find((s) => s.id === id) ?? null;
    if (found) this.plan = { ...this.plan, stops: this.plan.stops.filter((s) => s.id !== id) };
    return found;
  }

  setPreferences(prefs: RoutePreferences): void {
    const merged: RoutePreferences = { ...this.plan.preferences, ...prefs };
    for (const k of Object.keys(merged) as (keyof RoutePreferences)[]) if (!merged[k]) delete merged[k];
    this.plan = { ...this.plan, preferences: merged };
  }

  /** Drop stops the vehicle has reached; returns them so the UI/voice can acknowledge. */
  markVisitedNear(position: LatLon, radiusM = STOP_VISITED_RADIUS_M): TripStop[] {
    const visited = this.plan.stops.filter((s) => haversineMeters(s.location, position) <= radiusM);
    if (visited.length > 0) {
      const ids = new Set(visited.map((s) => s.id));
      this.plan = { ...this.plan, stops: this.plan.stops.filter((s) => !ids.has(s.id)) };
    }
    return visited;
  }

  buildRequest(origin: LatLon, override: Partial<TripPlan> = {}): RouteRequest {
    const destination = override.destination ?? this.plan.destination;
    if (!destination) throw new Error("TripPlanner: no destination set");
    const stops = override.stops ?? this.plan.stops;
    const preferences = override.preferences ?? this.plan.preferences;
    return {
      origin,
      destination: destination.location,
      ...(stops.length > 0 ? { waypoints: stops.map((s) => s.location) } : {}),
      ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
    };
  }

  /** Route from `origin` honouring the whole plan. */
  async route(origin: LatLon, override: Partial<TripPlan> = {}): Promise<Route> {
    return this.routing.route(this.buildRequest(origin, override));
  }

  async alternatives(origin: LatLon): Promise<Route[]> {
    return this.routing.searchAlternatives(this.buildRequest(origin));
  }
}
