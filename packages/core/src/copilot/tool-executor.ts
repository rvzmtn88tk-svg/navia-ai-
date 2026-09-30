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
import { CONFIRMATION_REQUIRED_TOOLS, SEARCHABLE_CATEGORIES, TOOL_POLICY, type CopilotToolName } from "./tool-definitions";
import type { CopilotRuntime, CopilotSession, EntityRegistry, PlaceEntity } from "./runtime";
import { validatePreference } from "./preferences";
import { distinguish, featureCategories, locateByDescription, searchRadiusM, type DescribedObject, type LocateCandidate } from "../landmark-localizer";

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

function describeFilter(f: PlaceFilter): string {
  return [...(f.categories ?? []), ...(f.nameVariants ?? [])].join("/") || "places";
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
  // A detour limit the driver set as a lasting preference applies when the request names none.
  const prefDetour = ctx.runtime.preferences?.()?.get("max_detour_minutes");
  const detourArg = numArg(input, "max_detour_minutes", 0, 120) ?? (typeof prefDetour === "number" ? prefDetour : undefined);
  const maxDetourS = detourArg != null ? detourArg * 60 : null;
  const excluded = new Set(Array.isArray(input.exclude_place_ids) ? input.exclude_place_ids.filter((x): x is string => typeof x === "string") : []);
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
  const beyondId = strArg(input, "beyond_place_id");
  if (beyondId) {
    const b = ctx.registry.get(beyondId);
    if (!b || b.kind !== "place") return err("unknown_place_id", `Unknown place id "${beyondId}".`);
    const bp = rc.index.project(b.location, rc.alongNowM - 200);
    if (bp) { fromM = Math.max(fromM, bp.alongM + 30); toM = Math.max(toM, Math.min(rc.index.lengthM, fromM + 20_000)); }
  }
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
    if (excluded.size > 0 && excluded.has(registerPoi(ctx, poi).id)) continue;
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
  ctx.session.pushResults(`along route: ${describeFilter(filter)}`, results.map((r) => ({
    id: r.id,
    line: `${r.id} ${r.name} (${r.category}) ${r.ahead_km} km ahead, +${r.detour_min} min`,
  })));

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
      ...(numArg(input, "max_detour_minutes", 0, 120) == null && typeof prefDetour === "number" ? { applied_preference: `max_detour_minutes=${prefDetour} (driver's saved preference)` } : {}),
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
  const excludedNear = new Set(Array.isArray(input.exclude_place_ids) ? input.exclude_place_ids.filter((x): x is string => typeof x === "string") : []);
  const rows = raw
    .map((poi) => ({ poi, d: haversineMeters(center!, poi.location), open: openNowField(poi, now) }))
    .filter((x) => { if (openOnly && x.open === false) { closed++; return false; } return true; })
    .filter((x) => excludedNear.size === 0 || !excludedNear.has(registerPoi(ctx, x.poi).id))
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
  ctx.session.pushResults(`near ${anchorLabel}: ${describeFilter(filter)}`, results.map((r) => ({ id: r.id, line: `${r.id} ${r.name} (${r.category}) ${r.distance_m} m from ${anchorLabel}` })));
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
  ctx.session.pushResults("alternative routes", rows.map((r) => ({ id: r.id, line: `${r.id} ${r.minutes} min (${r.delta_min >= 0 ? "+" : ""}${r.delta_min} min vs active) via ${r.main_roads.map((m) => m.road).join(", ")}` })));
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
  ctx.session.pushResults(`destinations for "${query}"`, candidates.map((c) => ({ id: c.id, line: `${c.id} ${c.label}` })));
  return { content: { found: candidates.length > 0, candidates }, isError: false };
}

async function checkLandmark(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position.");
  // "Ahead of the estimate" means nothing when the estimate itself is uncertain.
  const mode = ctx.runtime.getNavigation().state.positionMode;
  if (mode === "DEAD_RECKONING" || mode === "MANUAL") return err("position_uncertain_use_locate", "GPS is not placing the car: use locate_by_description with what the driver sees instead.");
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

// ---------- localization by what the driver sees ----------

const LANDMARK_FIX_ACCURACY_M = 40;

/** The engine's estimate and its uncertainty, for searching where the car can be. */
function estimateFor(ctx: ToolContext): { location: LatLon; sigmaM: number; source: string } | null {
  const { state } = ctx.runtime.getNavigation();
  const p = state.position?.position ?? state.trustedPosition?.position ?? null;
  if (!p) {
    // No navigation-grade fix: the phone's own coarse position, with its real error.
    const a = ctx.runtime.approximatePosition?.();
    return a && a.ageS <= 120 ? { location: a.location, sigmaM: Math.max(a.accuracyM, 50), source: "approximate_gps" } : null;
  }
  const onGnss = state.positionMode === "GNSS" || (!state.positionMode && state.gnss === "NORMAL");
  const sigmaM = state.positionUncertaintyM ?? (onGnss ? p.accuracyM ?? 30 : 500);
  return { location: { lat: p.lat, lon: p.lon }, sigmaM: Math.max(sigmaM, onGnss ? 50 : 150), source: onGnss ? "gnss" : state.positionMode === "MANUAL" ? "manual" : "dead_reckoning" };
}

function describeCandidate(c: LocateCandidate): string {
  const seen = c.matched.map((m) => `${m.name ?? m.category}${m.object > 0 ? ` (${m.distanceM} m away)` : ""}`).join(" + ");
  return seen;
}

async function locateTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const objects = Array.isArray(input.objects) ? (input.objects as DescribedObject[]).slice(0, 3) : [];
  if (objects.length === 0) return err("bad_request", "Give at least one object.");
  const est = estimateFor(ctx);
  if (!est) return err("no_position_estimate", "NAVIA has no position estimate at all (no GPS fix yet and no manual start).");
  if (!ctx.runtime.mapFeatures) return err("map_data_unavailable", "No map data source is available on this device.");
  const { route } = ctx.runtime.getNavigation();
  const radius = searchRadiusM(est.sigmaM);
  let data: { features: import("../landmark-localizer").MapFeature[]; junctions: LatLon[] };
  try {
    data = await ctx.runtime.mapFeatures(est.location, Math.min(3000, radius * 1.5));
  } catch (e) {
    return err("map_data_unavailable", `Map data could not be loaded: ${(e as Error).message}`);
  }
  let r = locateByDescription({ objects, estimate: { location: est.location, sigmaM: est.sigmaM }, route: route?.geometry ?? null, features: data.features, junctions: data.junctions });
  // Trip memory: an answer to "which one?" narrows the earlier candidates — the
  // new description has to fit a place the previous one also fitted.
  const prev = ctx.session.lastLocate;
  let combined = false;
  if (prev && prev.status === "ambiguous" && ctx.runtime.now().getTime() - prev.at < 180_000 && r.candidates.length > 0) {
    const consistent = r.candidates.filter((c) => prev.candidates.some((p) => haversineMeters(p.location, c.location) <= 200));
    if (consistent.length > 0 && consistent.length < Math.max(2, r.candidates.length) || (consistent.length === 1 && r.status !== "unique")) {
      const renamed = consistent.map((c, i) => ({ ...c, id: `l${i + 1}` }));
      r = { ...r, status: renamed.length === 1 && renamed[0]!.contradictions.length === 0 ? "unique" : "ambiguous", candidates: renamed, hint: renamed.length > 1 ? distinguish(renamed) : null };
      combined = true;
    }
  }
  ctx.session.lastLocate = { at: ctx.runtime.now().getTime(), status: r.status, candidates: r.candidates.map((c) => ({ id: c.id, location: c.location, farFromEstimate: c.farFromEstimate, label: describeCandidate(c) })) };
  // The answer → action map is spelled out, so the driver's reply ("Харківська",
  // "справа") leads straight to confirm_position instead of another search.
  const then = (id: string) => `confirm_position ${id} driver_confirmed=true`;
  const hint = r.hint == null ? null
    : r.hint.kind === "side" ? { ask_about: "side_of_road", options: r.hint.options.map((o) => ({ ...o, if_driver_says_this: then(o.candidate) })) }
    : r.hint.kind === "name" ? { ask_about: "which_name", options: r.hint.options.map((o) => ({ ...o, if_driver_says_this: then(o.candidate) })) }
    : { ask_about: "is_there_nearby", category: r.hint.category, if_yes: r.hint.present_at.length === 1 ? then(r.hint.present_at[0]!) : "locate_by_description again with that object added", if_no: r.hint.absent_at.length === 1 ? then(r.hint.absent_at[0]!) : "locate_by_description again" };
  // One strong, nearby match re-localizes at once (spec §76) — the model does
  // not have to remember a second step; "no, I'm not there" undoes it.
  let autoFix: Record<string, unknown> | null = null;
  const top = r.candidates[0];
  if (r.status === "unique" && top && !top.farFromEstimate && est.source !== "gnss" && ctx.runtime.applyLandmarkFix) {
    const applied = ctx.runtime.applyLandmarkFix(top.location, LANDMARK_FIX_ACCURACY_M);
    if (applied.applied) {
      ctx.session.recordAction({
        at: ctx.runtime.now().getTime(), tool: "confirm_position", summary: `position set at ${describeCandidate(top)}`,
        undo: { tool: "undo_position_fix", input: {}, summary: "return to the previous position estimate" },
      });
      autoFix = { position_fixed: true, driver_is_now: `next to ${describeCandidate(top)}`, accuracy_m: LANDMARK_FIX_ACCURACY_M, ...(guidanceFrom(ctx, top.location) ?? {}), if_driver_says_wrong: "undo_position_fix" };
    }
  }
  const next = r.status === "unique"
    ? (autoFix ? "tell the driver where they are (driver_is_now, the place's name) and the next maneuver"
      : top!.farFromEstimate ? `ask the driver to confirm, then confirm_position ${top!.id} driver_confirmed=true`
      : `confirm_position ${top!.id} now (the driver is next to what they described), then give the next maneuver`)
    : r.status === "ambiguous" ? "ask the distinguishing_hint question; do not confirm yet"
    : r.status === "none" ? "say it is not found nearby on the map; ask for another visible thing (shop or fuel sign, bus stop, metro, street name); do not guess"
    : "the map has no such objects; ask about a shop, stop, metro or street name";
  return {
    content: {
      status: r.status,
      searched_radius_m: r.searchedRadiusM,
      position_estimate: { source: est.source, uncertainty_m: Math.round(est.sigmaM) },
      candidates: r.candidates.map((c) => ({
        id: c.id,
        seen: describeCandidate(c),
        distance_from_estimate_m: Math.round(c.distanceFromEstimateM / 10) * 10,
        on_route: c.onRoute,
        ...(c.side ? { side_of_road: c.side } : {}),
        ...(c.farFromEstimate ? { far_from_estimate: true } : {}),
        ...(c.missing.length ? { not_found: c.missing.map((i) => objects[i]?.name_variants?.[0] ?? objects[i]?.category ?? "object") } : {}),
        ...(c.contradictions.length ? { contradictions: c.contradictions } : {}),
        nearby: c.nearby.slice(0, 5).map((n) => (n.name ? `${n.name} (${n.category})` : n.category)),
      })),
      ...(hint ? { distinguishing_hint: hint } : {}),
      ...(r.unsupported.length ? { unsupported: r.unsupported, unsupported_note: "the map data has no such objects; ask about something else" } : {}),
      data_source: "OpenStreetMap map data",
      ...(combined ? { combined_with_previous_description: true } : {}),
      ...(autoFix ?? {}),
      next_step: next,
    },
    isError: false,
  };
}

/** Next maneuvers as seen from `position` on the active route. */
function guidanceFrom(ctx: ToolContext, position: LatLon): Record<string, unknown> | null {
  const { route, state } = ctx.runtime.getNavigation();
  if (!route || route.geometry.length < 2) return null;
  const { index, timeline } = indexFor(route);
  const alongNowM = index.project(position)?.alongM ?? 0;
  const rc: RouteContext = {
    route, index, timeline, position, alongNowM, secondsNow: timeline.secondsAt(alongNowM),
    remainingM: Math.max(0, index.lengthM - alongNowM), remainingS: Math.max(0, timeline.secondsAt(index.lengthM) - timeline.secondsAt(alongNowM)), band: state.confidenceBand,
  };
  const { current, offsetInFirstM } = stepsAhead(rc);
  const next = current[1] ?? null;
  if (!next) return { next_maneuver: "arrive", distance_m: Math.round(rc.remainingM / 10) * 10 };
  return {
    next_maneuver: next.maneuver,
    next_maneuver_road: next.roadName || "unnamed road",
    distance_m: Math.round(Math.max(0, current[0]!.distanceM - offsetInFirstM) / 10) * 10,
    distance_quality: `about ±${LANDMARK_FIX_ACCURACY_M} m (landmark fix)`,
    remaining_km: km(rc.remainingM),
  };
}

function confirmPositionTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const id = typeof input.candidate_id === "string" ? input.candidate_id : "";
  const last = ctx.session.lastLocate;
  const cand = last?.candidates.find((c) => c.id === id);
  if (!last || !cand) return err("unknown_candidate", "No such candidate: call locate_by_description first and use one of its ids.");
  const confirmed = input.driver_confirmed === true;
  if (last.status !== "unique" && !confirmed) return err("not_unique", "Several places match: ask the distinguishing question first; confirm only the place the driver then confirms.");
  if (cand.farFromEstimate && !confirmed) return err("far_from_estimate", "This place is far from where NAVIA estimates the car: ask the driver to confirm it first.");
  if (!ctx.runtime.applyLandmarkFix) return err("not_supported", "This navigation mode cannot take a landmark position.");
  const r = ctx.runtime.applyLandmarkFix(cand.location, LANDMARK_FIX_ACCURACY_M);
  if (!r.applied) {
    const why = r.reason === "gnss_is_trusted" ? "GPS is healthy and wins over a landmark; nothing changed."
      : r.reason === "off_route" ? `The place is ${r.offRouteM} m off the route: the driver has left the route; a new route from there is needed.`
      : r.reason === "no_route" ? "There is no active route." : "The navigator cannot take this position.";
    return err(r.reason ?? "not_applied", why);
  }
  ctx.session.recordAction({
    at: ctx.runtime.now().getTime(), tool: "confirm_position", summary: `position set at ${cand.label}`,
    undo: { tool: "undo_position_fix", input: {}, summary: "return to the previous position estimate" },
  });
  return {
    content: {
      status: "done", driver_is_now: `next to ${cand.label}`, accuracy_m: LANDMARK_FIX_ACCURACY_M, ...(guidanceFrom(ctx, cand.location) ?? {}),
      tell_driver: "where they are (driver_is_now, the place's name) and the next maneuver",
      if_driver_says_wrong: "undo_position_fix",
    },
    isError: false,
  };
}

function driverObservationTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  if (!ctx.runtime.applyDriverObservation) return err("not_supported", "This navigation mode takes no driver observations.");
  const kind = String(input.kind ?? "");
  const o = kind === "speed" ? { kind: "speed" as const, kmh: Number(input.speed_kmh) }
    : kind === "turned" ? { kind: "turned" as const, direction: (input.direction === "left" || input.direction === "around" ? input.direction : "right") as "left" | "right" | "around" }
    : kind === "stopped" || kind === "moving" || kind === "on_bridge" || kind === "in_tunnel" ? { kind } : null;
  if (!o) return err("bad_request", "Unknown observation kind.");
  const r = ctx.runtime.applyDriverObservation(o as never);
  if (r.applied) ctx.session.recordAction({ at: ctx.runtime.now().getTime(), tool: "report_driver_observation", summary: `driver: ${kind}`, undo: null });
  return { content: { status: r.applied ? "applied" : "not_applied", detail: r.detail }, isError: false };
}

function undoPositionFixTool(ctx: ToolContext): ToolOutcome {
  if (!ctx.runtime.undoLandmarkFix || !ctx.runtime.undoLandmarkFix()) return { content: { status: "nothing_to_undo" }, isError: false };
  return { content: { status: "undone", note: "back to the previous estimate; ask what the driver sees to locate again" }, isError: false, spoken: "Добре, повернуто попередню позицію." };
}

async function whereAmITool(ctx: ToolContext): Promise<ToolOutcome> {
  const est = estimateFor(ctx);
  const { state, route } = ctx.runtime.getNavigation();
  if (!est) return { content: { position: "unknown", gps: state.gnss, note: "no GPS fix yet and no estimate: ask the driver to wait a moment outdoors or describe what they see" }, isError: false };
  const [place, around] = await Promise.all([
    ctx.runtime.describePlace ? ctx.runtime.describePlace(est.location).catch(() => null) : Promise.resolve(null),
    ctx.runtime.mapFeatures ? ctx.runtime.mapFeatures(est.location, Math.max(150, Math.min(400, est.sigmaM))).catch(() => null) : Promise.resolve(null),
  ]);
  const nearby = (around?.features ?? [])
    .filter((f) => f.name && featureCategories(f).length > 0)
    .map((f) => ({ name: f.name!, kind: featureCategories(f)[0]!, d: haversineMeters(est.location, f.location) }))
    .sort((a, b) => a.d - b.d)
    .filter((x, i, arr) => arr.findIndex((y) => y.name === x.name) === i)
    .slice(0, 4)
    .map((x) => ({ name: x.name, kind: x.kind, distance_m: Math.round(x.d / 10) * 10 }));
  const rc = route ? buildRouteContext(ctx.runtime) : null;
  // With a wide error the street itself is only likely: the field names say so.
  const unsure = est.sigmaM > 60;
  return {
    content: {
      [unsure ? "probably_on_street" : "street"]: place?.street ?? "unknown",
      [unsure ? "probably_in_area" : "area"]: place?.area ?? "unknown",
      position_source: est.source,
      uncertainty_m: Math.round(est.sigmaM),
      ...(est.sigmaM > 60 ? { precision_note: `say "about" / "near": the position is known to ±${Math.round(est.sigmaM)} m` } : {}),
      gps: state.gnss,
      nearby,
      ...(route ? { on_route: !state.offRoute, ...(rc ? { remaining_km: km(rc.remainingM) } : {}) } : { on_route: "no active route" }),
      data_source: "OpenStreetMap (reverse geocoding + map data)",
    },
    isError: false,
  };
}

function safetyInfoTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  if (!ctx.runtime.safetyInfo) return err("safety_data_unavailable", "No air-alert or shelter data on this device.");
  const info = ctx.runtime.safetyInfo();
  const est = estimateFor(ctx);
  const limit = numArg(input, "limit", 1, 5) ?? 3;
  const now = ctx.runtime.now().getTime();
  const shelters = est
    ? info.shelters.map((s) => ({ s, d: haversineMeters(est.location, s.location) })).sort((a, b) => a.d - b.d).slice(0, limit)
    : [];
  const approximate = !!est && est.sigmaM > 60;
  return {
    content: {
      alert: info.alert ? {
        status: info.alert.active == null ? "unknown" : info.alert.active ? "active" : "none",
        area: info.alert.area,
        ...(info.alert.since ? { since_min: Math.max(0, Math.round((now - info.alert.since) / 60_000)) } : {}),
        source: info.alert.source,
        ...(info.alert.checkedAt ? { checked_min_ago: Math.max(0, Math.round((now - info.alert.checkedAt) / 60_000)) } : {}),
      } : "unavailable",
      shelters: shelters.map(({ s, d }) => {
        const e = ctx.registry.registerPlace(`shelter:${s.id}`, { label: s.name, location: s.location, category: "shelter" });
        return { id: e.id, name: s.name, kind: s.kind, distance_m: Math.round(d / 10) * 10, source: s.source };
      }),
      ...(est ? { position: { source: est.source, uncertainty_m: Math.round(est.sigmaM) }, ...(approximate ? { distance_note: `distances are from an estimate ±${Math.round(est.sigmaM)} m — say "about"` } : {}) } : { position: "unknown — no distances" }),
      ...(info.shelters.length === 0 ? { shelters_note: "no shelter data loaded for this area" } : {}),
      rule: "informational: never call a shelter or route safe",
    },
    isError: false,
  };
}

/** Categories that make recognisable visual landmarks from a car. */
const LANDMARK_CATEGORIES: LandmarkCategory[] = ["fuel", "supermarket", "shopping_centre", "pharmacy", "hospital", "fast_food", "restaurant", "cafe", "car_wash", "hotel"];

async function landmarksAhead(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const rc = buildRouteContext(ctx.runtime);
  if (!rc) return err("no_active_route", "There is no active route with a known position.");
  const places = ctx.runtime.places();
  if (!places) return err("place_search_unavailable", "No place database is available (no network place search and no offline POI index loaded).");
  const maxManeuvers = numArg(input, "maneuvers", 1, 5) ?? 3;
  const toM = Math.min(rc.index.lengthM, rc.alongNowM + (numArg(input, "ahead_max_km", 0.2, 50) ?? 5) * 1000);
  let raw: POI[];
  try {
    raw = await places.searchAlongPolyline(rc.index.slice(rc.alongNowM, toM), 80, { categories: LANDMARK_CATEGORIES }, 120);
  } catch (e) {
    return err("place_search_failed", `Place search failed: ${(e as Error).message}`);
  }
  const uncertain = positionUncertain(rc.band);
  const located = raw
    .map((poi) => ({ poi, proj: rc.index.project(poi.location, rc.alongNowM - 30) }))
    .filter((x): x is { poi: POI; proj: NonNullable<typeof x.proj> } => x.proj != null && x.proj.offsetM <= 60 && x.proj.alongM >= rc.alongNowM - 10);

  // Maneuver positions ahead (along-route distance of each step start).
  const maneuvers: { step: RouteStep; alongM: number }[] = [];
  let cum = 0;
  for (const step of rc.route.steps) {
    if (cum > rc.alongNowM + 5 && cum <= toM && step.maneuver !== "depart" && step.maneuver !== "straight") maneuvers.push({ step, alongM: cum });
    cum += step.distanceM;
    if (maneuvers.length >= maxManeuvers) break;
  }
  const used = new Set<string>();
  const byManeuver = maneuvers.map(({ step, alongM }) => {
    const near = located
      // Up to 250 m before the turn ("after Fora, turn right in 150 m") or 120 m after it.
      .filter((x) => x.proj.alongM - alongM >= -250 && x.proj.alongM - alongM <= 120)
      .sort((a, b) => Math.abs(a.proj.alongM - alongM) - Math.abs(b.proj.alongM - alongM))
      .slice(0, 3)
      .map((x) => {
        used.add(x.poi.id);
        const delta = x.proj.alongM - alongM;
        return {
          name: x.poi.name,
          category: x.poi.category,
          side: x.proj.side,
          relation: Math.abs(delta) <= 25 ? "at_the_turn" : delta < 0 ? "before_the_turn" : "after_the_turn",
          from_turn_m: Math.round(Math.abs(delta) / 10) * 10,
        };
      });
    return {
      maneuver: step.maneuver,
      road: step.roadName || "unnamed road",
      in_m: uncertain ? "withheld: position uncertain" : Math.round((alongM - rc.alongNowM) / 10) * 10,
      landmarks: near,
    };
  });
  const onTheWay = located
    .filter((x) => !used.has(x.poi.id))
    .sort((a, b) => a.proj.alongM - b.proj.alongM)
    .slice(0, 4)
    .map((x) => ({ name: x.poi.name, category: x.poi.category, side: x.proj.side, ahead_km: km(x.proj.alongM - rc.alongNowM) }));
  return {
    content: {
      source: places.source,
      ...(uncertain ? { position_uncertain: true } : {}),
      maneuvers: byManeuver,
      on_the_way: onTheWay,
      ...(byManeuver.every((m) => m.landmarks.length === 0) && onTheWay.length === 0 ? { note: "no named places near the route ahead in the map data" } : {}),
    },
    isError: false,
  };
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
    ctx.session.focus = { id: e.id, label: e.label };
    ctx.session.recordAction({
      at: ctx.runtime.now().getTime(), tool: "add_stop", summary: `added stop ${stop.id} "${e.label}"`,
      undo: { tool: "remove_stop", input: { stop_id: stop.id }, summary: `remove stop ${stop.id}` },
    });
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
      spoken: `Зупинку ${e.label} додано. Прибуття орієнтовно о ${arrivalClock(ctx.runtime.now(), newRemaining)}.`,
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
    const again = ctx.registry.registerPlace(`stop:${stop.label}:${stop.location.lat.toFixed(5)},${stop.location.lon.toFixed(5)}`, { label: stop.label, location: stop.location, ...(stop.category ? { category: stop.category } : {}) });
    // The driver already accepted this place once: putting it back ("no, return it") is an informed order.
    if (!ctx.session.presented.has(again.id)) ctx.session.presented.set(again.id, ctx.session.turn);
    ctx.session.recordAction({
      at: ctx.runtime.now().getTime(), tool: "remove_stop", summary: `removed stop "${stop.label}"`,
      undo: { tool: "add_stop", input: { place_id: again.id }, summary: `add ${again.id} "${stop.label}" back (needs confirmation)` },
    });
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
    const prev = before.destination
      ? ctx.registry.registerPlace(`dest:${before.destination.label}:${before.destination.location.lat.toFixed(5)},${before.destination.location.lon.toFixed(5)}`, { label: before.destination.label, location: before.destination.location })
      : null;
    ctx.session.focus = { id: e.id, label: e.label };
    ctx.session.recordAction({
      at: ctx.runtime.now().getTime(), tool: "set_destination", summary: `destination changed to "${e.label}"${prev ? ` (was "${prev.label}")` : ""}`,
      undo: prev ? { tool: "set_destination", input: { place_id: prev.id, keep_stops: true }, summary: `go back to ${prev.id} "${prev.label}" (needs confirmation)` } : null,
    });
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
  const undoInput = Object.fromEntries(mapping.filter(([, k]) => change[k] !== undefined).map(([arg, k]) => [arg, previous[k] ?? false]));
  ctx.session.recordAction({
    at: ctx.runtime.now().getTime(), tool: "set_route_preferences",
    summary: `route preferences: ${Object.entries(change).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    undo: { tool: "set_route_preferences", input: undoInput, summary: "restore previous road preferences" },
  });
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
  const previousRoute = ctx.runtime.getNavigation().route;
  ctx.runtime.applyRoute(e.route);
  const back = previousRoute ? ctx.registry.registerRoute(previousRoute) : null;
  ctx.session.recordAction({
    at: ctx.runtime.now().getTime(), tool: "switch_route", summary: `switched to route ${e.id}`,
    undo: back ? { tool: "switch_route", input: { route_id: back.id }, summary: `back to previous route ${back.id} (needs confirmation)` } : null,
  });
  return {
    content: { status: "done", remaining_min: minutes(e.route.durationS), ...(deltaMin != null ? { delta_min: deltaMin } : {}) },
    isError: false,
    spoken: "Переходжу на інший маршрут.",
  };
}

function propose(ctx: ToolContext, tool: string, input: Record<string, unknown>, summary: string, details: Record<string, unknown>): ToolOutcome {
  const key = actionKey(tool, input);
  const s = ctx.session;
  // A new proposal replaces proposals from earlier turns; proposals made in the
  // same turn form one plan ("coffee first, then home") confirmed together.
  s.pendingActions = s.pendingActions.filter((p) => p.proposedAtTurn === s.turn && p.key !== key);
  const { driver_confirmed_in_this_message: _flag, ...stored } = input;
  s.pendingActions.push({ tool, input: stored, key, proposedAtTurn: s.turn, createdAt: ctx.runtime.now().getTime(), summary });
  const id = strArg(input, "place_id");
  const ent = id ? ctx.registry.get(id) : undefined;
  if (ent && ent.kind === "place") s.focus = { id: ent.id, label: ent.label };
  return {
    content: {
      status: "awaiting_user_confirmation", ...details,
      ...(s.pendingActions.length > 1 ? { plan_so_far: s.pendingActions.map((p) => p.summary) } : {}),
      instruction: "Ask the driver one short yes/no question (covering the whole plan if several actions are pending). Call the action again only after they agree.",
    },
    isError: false,
  };
}

// ---------- details, reorder, reminders, preferences ----------

async function placeDetails(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const id = strArg(input, "place_id");
  const e = id ? ctx.registry.get(id) : undefined;
  if (!e || e.kind !== "place") return err("unknown_place_id", `Unknown place id "${id ?? ""}". Use an id from an earlier result.`);
  ctx.session.focus = { id: e.id, label: e.label };
  if (!ctx.session.presented.has(e.id)) ctx.session.presented.set(e.id, ctx.session.turn);
  const now = ctx.runtime.now();
  const out: Record<string, unknown> = { id: e.id, name: e.label };
  if (e.poi) {
    out.category = e.poi.category;
    if (e.poi.brand) out.brand = e.poi.brand;
    if (e.poi.cuisine) out.cuisine = e.poi.cuisine;
    if (e.poi.openingHours) out.opening_hours = e.poi.openingHours;
    out.open_now = openNowField(e.poi, now);
  }
  const pos = currentPosition(ctx);
  if (pos) out.straight_line_km_from_car = km(haversineMeters(pos, e.location));
  const dest = ctx.runtime.planner.getPlan().destination;
  if (dest) out.straight_line_km_from_destination = km(haversineMeters(dest.location, e.location));
  out.is_stop = ctx.runtime.planner.getPlan().stops.some((st) => haversineMeters(st.location, e.location) < 30);
  const rc = buildRouteContext(ctx.runtime);
  if (rc) {
    const proj = rc.index.project(e.location, rc.alongNowM - 200);
    if (proj && proj.alongM >= rc.alongNowM - 30) {
      out.ahead_km = km(Math.max(0, proj.alongM - rc.alongNowM));
      out.ahead_min = minutes(Math.max(0, rc.timeline.secondsAt(proj.alongM) - rc.secondsNow));
      out.side = proj.side;
      out.distance_from_route_m = r0(proj.offsetM);
    } else {
      out.position = "behind the car or not along the active route";
    }
    if (!out.is_stop && dest) {
      try {
        const baseline = await withTimeout(ctx.runtime.planner.route(rc.position), 8_000);
        const s = await withTimeout(routedDetourSeconds(ctx, rc, e, baseline.durationS), 8_000);
        if (s != null) { out.added_min_if_stopping = r1(s / 60); out.detour = "routed"; }
        else if (proj) { out.added_min_if_stopping = r1(estimateDetourSeconds(proj.offsetM) / 60); out.detour = "estimated"; }
      } catch (x) {
        out.added_min_if_stopping = "unknown";
        out.note = `routing unavailable: ${(x as Error).message}`;
      }
    }
    if (positionUncertain(rc.band)) out.position_uncertain = true;
  }
  return { content: out, isError: false };
}

async function reorderStops(input: Record<string, unknown>, ctx: ToolContext, confirmed: boolean): Promise<ToolOutcome> {
  const ids = Array.isArray(input.stop_ids) ? input.stop_ids.filter((x): x is string => typeof x === "string") : [];
  const plan = ctx.runtime.planner.getPlan();
  const current = plan.stops.map((st) => st.id);
  if (ids.length !== current.length || !ids.every((id) => current.includes(id)) || new Set(ids).size !== ids.length) {
    return err("bad_request", `Give every stop id exactly once. Current stops in order: ${plan.stops.map((st) => `${st.id} ${st.label}`).join(", ") || "none"}.`);
  }
  const pos = currentPosition(ctx);
  if (!pos) return err("no_position", "The current position is unknown.");
  const ordered = ids.map((id) => plan.stops.find((st) => st.id === id)!);
  if (!confirmed) {
    let preview: Record<string, unknown> = {};
    try {
      const r = await withTimeout(ctx.runtime.planner.route(pos, { stops: ordered }), 8_000);
      preview = { remaining_min: minutes(r.durationS), arrival: arrivalClock(ctx.runtime.now(), r.durationS) };
    } catch (x) { preview = { route: `could not be computed: ${(x as Error).message}` }; }
    return propose(ctx, "reorder_stops", input, `Змінити порядок зупинок: ${ordered.map((st) => st.label).join(" → ")}`, { order: ordered.map((st) => st.label), ...preview });
  }
  ctx.runtime.planner.restore({ ...plan, stops: ordered });
  try {
    const route = await rerouteWithPlan(ctx, pos);
    ctx.session.recordAction({
      at: ctx.runtime.now().getTime(), tool: "reorder_stops", summary: `stop order: ${ordered.map((st) => st.label).join(" → ")}`,
      undo: { tool: "reorder_stops", input: { stop_ids: current }, summary: "restore previous stop order (needs confirmation)" },
    });
    return { content: { status: "done", order: ordered.map((st) => st.label), remaining_min: minutes(route.durationS) }, isError: false, spoken: "Порядок зупинок змінено." };
  } catch (x) {
    ctx.runtime.planner.restore(plan);
    return err("routing_failed", `Rerouting failed: ${(x as Error).message}. Order unchanged.`);
  }
}

function setReminder(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const topic = strArg(input, "topic");
  if (!topic) return err("bad_request", "Give a topic.");
  const afterMin = numArg(input, "after_minutes", 1, 600);
  const afterKm = numArg(input, "after_km", 0.5, 2000);
  if (afterMin == null && afterKm == null) return err("bad_request", "Give after_minutes or after_km.");
  const now = ctx.runtime.now().getTime();
  let dueAtAlongM: number | null = null;
  if (afterKm != null) {
    const rc = buildRouteContext(ctx.runtime);
    if (!rc) return err("no_active_route", "after_km needs an active route; use after_minutes.");
    dueAtAlongM = rc.alongNowM + afterKm * 1000;
  }
  const cats = filterArg(input).categories ?? [];
  const r = ctx.session.addReminder({ topic, categories: cats, dueAtMs: afterMin != null ? now + afterMin * 60_000 : null, dueAtAlongM, createdAt: now });
  ctx.session.recordAction({ at: now, tool: "set_reminder", summary: `reminder ${r.id} "${topic}"`, undo: { tool: "cancel_reminder", input: { reminder_id: r.id }, summary: `cancel reminder ${r.id}` } });
  return {
    content: { status: "done", reminder_id: r.id, topic, ...(afterMin != null ? { due_at: clockTime(new Date(now + afterMin * 60_000)) } : {}), ...(afterKm != null ? { due_after_km: afterKm } : {}) },
    isError: false,
  };
}

function cancelReminder(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const id = strArg(input, "reminder_id");
  const i = ctx.session.reminders.findIndex((r) => r.id === id);
  if (i < 0) return err("unknown_reminder_id", `No reminder "${id ?? ""}". Current: ${ctx.session.reminders.map((r) => `${r.id} ${r.topic}`).join(", ") || "none"}.`);
  const [r] = ctx.session.reminders.splice(i, 1);
  return { content: { status: "done", cancelled: r!.topic }, isError: false };
}

function rememberPreference(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const store = ctx.runtime.preferences?.();
  if (!store) return err("preferences_unavailable", "This app build does not keep long-term preferences.");
  const words = strArg(input, "driver_words");
  if (!words) return err("bad_request", "driver_words is required: quote what the driver said.");
  const v = validatePreference(strArg(input, "key") ?? "", input.value);
  if (!v.ok) return err("bad_request", v.message);
  const prev = store.set(v.key, v.value, words, ctx.runtime.now().getTime());
  ctx.session.recordAction({
    at: ctx.runtime.now().getTime(), tool: "remember_preference", summary: `saved preference ${v.key}`,
    undo: prev ? { tool: "remember_preference", input: { key: v.key, value: prev.value, driver_words: prev.driverWords }, summary: `restore previous ${v.key}` } : { tool: "forget_preference", input: { key: v.key }, summary: `forget ${v.key}` },
  });
  return { content: { status: "done", key: v.key, value: v.value }, isError: false };
}

function forgetPreference(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const store = ctx.runtime.preferences?.();
  if (!store) return err("preferences_unavailable", "This app build does not keep long-term preferences.");
  const key = strArg(input, "key") ?? "";
  const v = validatePreference(key, "x");
  const known = v.ok || !/Unknown preference/.test(v.message);
  if (!known) return err("bad_request", v.ok ? "" : v.message);
  const prev = store.remove(key as never);
  return { content: { status: prev ? "done" : "not_set", key }, isError: false };
}

// Short-lived cache for read tools: the same question twice in a row (or the
// model re-checking) doesn't hit the network again. Keyed by tool, input and
// the car's position rounded to ~150 m; 60 s lifetime.
const CACHEABLE = new Set(["search_along_route", "search_near", "get_landmarks_ahead"]);
const toolCache = new WeakMap<CopilotSession, Map<string, { at: number; outcome: ToolOutcome }>>();
function cacheKey(name: string, input: Record<string, unknown>, ctx: ToolContext): string | null {
  if (!CACHEABLE.has(name)) return null;
  const p = currentPosition(ctx);
  const route = ctx.runtime.getNavigation().route;
  const cell = p ? `${Math.round(p.lat * 750)}:${Math.round(p.lon * 480)}` : "nopos";
  return `${name}|${JSON.stringify(input)}|${cell}|${route?.id ?? ""}|${ctx.runtime.planner.getPlan().stops.length}`;
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
      const match = ctx.session.pendingActions.find((p) => p.key === key);
      // Confirmed = the driver tapped Confirm, or the model repeats the exact
      // proposed action in a LATER turn (i.e. after the driver replied).
      // …or the driver, having heard this target's impact in an earlier answer,
      // now orders exactly this action ("the second one is fine — add it").
      const target = strArg(input, "place_id") ?? strArg(input, "route_id");
      const heardAt = target ? ctx.session.presented.get(target) : undefined;
      const orderedNow = input.driver_confirmed_in_this_message === true && heardAt != null && heardAt < ctx.session.turn;
      const confirmed = opts.confirmedByUi === true || orderedNow || (match != null && ctx.session.turn > match.proposedAtTurn);
      if (confirmed) ctx.session.pendingActions = ctx.session.pendingActions.filter((p) => p.key !== key);
      switch (name) {
        case "add_stop": return await addStop(input, ctx, confirmed);
        case "set_destination": return await setDestination(input, ctx, confirmed);
        case "switch_route": return await switchRoute(input, ctx, confirmed);
        case "reorder_stops": return await reorderStops(input, ctx, confirmed);
      }
    }
    if (!(name in TOOL_POLICY)) return err("unknown_tool", `No tool named "${name}".`);
    const ck = cacheKey(name, input, ctx);
    if (ck) {
      const cache = toolCache.get(ctx.session) ?? new Map();
      toolCache.set(ctx.session, cache);
      const hit = cache.get(ck);
      const nowMs = ctx.runtime.now().getTime();
      if (hit && nowMs - hit.at < 60_000) {
        // Re-publish the list so "the second one" still refers to what the driver just heard.
        if (Array.isArray(hit.outcome.content.results)) {
          const items = (hit.outcome.content.results as { id: string; name: string }[]).map((r) => ({ id: r.id, line: `${r.id} ${r.name}` }));
          ctx.session.pushResults(`${name} (cached)`, items);
        }
        return { ...hit.outcome, content: { ...hit.outcome.content, cached: true } };
      }
      const out = await dispatchRead(name as CopilotToolName, input, ctx);
      if (!out.isError) cache.set(ck, { at: nowMs, outcome: out });
      if (cache.size > 30) cache.delete(cache.keys().next().value as string);
      return out;
    }
    return await dispatchRead(name as CopilotToolName, input, ctx);
  } catch (e) {
    return err("tool_failed", `${name} failed: ${(e as Error).message}`);
  }
}

async function dispatchRead(name: CopilotToolName, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  {
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
      case "get_place_details": return await placeDetails(input, ctx);
      case "set_reminder": return setReminder(input, ctx);
      case "cancel_reminder": return cancelReminder(input, ctx);
      case "remember_preference": return rememberPreference(input, ctx);
      case "forget_preference": return forgetPreference(input, ctx);
      case "get_route_overview": return routeOverview(ctx);
      case "compare_routes": return await compareRoutes(ctx);
      case "get_traffic_ahead": return await trafficAhead(input, ctx);
      case "find_destination": return await findDestination(input, ctx);
      case "check_landmark": return await checkLandmark(input, ctx);
      case "get_landmarks_ahead": return await landmarksAhead(input, ctx);
      case "locate_by_description": return await locateTool(input, ctx);
      case "confirm_position": return confirmPositionTool(input, ctx);
      case "undo_position_fix": return undoPositionFixTool(ctx);
      case "report_driver_observation": return driverObservationTool(input, ctx);
      case "get_safety_info": return safetyInfoTool(input, ctx);
      case "where_am_i": return await whereAmITool(ctx);
      case "remove_stop": return await removeStop(input, ctx);
      case "set_route_preferences": return await setRoutePreferences(input, ctx);
      case "cancel_pending_action": {
        const had = ctx.session.pendingActions.length;
        ctx.session.pendingActions = [];
        return { content: { status: had ? "cancelled" : "nothing_pending", ...(had > 1 ? { cancelled_actions: had } : {}) }, isError: false, spoken: "Добре, скасовано." };
      }
      default:
        return err("unknown_tool", `No tool named "${name}".`);
    }
  }
}
