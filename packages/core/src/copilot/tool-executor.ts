// Executes co-pilot tool calls against the app's real navigation stack.
//
// The model decides WHICH tool to call and with what constraints; this file
// computes every number it gets back — along-route distances, minutes from
// now, detours (routed through the RoutingProvider where possible, otherwise
// a labelled geometric estimate), reachability with a reserve, opening
// status — and performs trip actions (stops, destination, preferences,
// alternatives) with a confirmation gate. Results are compact JSON with
// short ids and no coordinates.

import type { LatLon, ConfidenceBand, RouteStep } from "../types";
import type { Route, RoutePreferences } from "../route-engine";
import type { POI, LandmarkCategory } from "../landmark-engine";
import { LandmarkEngine } from "../landmark-engine";
import { haversineMeters } from "../geodesy";
import { RouteGeometryIndex, RouteTimeline, estimateDetourSeconds, DETOUR_ACCESS_SPEED_MPS, DETOUR_CIRCUITY_FACTOR } from "../route-geometry";
import { evaluateOpeningHours, type PlaceFilter } from "../place-search";
import { orderStopsAlongRoute, type TripStop } from "../trip-planner";
import { CONFIRMATION_REQUIRED_TOOLS, SEARCHABLE_CATEGORIES } from "./tool-definitions";
import type { CopilotRuntime, CopilotSession, EntityRegistry, PlaceEntity } from "./runtime";

export type ToolContext = {
  runtime: CopilotRuntime;
  registry: EntityRegistry;
  session: CopilotSession;
};

export type ToolOutcome = {
  content: Record<string, unknown>;
  isError: boolean;
  /** Deterministic Ukrainian sentence for actions confirmed from the UI (no LLM round-trip). */
  spoken?: string;
};

/** Share of the stated range assumed usable, keeping a reserve for estimate error and detours. */
export const RANGE_SAFETY_FACTOR = 0.85;
const MAX_ROUTED_DETOUR_CANDIDATES = 6;
const ROUTED_DETOUR_TIMEOUT_MS = 8_000;
const DEFAULT_LOOKAHEAD_M = 60_000;
const WALK_SPEED_MPS = 1.25;

// ---------- small helpers ----------

const r1 = (x: number) => Math.round(x * 10) / 10;
const r0 = (x: number) => Math.round(x);
const km = (m: number) => (m < 10_000 ? r1(m / 1000) : r0(m / 1000));
const minutes = (s: number) => Math.max(0, r0(s / 60));

function clockTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Arrival clock time, rounded to the same whole minute the spoken duration uses. */
export function arrivalClock(now: Date, secondsFromNow: number): string {
  return clockTime(new Date(now.getTime() + Math.round(secondsFromNow / 60) * 60_000));
}

function err(code: string, message: string): ToolOutcome {
  return { content: { error: code, message }, isError: true };
}

function numArg(input: Record<string, unknown>, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const v = input[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(max, v));
}
function boolArg(input: Record<string, unknown>, key: string): boolean | undefined {
  return typeof input[key] === "boolean" ? (input[key] as boolean) : undefined;
}
function strArg(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function filterArg(input: Record<string, unknown>): PlaceFilter {
  const cats = Array.isArray(input.categories)
    ? (input.categories.filter((c) => typeof c === "string" && (SEARCHABLE_CATEGORIES as string[]).includes(c)) as LandmarkCategory[])
    : [];
  const names = Array.isArray(input.name_variants)
    ? input.name_variants.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 6)
    : [];
  return { ...(cats.length ? { categories: cats } : {}), ...(names.length ? { nameVariants: names } : {}) };
}

function currentPosition(ctx: ToolContext): LatLon | null {
  const { state } = ctx.runtime.getNavigation();
  const p = state.position?.position ?? state.trustedPosition?.position ?? null;
  return p ? { lat: p.lat, lon: p.lon } : null;
}

function positionUncertain(band: ConfidenceBand): boolean {
  return band === "LOW" || band === "UNKNOWN";
}

/** Everything about "where we are on the active route", computed once per call. */
type RouteContext = {
  route: Route;
  index: RouteGeometryIndex;
  timeline: RouteTimeline;
  position: LatLon;
  alongNowM: number;
  secondsNow: number;
  remainingM: number;
  remainingS: number;
  band: ConfidenceBand;
};

const indexCache = new WeakMap<Route, { index: RouteGeometryIndex; timeline: RouteTimeline }>();
function indexFor(route: Route) {
  let cached = indexCache.get(route);
  if (!cached) {
    cached = { index: new RouteGeometryIndex(route.geometry), timeline: new RouteTimeline(route) };
    indexCache.set(route, cached);
  }
  return cached;
}

export function buildRouteContext(runtime: CopilotRuntime): RouteContext | null {
  const { state, route } = runtime.getNavigation();
  const pos = state.position?.position ?? state.trustedPosition?.position ?? null;
  if (!route || route.geometry.length < 2 || !pos) return null;
  const { index, timeline } = indexFor(route);
  const position = { lat: pos.lat, lon: pos.lon };
  const alongNowM = index.project(position)?.alongM ?? 0;
  const secondsNow = timeline.secondsAt(alongNowM);
  const remainingM = Math.max(0, index.lengthM - alongNowM);
  const remainingS = Math.max(0, timeline.secondsAt(index.lengthM) - secondsNow);
  return { route, index, timeline, position, alongNowM, secondsNow, remainingM, remainingS, band: state.confidenceBand };
}

function placeKey(poi: POI): string {
  return `poi:${poi.id}`;
}

function registerPoi(ctx: ToolContext, poi: POI): PlaceEntity {
  return ctx.registry.registerPlace(placeKey(poi), { label: poi.name, location: poi.location, poi, category: poi.category });
}

function openNowField(poi: POI, now: Date): boolean | "unknown" {
  const v = evaluateOpeningHours(poi.openingHours, now);
  return v == null ? "unknown" : v;
}

/** Roads by driven length; `skipFirstM` removes the already-driven part of the first step. */
function mainRoads(steps: RouteStep[], limit = 4, skipFirstM = 0): { road: string; km: number }[] {
  const byRoad = new Map<string, number>();
  steps.forEach((s, i) => {
    const len = i === 0 ? Math.max(0, s.distanceM - skipFirstM) : s.distanceM;
    if (!s.roadName || len <= 0) return;
    byRoad.set(s.roadName, (byRoad.get(s.roadName) ?? 0) + len);
  });
  return [...byRoad.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([road, m]) => ({ road, km: km(m) }));
}

/** Steps from the one currently being driven onwards. */
function stepsAhead(rc: RouteContext): { current: RouteStep[]; offsetInFirstM: number } {
  let cum = 0;
  const steps = rc.route.steps;
  for (let i = 0; i < steps.length; i++) {
    const end = cum + steps[i]!.distanceM;
    if (rc.alongNowM < end || i === steps.length - 1) {
      return { current: steps.slice(i), offsetInFirstM: rc.alongNowM - cum };
    }
    cum = end;
  }
  return { current: [], offsetInFirstM: 0 };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopFromPlace(place: PlaceEntity): Omit<TripStop, "id" | "addedAt"> {
  return { label: place.label, location: place.location, ...(place.category ? { category: place.category } : {}) };
}

/** Routed time impact of visiting `place` on the way, vs. the current plan; null if the router can't say. */
async function routedDetourSeconds(ctx: ToolContext, rc: RouteContext, place: PlaceEntity, baselineS: number): Promise<number | null> {
  const plan = ctx.runtime.planner.getPlan();
  if (!plan.destination) return null;
  const tentative = orderStopsAlongRoute([...plan.stops, { ...stopFromPlace(place), id: "tmp", addedAt: 0 }], rc.route);
  const withStop = await ctx.runtime.planner.route(rc.position, { stops: tentative });
  // Sanity: the routed trip must actually pass the place; otherwise the
  // provider snapped the stop somewhere else and the number is meaningless.
  const passes = new RouteGeometryIndex(withStop.geometry).project(place.location);
  if (!passes || passes.offsetM > 150) return null;
  return Math.max(0, withStop.durationS - baselineS);
}

// ---------- tools ----------

async function searchAlongRoute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position to search along.");
  const places = ctx.runtime.places();
  if (!places) return err("place_search_unavailable", "No place database is available (no network place search and no offline POI index loaded).");

  const filter = filterArg(input);
  if (!filter.categories && !filter.nameVariants) return err("bad_request", "Give categories and/or name_variants.");
  const limit = numArg(input, "limit", 1, 5) ?? 3;
  const maxDetourS = numArg(input, "max_detour_minutes", 0, 120) != null ? numArg(input, "max_detour_minutes", 0, 120)! * 60 : null;
  const rangeM = numArg(input, "vehicle_range_km", 0, 2000) != null ? numArg(input, "vehicle_range_km", 0, 2000)! * 1000 : null;
  const openOnly = boolArg(input, "open_now_only") ?? false;
  const now = ctx.runtime.now();

  let fromM = rc.alongNowM;
  let toM = Math.min(rc.index.lengthM, rc.alongNowM + DEFAULT_LOOKAHEAD_M);
  const minMin = numArg(input, "ahead_min_minutes", 0, 600);
  const maxMin = numArg(input, "ahead_max_minutes", 0, 600);
  const maxKm = numArg(input, "ahead_max_km", 0, 2000);
  if (minMin != null) fromM = Math.max(fromM, rc.timeline.distanceAtSeconds(rc.secondsNow + minMin * 60));
  if (maxMin != null) toM = Math.min(toM, rc.timeline.distanceAtSeconds(rc.secondsNow + maxMin * 60));
  if (maxKm != null) toM = Math.min(toM, rc.alongNowM + maxKm * 1000);
  // Look somewhat beyond the stated range: "the nearest station is 7 km away,
  // just past your 5 km" is exactly what a driver on reserve needs to hear.
  if (rangeM != null) toM = Math.min(toM, rc.alongNowM + Math.max(rangeM * 1.5, rangeM + 10_000));
  if (toM - fromM < 50) {
    return {
      content: {
        results: [],
        note: "search window is empty (the requested window lies beyond the end of the route or range)",
        remaining_km: km(rc.remainingM),
        remaining_min: minutes(rc.remainingS),
      },
      isError: false,
    };
  }

  // Corridor wide enough that a place at its edge could still meet the detour limit.
  const corridorM = maxDetourS != null
    ? Math.max(200, Math.min(3000, ((maxDetourS * DETOUR_ACCESS_SPEED_MPS) / (2 * DETOUR_CIRCUITY_FACTOR)) * 1.5))
    : 1500;

  let raw: POI[];
  try {
    raw = await places.searchAlongPolyline(rc.index.slice(fromM, toM), corridorM, filter, 80);
  } catch (e) {
    return err("place_search_failed", `Place search failed: ${(e as Error).message}`);
  }

  type Cand = { poi: POI; aheadM: number; offsetM: number; side: string; aheadS: number; detourS: number; detourKind: "routed" | "estimated"; open: boolean | "unknown" };
  let closed = 0;
  let cands: Cand[] = [];
  for (const poi of raw) {
    const proj = rc.index.project(poi.location, fromM - 200);
    if (!proj || proj.alongM < rc.alongNowM - 30) continue; // behind the car
    const open = openNowField(poi, now);
    if (openOnly && open === false) { closed++; continue; }
    cands.push({
      poi,
      aheadM: Math.max(0, proj.alongM - rc.alongNowM),
      offsetM: proj.offsetM,
      side: proj.side,
      aheadS: Math.max(0, rc.timeline.secondsAt(proj.alongM) - rc.secondsNow),
      detourS: estimateDetourSeconds(proj.offsetM),
      detourKind: "estimated",
      open,
    });
  }
  const foundTotal = cands.length;
  // Known-closed places rank after open/unknown ones: a driver asking for a
  // place to stop almost never wants one that is closed right now.
  const closedRank = (c: Cand) => (c.open === false ? 1 : 0);
  cands.sort((a, b) => closedRank(a) - closedRank(b) || a.detourS - b.detourS || a.aheadM - b.aheadM);
  if (maxDetourS != null) cands = cands.filter((c) => c.detourS <= maxDetourS * 1.5 + 60);

  // Refine the most promising candidates with real routed detours.
  const refine = cands.slice(0, Math.min(MAX_ROUTED_DETOUR_CANDIDATES, Math.max(limit * 2, 3)));
  let routingNote: string | undefined;
  if (refine.length > 0 && ctx.runtime.planner.getPlan().destination) {
    try {
      const baseline = await withTimeout(ctx.runtime.planner.route(rc.position), ROUTED_DETOUR_TIMEOUT_MS);
      await withTimeout(Promise.all(refine.map(async (c) => {
        const place = registerPoi(ctx, c.poi);
        const s = await routedDetourSeconds(ctx, rc, place, baseline.durationS).catch(() => null);
        if (s != null) { c.detourS = s; c.detourKind = "routed"; }
      })), ROUTED_DETOUR_TIMEOUT_MS);
    } catch (e) {
      routingNote = `routed detours unavailable (${(e as Error).message}); detours are geometric estimates`;
    }
  }

  let excludedByDetour = 0;
  if (maxDetourS != null) {
    cands = cands.filter((c) => c.detourS <= maxDetourS);
    excludedByDetour = foundTotal - cands.length;
  }

  const reachable = (c: Cand) => rangeM == null ? undefined : c.aheadM + c.offsetM * DETOUR_CIRCUITY_FACTOR <= rangeM * RANGE_SAFETY_FACTOR;
  cands.sort((a, b) => {
    if (rangeM != null) {
      const ra = reachable(a) ? 0 : 1, rb = reachable(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (ra === 1) return a.aheadM - b.aheadM; // out of range: the nearest one is the only one that matters
    }
    return closedRank(a) - closedRank(b) || a.detourS - b.detourS || a.aheadM - b.aheadM;
  });

  // Choose the best `limit` by the ranking above, but present them in driving
  // order: that is how the driver hears them, so "the second one" means the
  // same place to the driver, the model and last_results.
  const top = cands.slice(0, limit).sort((a, b) => {
    if (rangeM != null) {
      const ra = reachable(a) ? 0 : 1, rb = reachable(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
    }
    return a.aheadM - b.aheadM;
  });
  const results = top.map((c) => {
    const place = registerPoi(ctx, c.poi);
    const r = reachable(c);
    return {
      id: place.id,
      name: c.poi.name,
      ...(c.poi.brand && c.poi.brand !== c.poi.name ? { brand: c.poi.brand } : {}),
      category: c.poi.category,
      ...(c.poi.cuisine ? { cuisine: c.poi.cuisine } : {}),
      ahead_km: km(c.aheadM),
      ahead_min: minutes(c.aheadS),
      detour_min: r1(c.detourS / 60),
      detour: c.detourKind,
      side: c.side,
      open_now: c.open,
      ...(r !== undefined ? { reachable: r } : {}),
    };
  });
  ctx.session.recentResults = results.map((r) => ({
    id: r.id,
    line: `${r.id} ${r.name} (${r.category}) ${r.ahead_km} km ahead, +${r.detour_min} min`,
  }));

  return {
    content: {
      source: places.source,
      ...(positionUncertain(rc.band) ? { position_uncertain: true } : {}),
      searched: { from_km_ahead: km(fromM - rc.alongNowM), to_km_ahead: km(toM - rc.alongNowM), corridor_m: r0(corridorM) },
      found_total: foundTotal,
      ...(excludedByDetour > 0 ? { excluded_by_detour: excludedByDetour } : {}),
      ...(closed > 0 ? { excluded_closed: closed } : {}),
      ...(rangeM != null ? { range_reserve: `reachable assumes ${Math.round(RANGE_SAFETY_FACTOR * 100)}% of the stated range` } : {}),
      ...(routingNote ? { note: routingNote } : {}),
      results,
    },
    isError: false,
  };
}

async function searchNear(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const places = ctx.runtime.places();
  if (!places) return err("place_search_unavailable", "No place database is available (no network place search and no offline POI index loaded).");
  const anchor = strArg(input, "anchor");
  let center: LatLon | null = null;
  let anchorLabel = "";
  if (anchor === "destination") {
    const dest = ctx.runtime.planner.getPlan().destination;
    const route = ctx.runtime.getNavigation().route;
    center = dest?.location ?? route?.geometry[route.geometry.length - 1] ?? null;
    anchorLabel = dest?.label ?? "destination";
    if (!center) return err("no_destination", "No destination is set.");
  } else if (anchor === "current_position") {
    center = currentPosition(ctx);
    anchorLabel = "current position";
    if (!center) return err("no_position", "The current position is unknown.");
  } else if (anchor === "place") {
    const id = strArg(input, "place_id");
    const e = id ? ctx.registry.get(id) : undefined;
    if (!e || e.kind !== "place") return err("unknown_place_id", `Unknown place id "${id ?? ""}". Use an id from an earlier result.`);
    center = e.location;
    anchorLabel = e.label;
  } else {
    return err("bad_request", "anchor must be destination, current_position or place.");
  }

  const filter = filterArg(input);
  if (!filter.categories && !filter.nameVariants) return err("bad_request", "Give categories and/or name_variants.");
  const radius = numArg(input, "radius_m", 50, 5000) ?? 800;
  const limit = numArg(input, "limit", 1, 5) ?? 3;
  const openOnly = boolArg(input, "open_now_only") ?? false;
  const now = ctx.runtime.now();

  let raw: POI[];
  try {
    raw = await places.searchAround(center, radius, filter, 60);
  } catch (e) {
    return err("place_search_failed", `Place search failed: ${(e as Error).message}`);
  }
  let closed = 0;
  const rows = raw
    .map((poi) => ({ poi, d: haversineMeters(center!, poi.location), open: openNowField(poi, now) }))
    .filter((x) => { if (openOnly && x.open === false) { closed++; return false; } return true; })
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
  const walking = anchor !== "current_position";
  const results = rows.map((x) => {
    const place = registerPoi(ctx, x.poi);
    return {
      id: place.id,
      name: x.poi.name,
      category: x.poi.category,
      distance_m: Math.round(x.d / 10) * 10,
      ...(walking ? { walk_min: Math.max(1, minutes(x.d / WALK_SPEED_MPS)) } : {}),
      open_now: x.open,
    };
  });
  ctx.session.recentResults = results.map((r) => ({ id: r.id, line: `${r.id} ${r.name} (${r.category}) ${r.distance_m} m from ${anchorLabel}` }));
  return {
    content: {
      source: places.source,
      anchor: anchorLabel,
      radius_m: radius,
      found_total: raw.length,
      ...(closed > 0 ? { excluded_closed: closed } : {}),
      results,
      note: "distances are straight-line from the anchor",
    },
    isError: false,
  };
}

function routeOverview(ctx: ToolContext): ToolOutcome {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position.");
  const plan = ctx.runtime.planner.getPlan();
  const now = ctx.runtime.now();
  const { current, offsetInFirstM } = stepsAhead(rc);
  const uncertain = positionUncertain(rc.band);
  let toManeuverM = (current[0]?.distanceM ?? 0) - offsetInFirstM;
  const next = current.slice(1, 4).map((s) => {
    const row = {
      maneuver: s.maneuver,
      road: s.roadName || "unnamed road",
      in_m: uncertain ? "withheld: position uncertain" : Math.max(0, Math.round(toManeuverM / 10) * 10),
    };
    toManeuverM += s.distanceM;
    return row;
  });
  const stops = plan.stops.map((s) => {
    const proj = rc.index.project(s.location, rc.alongNowM - 50);
    return {
      id: s.id,
      name: s.label,
      ...(proj ? { ahead_km: km(Math.max(0, proj.alongM - rc.alongNowM)), ahead_min: minutes(rc.timeline.secondsAt(proj.alongM) - rc.secondsNow) } : {}),
    };
  });
  return {
    content: {
      provider: rc.route.source,
      destination: plan.destination?.label ?? "unknown",
      total_km: km(rc.route.distanceM),
      remaining_km: km(rc.remainingM),
      remaining_min: minutes(rc.remainingS),
      arrival: arrivalClock(now, rc.remainingS),
      stops,
      preferences_applied: rc.route.appliedPreferences ?? [],
      preferences_unsupported: rc.route.unsupportedPreferences ?? [],
      main_roads_ahead: mainRoads(current, 4, offsetInFirstM),
      next_maneuvers: next,
      basis: "Route and times come from the routing engine's cost model (no live traffic unless get_traffic_ahead says otherwise).",
      ...(uncertain ? { position_uncertain: true } : {}),
    },
    isError: false,
  };
}

async function compareRoutes(ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position.");
  if (!ctx.runtime.planner.getPlan().destination) return err("no_destination", "No destination is set in the trip plan.");
  let alts: Route[];
  try {
    alts = await withTimeout(ctx.runtime.planner.alternatives(rc.position), 10_000);
  } catch (e) {
    return err("routing_failed", `The routing engine could not compute alternatives: ${(e as Error).message}`);
  }
  const ahead = stepsAhead(rc);
  const currentRoads = mainRoads(ahead.current, 3, ahead.offsetInFirstM);
  const rows = alts
    // An "alternative" that doesn't start where the car is would be misleading.
    .filter((route) => route.geometry.length > 0 && haversineMeters(route.geometry[0]!, rc.position) < 200)
    .map((route) => ({ route, dMin: (route.durationS - rc.remainingS) / 60, dKm: (route.distanceM - rc.remainingM) / 1000 }))
    .filter((x) => !(Math.abs(x.dMin) < 0.5 && Math.abs(x.dKm) < 0.2)) // same as the active route
    .slice(0, 3)
    .map((x) => {
      const e = ctx.registry.registerRoute(x.route);
      return {
        id: e.id,
        minutes: minutes(x.route.durationS),
        km: km(x.route.distanceM),
        delta_min: r1(x.dMin),
        delta_km: r1(x.dKm),
        main_roads: mainRoads(x.route.steps, 3),
      };
    });
  return {
    content: {
      provider: rc.route.source,
      active: { remaining_min: minutes(rc.remainingS), remaining_km: km(rc.remainingM), main_roads_ahead: currentRoads },
      alternatives: rows,
      ...(rows.length === 0 ? { note: "the routing engine returned no meaningfully different alternative" } : {}),
      live_traffic: "not included in these times",
    },
    isError: false,
  };
}

async function trafficAhead(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route.");
  const maxKm = numArg(input, "ahead_max_km", 0, 2000);
  const toM = maxKm != null ? Math.min(rc.index.lengthM, rc.alongNowM + maxKm * 1000) : rc.index.lengthM;
  let report;
  try {
    report = await ctx.runtime.traffic().getTrafficAlongRoute(rc.route, rc.alongNowM, toM);
  } catch (e) {
    return err("traffic_failed", `Traffic provider failed: ${(e as Error).message}`);
  }
  if (!report.available) return { content: { available: false, reason: report.reason }, isError: false };
  return {
    content: {
      available: true,
      source: report.source,
      updated: clockTime(new Date(report.updatedAt)),
      delays: report.delays.map((d) => ({
        ahead_km: km(Math.max(0, d.startAlongM - rc.alongNowM)),
        length_km: km(d.endAlongM - d.startAlongM),
        delay_min: r1(d.delayS / 60),
        severity: d.severity,
      })),
    },
    isError: false,
  };
}

async function findDestination(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const saved = strArg(input, "saved_place");
  const query = strArg(input, "query");
  const here = currentPosition(ctx);
  const withDistance = (loc: LatLon) => (here ? { distance_km: km(haversineMeters(here, loc)) } : {});
  if (saved) {
    const place = ctx.runtime.savedPlaces().find((p) => p.kind === saved);
    if (!place) return { content: { found: false, reason: `No "${saved}" place is saved in the app. Ask the driver for the address.` }, isError: false };
    const e = ctx.registry.registerPlace(`saved:${saved}`, { label: place.label, location: place.location });
    return { content: { found: true, candidates: [{ id: e.id, label: place.label, saved: saved, ...withDistance(place.location) }] }, isError: false };
  }
  if (!query) return err("bad_request", "Give saved_place or query.");
  const geocoder = ctx.runtime.geocoder();
  if (!geocoder) return err("geocoder_unavailable", "Address search is not available.");
  let results;
  try {
    results = await withTimeout(geocoder.search(query, { limit: 5 }), 8_000);
  } catch (e) {
    return err("geocoder_failed", `Address search failed: ${(e as Error).message}`);
  }
  const candidates = results.slice(0, 5).map((r) => {
    const e = ctx.registry.registerPlace(`geo:${r.location.lat.toFixed(5)},${r.location.lon.toFixed(5)}`, { label: r.label, location: r.location });
    return { id: e.id, label: r.label, source: r.source, ...withDistance(r.location) };
  });
  return { content: { found: candidates.length > 0, candidates }, isError: false };
}

async function checkLandmark(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position.");
  const filter = filterArg(input);
  if (!filter.nameVariants) return err("bad_request", "Give name_variants.");
  const places = ctx.runtime.places();
  let pois: POI[] = [];
  try {
    pois = places ? await places.searchAlongPolyline(rc.index.slice(Math.max(0, rc.alongNowM - 100), rc.alongNowM + 1500), 150, filter, 20) : [];
  } catch (e) {
    return err("place_search_failed", `Place search failed: ${(e as Error).message}`);
  }
  if (pois.length === 0) return { content: { result: "no_match", detail: "no matching place in map data near the route ahead" }, isError: false };
  const { state } = ctx.runtime.getNavigation();
  const query = pois[0]!.brand ?? pois[0]!.name;
  const result = new LandmarkEngine().identifyLandmarkQuery(pois, query, rc.route, rc.position, state.speedMps);
  const uncertain = positionUncertain(rc.band);
  if (result.kind === "confirmed") {
    // Where the next maneuver is relative to the landmark, so "after it, turn
    // right" is never said when the turn is kilometres further on.
    const { current, offsetInFirstM } = stepsAhead(rc);
    const toManeuverM = current.length > 1 ? (current[0]!.distanceM - offsetInFirstM) : null;
    const nextStep = current[1] ?? null;
    return {
      content: {
        result: uncertain ? "likely_but_position_uncertain" : "confirmed",
        name: result.landmark.name,
        ahead_m: Math.round(result.distanceM / 10) * 10,
        ...(nextStep && toManeuverM != null ? {
          next_maneuver: nextStep.maneuver,
          next_maneuver_road: nextStep.roadName || "unnamed road",
          next_maneuver_after_landmark_m: uncertain ? "withheld: position uncertain" : Math.max(0, Math.round((toManeuverM - result.distanceM) / 10) * 10),
        } : {}),
        evidence: "map data only (no camera confirmation)",
      },
      isError: false,
    };
  }
  return { content: { result: result.kind, ...(result.kind === "ambiguous" ? { candidates: result.candidateCount } : {}) }, isError: false };
}

// ---------- actions ----------

function actionKey(tool: string, input: Record<string, unknown>): string {
  const target = strArg(input, "place_id") ?? strArg(input, "route_id") ?? "";
  const extra = tool === "set_destination" && boolArg(input, "keep_stops") ? ":keep" : "";
  return `${tool}:${target}${extra}`;
}

async function rerouteWithPlan(ctx: ToolContext, from: LatLon): Promise<Route> {
  const route = await withTimeout(ctx.runtime.planner.route(from), 10_000);
  ctx.runtime.applyRoute(route);
  return route;
}

async function addStop(input: Record<string, unknown>, ctx: ToolContext, confirmed: boolean): Promise<ToolOutcome> {
  const id = strArg(input, "place_id");
  const e = id ? ctx.registry.get(id) : undefined;
  if (!e || e.kind !== "place") return err("unknown_place_id", `Unknown place id "${id ?? ""}". Use an id from a search result.`);
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route to add a stop to.");
  const plan = ctx.runtime.planner.getPlan();
  if (!plan.destination) return err("no_destination", "No destination is set in the trip plan.");
  if (plan.stops.some((s) => haversineMeters(s.location, e.location) < 30)) {
    return { content: { status: "already_a_stop", name: e.label }, isError: false };
  }

  if (!confirmed) {
    let addedMin: number | null = null;
    try {
      const baseline = await withTimeout(ctx.runtime.planner.route(rc.position), 8_000);
      const s = await withTimeout(routedDetourSeconds(ctx, rc, e, baseline.durationS), 8_000);
      if (s != null) addedMin = r1(s / 60);
    } catch { /* preview is best-effort; the action itself will reroute for real */ }
    const summary = `Додати зупинку: ${e.label}${addedMin != null ? ` (+${Math.round(addedMin)} хв)` : ""}`;
    return propose(ctx, "add_stop", input, summary, {
      name: e.label,
      ...(addedMin != null ? { added_min: addedMin, detour: "routed" } : { added_min: "unknown" }),
    });
  }

  const stop = ctx.runtime.planner.addStop(stopFromPlace(e), rc.route, ctx.runtime.now().getTime());
  try {
    const route = await rerouteWithPlan(ctx, rc.position);
    const newRemaining = route.durationS;
    return {
      content: {
        status: "done",
        stop_id: stop.id,
        name: e.label,
        remaining_min: minutes(newRemaining),
        added_min: r1((newRemaining - rc.remainingS) / 60),
        arrival: arrivalClock(ctx.runtime.now(), newRemaining),
      },
      isError: false,
      spoken: `Додала зупинку ${e.label}. Прибуття орієнтовно о ${arrivalClock(ctx.runtime.now(), newRemaining)}.`,
    };
  } catch (x) {
    ctx.runtime.planner.removeStop(stop.id);
    return err("routing_failed", `Could not build a route through ${e.label}: ${(x as Error).message}. The stop was not added.`);
  }
}

async function removeStop(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const id = strArg(input, "stop_id");
  const plan = ctx.runtime.planner.getPlan();
  const stop = plan.stops.find((s) => s.id === id);
  if (!stop) return err("unknown_stop_id", `No stop "${id ?? ""}" in the trip. Current stops: ${plan.stops.map((s) => `${s.id} ${s.label}`).join(", ") || "none"}.`);
  const pos = currentPosition(ctx);
  if (!pos) return err("no_position", "The current position is unknown.");
  ctx.runtime.planner.removeStop(stop.id);
  try {
    const route = await rerouteWithPlan(ctx, pos);
    return { content: { status: "done", removed: stop.label, remaining_min: minutes(route.durationS) }, isError: false, spoken: `Зупинку ${stop.label} прибрано.` };
  } catch (x) {
    ctx.runtime.planner.addStop({ label: stop.label, location: stop.location, ...(stop.category ? { category: stop.category } : {}) }, ctx.runtime.getNavigation().route);
    return err("routing_failed", `Rerouting failed: ${(x as Error).message}. The stop was kept.`);
  }
}

async function setDestination(input: Record<string, unknown>, ctx: ToolContext, confirmed: boolean): Promise<ToolOutcome> {
  const id = strArg(input, "place_id");
  const e = id ? ctx.registry.get(id) : undefined;
  if (!e || e.kind !== "place") return err("unknown_place_id", `Unknown place id "${id ?? ""}". Use an id from find_destination or a search.`);
  const pos = currentPosition(ctx);
  if (!pos) return err("no_position", "The current position is unknown.");
  if (!confirmed) {
    let preview: Record<string, unknown> = { distance_km_straight: km(haversineMeters(pos, e.location)) };
    try {
      const keep = boolArg(input, "keep_stops") ?? false;
      const r = await withTimeout(ctx.runtime.planner.route(pos, { destination: { label: e.label, location: e.location }, stops: keep ? ctx.runtime.planner.getPlan().stops : [] }), 8_000);
      preview = { route_km: km(r.distanceM), route_min: minutes(r.durationS), arrival: arrivalClock(ctx.runtime.now(), r.durationS) };
    } catch (x) {
      preview.route = `could not be computed: ${(x as Error).message}`;
    }
    return propose(ctx, "set_destination", input, `Новий пункт призначення: ${e.label}`, { name: e.label, ...preview });
  }
  const before = ctx.runtime.planner.getPlan();
  ctx.runtime.planner.setDestination({ label: e.label, location: e.location }, { keepStops: boolArg(input, "keep_stops") ?? false });
  try {
    const route = await rerouteWithPlan(ctx, pos);
    const arrival = arrivalClock(ctx.runtime.now(), route.durationS);
    return {
      content: { status: "done", destination: e.label, remaining_km: km(route.distanceM), remaining_min: minutes(route.durationS), arrival },
      isError: false,
      spoken: `Маршрут до ${e.label} побудовано. Прибуття орієнтовно о ${arrival}.`,
    };
  } catch (x) {
    if (before.destination) ctx.runtime.planner.setDestination(before.destination, { keepStops: false });
    for (const s of before.stops) ctx.runtime.planner.addStop(s, null);
    return err("routing_failed", `Could not build a route to ${e.label}: ${(x as Error).message}. The destination was not changed.`);
  }
}

async function setRoutePreferences(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const mapping: [string, keyof RoutePreferences][] = [
    ["avoid_unpaved", "avoidUnpaved"], ["avoid_tolls", "avoidTolls"], ["avoid_highways", "avoidHighways"], ["avoid_ferries", "avoidFerries"],
  ];
  const change: RoutePreferences = {};
  for (const [arg, key] of mapping) {
    const v = boolArg(input, arg);
    if (v !== undefined) change[key] = v;
  }
  if (Object.keys(change).length === 0) return err("bad_request", "No preference given.");
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route to apply preferences to.");
  if (!ctx.runtime.planner.getPlan().destination) return err("no_destination", "No destination is set in the trip plan.");
  const previous = ctx.runtime.planner.getPlan().preferences;
  ctx.runtime.planner.setPreferences(change);
  let route: Route;
  try {
    route = await withTimeout(ctx.runtime.planner.route(rc.position), 10_000);
  } catch (x) {
    ctx.runtime.planner.setPreferences(Object.fromEntries(mapping.map(([, k]) => [k, previous[k] ?? false])));
    return err("routing_failed", `Rerouting with the new preferences failed: ${(x as Error).message}. Preferences unchanged.`);
  }
  const unsupported = route.unsupportedPreferences ?? [];
  const requestedTrue = (Object.keys(change) as (keyof RoutePreferences)[]).filter((k) => change[k]);
  if (requestedTrue.length > 0 && requestedTrue.every((k) => unsupported.includes(k))) {
    // Nothing the driver asked for can be honoured: keep the current route and say so.
    ctx.runtime.planner.setPreferences(Object.fromEntries(mapping.map(([, k]) => [k, previous[k] ?? false])));
    return {
      content: { status: "not_supported", unsupported: requestedTrue, provider: route.source, detail: "the active routing provider has no road-attribute data for these preferences; route unchanged" },
      isError: false,
    };
  }
  ctx.runtime.applyRoute(route);
  return {
    content: {
      status: "done",
      applied: route.appliedPreferences ?? [],
      unsupported,
      remaining_min: minutes(route.durationS),
      delta_min: r1((route.durationS - rc.remainingS) / 60),
      remaining_km: km(route.distanceM),
    },
    isError: false,
  };
}

async function switchRoute(input: Record<string, unknown>, ctx: ToolContext, confirmed: boolean): Promise<ToolOutcome> {
  const id = strArg(input, "route_id");
  const e = id ? ctx.registry.get(id) : undefined;
  if (!e || e.kind !== "route") return err("unknown_route_id", `Unknown route id "${id ?? ""}". Use an id from compare_routes.`);
  const rc = buildRouteContext(ctx.runtime);
  const deltaMin = rc ? r1((e.route.durationS - rc.remainingS) / 60) : null;
  if (!confirmed) {
    const roads = mainRoads(e.route.steps, 2).map((r) => r.road).join(", ");
    return propose(ctx, "switch_route", input, `Перейти на маршрут через ${roads || "альтернативні дороги"}`, {
      minutes: minutes(e.route.durationS), ...(deltaMin != null ? { delta_min: deltaMin } : {}),
    });
  }
  ctx.runtime.applyRoute(e.route);
  return {
    content: { status: "done", remaining_min: minutes(e.route.durationS), ...(deltaMin != null ? { delta_min: deltaMin } : {}) },
    isError: false,
    spoken: "Переходжу на інший маршрут.",
  };
}

function propose(ctx: ToolContext, tool: string, input: Record<string, unknown>, summary: string, details: Record<string, unknown>): ToolOutcome {
  ctx.session.pending = {
    tool, input: { ...input }, key: actionKey(tool, input), proposedAtTurn: ctx.session.turn,
    createdAt: ctx.runtime.now().getTime(), summary,
  };
  return {
    content: { status: "awaiting_user_confirmation", ...details, instruction: "Ask the driver a short yes/no question. Call this tool again only after they agree." },
    isError: false,
  };
}

// ---------- dispatch ----------

export async function executeCopilotTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  opts: { confirmedByUi?: boolean } = {},
): Promise<ToolOutcome> {
  try {
    if (CONFIRMATION_REQUIRED_TOOLS.has(name)) {
      const key = actionKey(name, input);
      const pending = ctx.session.pending;
      // Confirmed = the driver tapped Confirm, or the model repeats the exact
      // proposed action in a LATER turn (i.e. after the driver replied).
      const confirmed = opts.confirmedByUi === true || (pending != null && pending.key === key && ctx.session.turn > pending.proposedAtTurn);
      if (confirmed) ctx.session.pending = null;
      switch (name) {
        case "add_stop": return await addStop(input, ctx, confirmed);
        case "set_destination": return await setDestination(input, ctx, confirmed);
        case "switch_route": return await switchRoute(input, ctx, confirmed);
      }
    }
    switch (name) {
      case "search_along_route": {
        const out = await searchAlongRoute(input, ctx);
        // A named place (a brand) with no match: offer the same category right
        // away, saving the driver a follow-up question and the model a round-trip.
        if (!out.isError && out.content.found_total === 0 && Array.isArray(input.name_variants) && Array.isArray(input.categories) && input.categories.length > 0) {
          const { name_variants: _omit, ...rest } = input;
          const alt = await searchAlongRoute({ ...rest, limit: 2 }, ctx);
          const altResults = !alt.isError ? (alt.content.results as unknown[]) : [];
          if (altResults.length > 0) out.content.no_name_match_same_category = altResults;
        }
        return out;
      }
      case "search_near": return await searchNear(input, ctx);
      case "get_route_overview": return routeOverview(ctx);
      case "compare_routes": return await compareRoutes(ctx);
      case "get_traffic_ahead": return await trafficAhead(input, ctx);
      case "find_destination": return await findDestination(input, ctx);
      case "check_landmark": return await checkLandmark(input, ctx);
      case "remove_stop": return await removeStop(input, ctx);
      case "set_route_preferences": return await setRoutePreferences(input, ctx);
      case "cancel_pending_action": {
        const had = ctx.session.pending;
        ctx.session.pending = null;
        return { content: { status: had ? "cancelled" : "nothing_pending" }, isError: false, spoken: "Добре, скасовано." };
      }
      default:
        return err("unknown_tool", `No tool named "${name}".`);
    }
  } catch (e) {
    return err("tool_failed", `${name} failed: ${(e as Error).message}`);
  }
}
