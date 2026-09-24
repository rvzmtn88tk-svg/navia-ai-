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
import type { LatLon, RouteStep, RoutingProvider, RouteRequest, Route, MapMatchResult } from "@navia/core";
import { config } from "../config";

const REQUEST_TIMEOUT_MS = 15_000;

function isValidPoint(point: LatLon): boolean {
  return Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90
    && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180;
}

function distanceMeters(a: LatLon, b: LatLon): number {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Google/Valhalla encoded-polyline decoding, precision 1e6 (Valhalla's default) ---
function decodePolyline6(encoded: string): LatLon[] {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 2_000_000) {
    throw new Error("OnlineValhallaProvider: route geometry is empty or too large");
  }
  const points: LatLon[] = [];
  let index = 0, lat = 0, lon = 0;
  const factor = 1e6;
  const readDelta = () => {
    let result = 0, shift = 0, byte = 0;
    do {
      if (index >= encoded.length || shift > 30) throw new Error("OnlineValhallaProvider: malformed encoded route geometry");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error("OnlineValhallaProvider: malformed encoded route geometry");
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += readDelta();
    lon += readDelta();
    points.push({ lat: lat / factor, lon: lon / factor });
  }
  if (points.some((point) => !isValidPoint(point))) throw new Error("OnlineValhallaProvider: decoded route has invalid coordinates");
  return points;
}

// Valhalla's Odin maneuver `type` enum mapped onto RouteStep maneuvers.
// Types 26/27 are roundabout enter/exit; the enter maneuver carries the exit
// count, the exit maneuver is folded into "straight".
const VALHALLA_MANEUVER_TYPE: Record<number, RouteStep["maneuver"]> = {
  1: "depart", 2: "depart", 3: "depart",
  4: "arrive", 5: "arrive", 6: "arrive",
  7: "straight", 8: "straight", 17: "straight", 22: "straight", 27: "straight",
  9: "slight_right", 10: "right", 11: "sharp_right",
  16: "slight_left", 15: "left", 14: "sharp_left",
  12: "uturn", 13: "uturn",
  18: "exit_right", 20: "exit_right", 19: "exit_left", 21: "exit_left",
  23: "slight_right", 24: "slight_left",
  25: "merge", 37: "merge", 38: "merge",
  26: "roundabout",
};

export function mapManeuverType(type: number): RouteStep["maneuver"] {
  return VALHALLA_MANEUVER_TYPE[type] ?? "straight";
}

type ValhallaManeuver = {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number; // km (metric units requested below)
  time: number; // seconds
  begin_shape_index: number;
  roundabout_exit_count?: number;
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
    if (!isValidPoint(request.origin) || !isValidPoint(request.destination)) {
      throw new Error("OnlineValhallaProvider: origin and destination must be valid latitude/longitude coordinates.");
    }
    const body = {
      locations: [
        { lat: request.origin.lat, lon: request.origin.lon },
        { lat: request.destination.lat, lon: request.destination.lon },
      ],
      costing: request.mode === "walk" ? "pedestrian" : "auto",
      units: "kilometers",
      language: "uk-UA",
      ...(alternates > 0 ? { alternates } : {}),
    };

    let response: Response;
    let json: ValhallaResponse | null;
    try {
      const result = await fetchJsonWithTimeout(`${base.replace(/\/$/, "")}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Id": "NAVIA" },
        body: JSON.stringify(body),
      });
      response = result.response;
      json = result.body as ValhallaResponse | null;
    } catch (err) {
      throw new Error(`OnlineValhallaProvider: network request failed (${(err as Error).message}). Endpoint: ${base}`);
    }

    if (!response.ok || !json || json.error) {
      throw new Error(
        `OnlineValhallaProvider: routing failed (${response.status} ${response.statusText}` +
        (json?.error ? `, ${json.error}` : "") + `). Endpoint: ${base}`
      );
    }
    return json;
  }

  private legToRoute(leg: ValhallaLeg, tripSummary: { length: number; time: number }, id: string): Route {
    if (!leg || typeof leg.shape !== "string" || !Array.isArray(leg.maneuvers) || leg.maneuvers.length === 0
      || !Number.isFinite(tripSummary?.length) || tripSummary.length <= 0
      || !Number.isFinite(tripSummary?.time) || tripSummary.time < 0) {
      throw new Error("OnlineValhallaProvider: route response is missing valid geometry, maneuvers, distance or duration.");
    }
    const geometry = decodePolyline6(leg.shape);
    if (geometry.length < 2) throw new Error("OnlineValhallaProvider: route geometry needs at least two points.");
    const steps: RouteStep[] = leg.maneuvers.map((maneuver, i) => {
      const index = maneuver.begin_shape_index;
      if (!Number.isInteger(index) || index < 0 || index >= geometry.length
        || !Number.isFinite(maneuver.length) || maneuver.length < 0
        || !Number.isFinite(maneuver.time) || maneuver.time < 0
        || !Number.isFinite(maneuver.type)) {
        throw new Error(`OnlineValhallaProvider: maneuver ${i} is invalid or points outside route geometry.`);
      }
      return {
        id: `step-${i}`,
        roadName: maneuver.street_names?.[0] ?? "",
        maneuver: mapManeuverType(maneuver.type),
        ...(maneuver.type === 26 && Number.isInteger(maneuver.roundabout_exit_count) && (maneuver.roundabout_exit_count ?? 0) > 0 ? { roundaboutExit: maneuver.roundabout_exit_count } : {}),
        distanceM: maneuver.length * 1000,
        durationS: maneuver.time,
        location: geometry[index]!,
      };
    });
    return {
      id,
      steps,
      geometry,
      distanceM: tripSummary.length * 1000,
      durationS: tripSummary.time,
      source: "online-valhalla",
    };
  }

  async route(request: RouteRequest): Promise<Route> {
    const json = await this.callRoute(request, 0);
    if (!json.trip || !Array.isArray(json.trip.legs)) throw new Error("OnlineValhallaProvider: response had no valid trip legs");
    // A single-leg trip is the common case for a two-point request.
    const leg = json.trip.legs[0];
    if (!leg) throw new Error("OnlineValhallaProvider: response trip had no legs");
    const route = this.legToRoute(leg, json.trip.summary, `valhalla-${Date.now()}`);
    if (distanceMeters(request.origin, route.geometry[0]!) > 1_500 || distanceMeters(request.destination, route.geometry[route.geometry.length - 1]!) > 1_500) {
      throw new Error("OnlineValhallaProvider: route geometry does not lead from the requested start to destination.");
    }
    return route;
  }

  async searchAlternatives(request: RouteRequest): Promise<Route[]> {
    const json = await this.callRoute(request, 2);
    const routes: Route[] = [];
    if (json.trip && Array.isArray(json.trip.legs) && json.trip.legs[0]) {
      routes.push(this.legToRoute(json.trip.legs[0], json.trip.summary, "valhalla-primary"));
    }
    for (const [i, alt] of (json.alternates ?? []).entries()) {
      const leg = alt?.trip?.legs?.[0];
      if (leg) routes.push(this.legToRoute(leg, alt.trip.summary, `valhalla-alt-${i}`));
    }
    return routes;
  }

  async match(points: LatLon[]): Promise<MapMatchResult> {
    const base = this.requireBaseUrl();
    if (points.length < 2 || points.length > 10_000 || points.some((point) => !isValidPoint(point))) {
      throw new Error("OnlineValhallaProvider: map matching requires 2–10,000 valid coordinates.");
    }
    const body = {
      shape: points.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: "auto",
      shape_match: "map_snap",
    };
    let response: Response;
    let json: { matched_points?: { lat: number; lon: number; edge_index?: number }[] } | null;
    try {
      const result = await fetchJsonWithTimeout(`${base.replace(/\/$/, "")}/trace_attributes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      response = result.response;
      json = result.body as typeof json;
    } catch (err) {
      throw new Error(`OnlineValhallaProvider: map-match request failed (${(err as Error).message}). Endpoint: ${base}`);
    }
    if (!response.ok || !json) {
      throw new Error(`OnlineValhallaProvider: map-match failed (${response.status} ${response.statusText}). Endpoint: ${base}`);
    }
    const matched = json.matched_points ?? [];
    if (!Array.isArray(matched) || matched.some((point) => !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90 || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180)) {
      throw new Error("OnlineValhallaProvider: map-match response contains invalid coordinates.");
    }
    return {
      matchedPoints: matched.map((p) => ({ lat: p.lat, lon: p.lon })),
      roadSegmentIds: matched.map((p) => (p.edge_index != null ? String(p.edge_index) : null)),
    };
  }
}
