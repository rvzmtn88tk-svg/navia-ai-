// Real online routing — spec section 11's OnlineValhallaProvider,
// implementing @navia/core's RoutingProvider interface (route/match/
// searchAlternatives) so the UI depends only on that interface, never on
// Valhalla specifically (route-engine.ts's own header explains why only
// DemoRoutingProvider existed before this file). UNBUILT/UNTESTED — this
// sandbox's network cannot reach any Valhalla instance to actually call it
// (see LIMITATIONS.md); this is written against Valhalla's documented HTTP
// API (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/)
// but never executed here.
//
// Per the user's explicit instruction: on failure this THROWS — it never
// silently falls back to DemoRoutingProvider and calls the result real.
import type { LatLon, RouteStep, RoutingProvider, RouteRequest, Route, MapMatchResult, RoutePreferences, RoutePreferenceKey } from "@navia/core";
import { requestedPreferenceKeys } from "@navia/core";
import { config } from "../config";

// --- Google/Valhalla encoded-polyline decoding, precision 1e6 (Valhalla's default) ---
function decodePolyline6(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0, lat = 0, lon = 0;
  const factor = 1e6;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;
}

// Valhalla's Odin maneuver `type` enum, collapsed onto our simplified
// RouteStep maneuver union (depart/straight/left/right/uturn/roundabout/
// arrive) — an intentional simplification (Valhalla distinguishes "slight
// right" from "right" from "sharp right", say); good enough for the HUD
// text this feeds, not a source of navigational error since the actual
// distances/road names still come straight from Valhalla.
const VALHALLA_MANEUVER_TYPE: Record<number, RouteStep["maneuver"]> = {
  1: "depart", 2: "depart", 3: "depart",
  4: "arrive", 5: "arrive", 6: "arrive",
  7: "straight", 8: "straight", 17: "straight", 22: "straight", 25: "straight",
  9: "right", 10: "right", 11: "right", 18: "right", 20: "right", 23: "right",
  14: "left", 15: "left", 16: "left", 19: "left", 21: "left", 24: "left",
  12: "uturn", 13: "uturn",
  26: "roundabout", 27: "roundabout",
};

function mapManeuverType(type: number): RouteStep["maneuver"] {
  return VALHALLA_MANEUVER_TYPE[type] ?? "straight";
}

type ValhallaManeuver = {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number; // km (metric units requested below)
  time: number; // seconds
  begin_shape_index: number;
};

type ValhallaLeg = {
  shape: string;
  maneuvers: ValhallaManeuver[];
  summary: { length: number; time: number };
};

type ValhallaResponse = {
  trip?: { legs: ValhallaLeg[]; summary: { length: number; time: number } };
  alternates?: { trip: { legs: ValhallaLeg[]; summary: { length: number; time: number } } }[];
  error?: string; error_code?: number;
};

// Valhalla `auto` costing options (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/#automobile-and-bus-costing-options).
// use_* are 0..1 preference weights; 0 means "avoid as much as possible"
// (still usable when there is no other way), exclude_unpaved is a hard filter.
const SUPPORTED_PREFERENCES: RoutePreferenceKey[] = ["avoidHighways", "avoidTolls", "avoidUnpaved", "avoidFerries"];

function valhallaAutoCosting(prefs: RoutePreferences | undefined): Record<string, number | boolean> | null {
  if (!prefs) return null;
  const opts: Record<string, number | boolean> = {};
  if (prefs.avoidHighways) opts.use_highways = 0;
  if (prefs.avoidTolls) opts.use_tolls = 0;
  if (prefs.avoidFerries) opts.use_ferry = 0;
  if (prefs.avoidUnpaved) { opts.exclude_unpaved = true; opts.use_tracks = 0; }
  return Object.keys(opts).length > 0 ? opts : null;
}

export class OnlineValhallaProvider implements RoutingProvider {
  constructor(private baseUrl: string | null = config.valhallaUrl) {}

  private requireBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error(
        "OnlineValhallaProvider: no Valhalla endpoint configured (EXPO_PUBLIC_NAVIA_VALHALLA_URL is unset). " +
        "See apps/mobile/.env.example."
      );
    }
    return this.baseUrl;
  }

  private async callRoute(request: RouteRequest, alternates: number): Promise<ValhallaResponse> {
    const base = this.requireBaseUrl();
    const waypoints = request.waypoints ?? [];
    const costingOptions = valhallaAutoCosting(request.preferences);
    const body = {
      locations: [
        { lat: request.origin.lat, lon: request.origin.lon, type: "break" },
        // Intermediate stops are "break" locations: the driver actually stops
        // there, so Valhalla returns one leg per stop.
        ...waypoints.map((w) => ({ lat: w.lat, lon: w.lon, type: "break" })),
        { lat: request.destination.lat, lon: request.destination.lon, type: "break" },
      ],
      costing: "auto",
      ...(costingOptions ? { costing_options: { auto: costingOptions } } : {}),
      units: "kilometers",
      // Valhalla only computes alternates for two-location requests.
      ...(alternates > 0 && waypoints.length === 0 ? { alternates } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/$/, "")}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`OnlineValhallaProvider: network request failed (${(err as Error).message}). Endpoint: ${base}`);
    }

    const json = (await response.json().catch(() => null)) as ValhallaResponse | null;
    if (!response.ok || !json || json.error) {
      throw new Error(
        `OnlineValhallaProvider: routing failed (${response.status} ${response.statusText}` +
        (json?.error ? `, ${json.error}` : "") + `). Endpoint: ${base}`
      );
    }
    return json;
  }

  /** Concatenate every leg of a (possibly multi-stop) trip into one Route. */
  private tripToRoute(legs: ValhallaLeg[], tripSummary: { length: number; time: number }, id: string, request: RouteRequest): Route {
    const geometry: LatLon[] = [];
    const steps: RouteStep[] = [];
    legs.forEach((leg, li) => {
      const legGeometry = decodePolyline6(leg.shape);
      const offset = geometry.length > 0 ? geometry.length - 1 : 0;
      geometry.push(...(geometry.length > 0 ? legGeometry.slice(1) : legGeometry));
      for (const m of leg.maneuvers) {
        const maneuver = mapManeuverType(m.type);
        // Drop each intermediate leg's own "depart" (the car is already moving);
        // keep its "arrive" so the stop is announced.
        if (li > 0 && maneuver === "depart") continue;
        steps.push({
          id: `step-${steps.length}`,
          roadName: m.street_names?.[0] ?? "",
          maneuver,
          distanceM: m.length * 1000,
          durationS: m.time,
          location: geometry[offset + m.begin_shape_index] ?? geometry[0] ?? request.origin,
        });
      }
    });
    const requested = requestedPreferenceKeys(request.preferences);
    return {
      id,
      steps,
      geometry,
      distanceM: tripSummary.length * 1000,
      durationS: tripSummary.time,
      source: "online-valhalla",
      appliedPreferences: requested.filter((k) => SUPPORTED_PREFERENCES.includes(k)),
      unsupportedPreferences: requested.filter((k) => !SUPPORTED_PREFERENCES.includes(k)),
      waypointCount: request.waypoints?.length ?? 0,
    };
  }

  async route(request: RouteRequest): Promise<Route> {
    const json = await this.callRoute(request, 0);
    if (!json.trip) throw new Error("OnlineValhallaProvider: response had no trip");
    if (json.trip.legs.length === 0) throw new Error("OnlineValhallaProvider: response trip had no legs");
    return this.tripToRoute(json.trip.legs, json.trip.summary, `valhalla-${Date.now()}`, request);
  }

  async searchAlternatives(request: RouteRequest): Promise<Route[]> {
    const json = await this.callRoute(request, 2);
    const routes: Route[] = [];
    if (json.trip && json.trip.legs.length > 0) routes.push(this.tripToRoute(json.trip.legs, json.trip.summary, `valhalla-primary-${Date.now()}`, request));
    for (const [i, alt] of (json.alternates ?? []).entries()) {
      if (alt.trip.legs.length > 0) routes.push(this.tripToRoute(alt.trip.legs, alt.trip.summary, `valhalla-alt-${i}-${Date.now()}`, request));
    }
    return routes;
  }

  async match(points: LatLon[]): Promise<MapMatchResult> {
    const base = this.requireBaseUrl();
    const body = {
      shape: points.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: "auto",
      shape_match: "map_snap",
    };
    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/$/, "")}/trace_attributes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`OnlineValhallaProvider: map-match request failed (${(err as Error).message}). Endpoint: ${base}`);
    }
    const json = (await response.json().catch(() => null)) as { matched_points?: { lat: number; lon: number; edge_index?: number }[] } | null;
    if (!response.ok || !json) {
      throw new Error(`OnlineValhallaProvider: map-match failed (${response.status} ${response.statusText}). Endpoint: ${base}`);
    }
    const matched = json.matched_points ?? [];
    return {
      matchedPoints: matched.map((p) => ({ lat: p.lat, lon: p.lon })),
      roadSegmentIds: matched.map((p) => (p.edge_index != null ? String(p.edge_index) : null)),
    };
  }
}
