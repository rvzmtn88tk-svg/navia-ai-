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
import type { PreferenceStore } from "./preferences";

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
  /** The driver's long-term preferences, when the app keeps them. */
  preferences?(): PreferenceStore | null;
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
  preferences?: PreferenceStore | null;
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
  preferences(): PreferenceStore | null { return this.options.preferences ?? null; }
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

/** One list of results the driver heard ("the second one" refers to its item #2). */
export type ResultSet = { label: string; turn: number; items: RecentResult[] };

/** An action that changed the trip, with how to reverse it ("no, remove it again"). */
export type ActionRecord = {
  at: number;
  turn: number;
  tool: string;
  summary: string;
  undo: { tool: string; input: Record<string, unknown>; summary: string } | null;
};

/** Something the driver asked to be reminded of; the proactive engine fires it. */
export type Reminder = {
  id: string;
  topic: string;
  categories: string[];
  /** Fire at this time (ms), or when the car is this far along the route (m). */
  dueAtMs: number | null;
  dueAtAlongM: number | null;
  createdAt: number;
};

export type DialogueTurn = { user: string; assistant: string; at: number };

/** A pending action nobody confirmed within this many ms is dropped. */
export const PENDING_ACTION_TTL_MS = 5 * 60_000;

/**
 * Conversation + trip memory the tools and the agent loop share. Structured
 * (not keyword-parsed): the model sees it in <trip_state> and resolves
 * references itself — "the second one" = item #2 of the last result list,
 * "it" = the focus, "undo that" = the last action's undo.
 */
export class CopilotSession {
  turn = 0;
  /** Actions proposed and awaiting the driver's yes/no — several for a plan ("coffee first, then home"). */
  pendingActions: PendingAction[] = [];
  /** The latest result list first; a few earlier ones kept for "the one from before". */
  resultSets: ResultSet[] = [];
  /** The place or route most recently singled out (details asked, proposed, added). */
  focus: { id: string; label: string } | null = null;
  actions: ActionRecord[] = [];
  reminders: Reminder[] = [];
  /** Place/route ids whose time impact the driver has heard, with the turn they heard it. */
  presented = new Map<string, number>();
  private reminderSeq = 0;
  history: DialogueTurn[] = [];
  lastSmartTurnAt: number | null = null;

  /** First pending action (single-action compatibility). */
  get pending(): PendingAction | null { return this.pendingActions[0] ?? null; }
  set pending(p: PendingAction | null) { this.pendingActions = p ? [p] : []; }

  /** Items of the latest result list. */
  get recentResults(): RecentResult[] { return this.resultSets[0]?.items ?? []; }
  set recentResults(items: RecentResult[]) { this.pushResults("results", items); }

  pushResults(label: string, items: RecentResult[]): void {
    if (items.length === 0) return;
    for (const it of items) if (!this.presented.has(it.id)) this.presented.set(it.id, this.turn);
    this.resultSets.unshift({ label, turn: this.turn, items });
    if (this.resultSets.length > 3) this.resultSets.length = 3;
  }

  recordAction(a: Omit<ActionRecord, "turn">): void {
    this.actions.unshift({ ...a, turn: this.turn });
    if (this.actions.length > 6) this.actions.length = 6;
  }

  addReminder(r: Omit<Reminder, "id">): Reminder {
    const rem = { ...r, id: `m${++this.reminderSeq}` };
    this.reminders.push(rem);
    return rem;
  }

  /** Called at the start of every driver message. */
  beginTurn(nowMs: number): void {
    this.turn += 1;
    this.pendingActions = this.pendingActions.filter((p) => nowMs - p.createdAt <= PENDING_ACTION_TTL_MS && this.turn - p.proposedAtTurn <= 2);
  }

  reset(): void {
    this.turn = 0;
    this.pendingActions = [];
    this.resultSets = [];
    this.focus = null;
    this.actions = [];
    this.reminders = [];
    this.presented.clear();
    this.history = [];
    this.lastSmartTurnAt = null;
  }
}
