// What the co-pilot needs from the app, plus the per-conversation state the
// tool executor and the agent loop share.

import type { LatLon, NavigationState } from "../types";
import type { Route } from "../route-engine";
import type { POI } from "../landmark-engine";
import type { GeocoderProvider } from "../geocoder";
import type { PlaceSearchProvider } from "../place-search";
import type { TrafficProvider } from "../traffic";
import { UnavailableTrafficProvider } from "../traffic";
import type { TripPlanner } from "../trip-planner";

export type SavedPlace = { kind: "home" | "work"; label: string; location: LatLon };

/**
 * The app-side surface the co-pilot's tools run against. Implemented by
 * EngineCopilotRuntime for NavigationEngine/DemoEngine; tests implement it
 * directly. Nothing here is AI-specific — it is the navigation stack's own
 * state and actions.
 */
export interface CopilotRuntime {
  now(): Date;
  getNavigation(): { state: NavigationState; route: Route | null };
  readonly planner: TripPlanner;
  places(): PlaceSearchProvider | null;
  traffic(): TrafficProvider;
  geocoder(): GeocoderProvider | null;
  savedPlaces(): SavedPlace[];
  /** Make `route` the active route of the navigation engine. */
  applyRoute(route: Route): void;
  isNetworkAvailable(): boolean;
  /** POIs available on-device, used by the offline deterministic fallback. */
  localPois(): readonly POI[];
}

/** Anything that owns the active route: NavigationEngine and DemoEngine both qualify. */
export interface CopilotNavigationHost {
  getState(): NavigationState;
  getRoute(): Route | null;
  applyRoute(route: Route): void;
}

export type EngineRuntimeOptions = {
  host: CopilotNavigationHost | (() => CopilotNavigationHost);
  planner: TripPlanner;
  places?: PlaceSearchProvider | null | (() => PlaceSearchProvider | null);
  traffic?: TrafficProvider;
  geocoder?: GeocoderProvider | null;
  savedPlaces?: () => SavedPlace[];
  localPois?: () => readonly POI[];
  now?: () => Date;
};

export class EngineCopilotRuntime implements CopilotRuntime {
  readonly planner: TripPlanner;
  private trafficProvider: TrafficProvider;

  constructor(private options: EngineRuntimeOptions) {
    this.planner = options.planner;
    this.trafficProvider = options.traffic ?? new UnavailableTrafficProvider();
  }

  private host(): CopilotNavigationHost {
    return typeof this.options.host === "function" ? this.options.host() : this.options.host;
  }

  now(): Date { return this.options.now ? this.options.now() : new Date(); }
  getNavigation() { const h = this.host(); return { state: h.getState(), route: h.getRoute() }; }
  places(): PlaceSearchProvider | null {
    const p = this.options.places;
    return typeof p === "function" ? p() : p ?? null;
  }
  traffic(): TrafficProvider { return this.trafficProvider; }
  geocoder(): GeocoderProvider | null { return this.options.geocoder ?? null; }
  savedPlaces(): SavedPlace[] { return this.options.savedPlaces?.() ?? []; }
  applyRoute(route: Route): void { this.host().applyRoute(route); }
  isNetworkAvailable(): boolean { return this.host().getState().networkAvailable; }
  localPois(): readonly POI[] { return this.options.localPois?.() ?? []; }
}

// --- entity registry: short ids the model uses instead of coordinates ---

export type PlaceEntity = {
  kind: "place";
  id: string;
  label: string;
  location: LatLon;
  poi?: POI;
  category?: string;
};
export type RouteEntity = { kind: "route"; id: string; route: Route };
export type Entity = PlaceEntity | RouteEntity;

export class EntityRegistry {
  private placeSeq = 0;
  private routeSeq = 0;
  private byId = new Map<string, Entity>();
  private idByKey = new Map<string, string>();

  constructor(private maxEntries = 300) {}

  /** Register a place under a stable short id (same external key -> same id for the whole trip). */
  registerPlace(key: string, data: Omit<PlaceEntity, "kind" | "id">): PlaceEntity {
    const existing = this.idByKey.get(key);
    if (existing) {
      const entity: PlaceEntity = { kind: "place", id: existing, ...data };
      this.byId.set(existing, entity);
      return entity;
    }
    const id = `p${++this.placeSeq}`;
    const entity: PlaceEntity = { kind: "place", id, ...data };
    this.byId.set(id, entity);
    this.idByKey.set(key, id);
    this.evict();
    return entity;
  }

  registerRoute(route: Route): RouteEntity {
    const id = `r${++this.routeSeq}`;
    const entity: RouteEntity = { kind: "route", id, route };
    this.byId.set(id, entity);
    this.evict();
    return entity;
  }

  get(id: string): Entity | undefined {
    return this.byId.get(id.trim());
  }

  private evict(): void {
    while (this.byId.size > this.maxEntries) {
      const oldest = this.byId.keys().next().value as string;
      this.byId.delete(oldest);
      for (const [k, v] of this.idByKey) if (v === oldest) this.idByKey.delete(k);
    }
  }
}

// --- conversation/session state ---

export type PendingAction = {
  tool: string;
  input: Record<string, unknown>;
  /** tool + target; a later call with the same key is the confirmation. */
  key: string;
  proposedAtTurn: number;
  createdAt: number;
  /** Short human-readable description, shown on the confirm button and in trip_state. */
  summary: string;
};

export type RecentResult = { id: string; line: string };

export type DialogueTurn = { user: string; assistant: string; at: number };

/** A pending action nobody confirmed within this many ms is dropped. */
export const PENDING_ACTION_TTL_MS = 5 * 60_000;

export class CopilotSession {
  turn = 0;
  pending: PendingAction | null = null;
  recentResults: RecentResult[] = [];
  history: DialogueTurn[] = [];
  lastSmartTurnAt: number | null = null;

  /** Called at the start of every driver message. */
  beginTurn(nowMs: number): void {
    this.turn += 1;
    if (this.pending && (nowMs - this.pending.createdAt > PENDING_ACTION_TTL_MS || this.turn - this.pending.proposedAtTurn > 2)) {
      this.pending = null;
    }
  }

  reset(): void {
    this.turn = 0;
    this.pending = null;
    this.recentResults = [];
    this.history = [];
    this.lastSmartTurnAt = null;
  }
}
