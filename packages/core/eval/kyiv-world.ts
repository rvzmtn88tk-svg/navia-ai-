// A copilot on REAL recorded Kyiv data for live dialogue checks: OSM features
// and junctions from the map tiles, a real Valhalla route along Mykoly Bazhana
// Ave, real reverse geocoding along it and the official KMDA shelters
// (test/fixtures/*.json, each with its source block). The engine is the app's
// NavigationEngine; GPS healthy, lost (route dead reckoning) or approximate.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NaviaCopilot } from "../src/copilot/copilot";
import { EngineCopilotRuntime, type SafetyInfo } from "../src/copilot/runtime";
import { BackendLLMClient } from "../src/copilot/backend-client";
import { TripPlanner } from "../src/trip-planner";
import { NavigationEngine } from "../src/navigation-engine";
import { LocalPlaceSearchProvider } from "../src/place-search";
import { haversineMeters, destinationPoint, initialBearing } from "../src/geodesy";
import type { Route, RoutingProvider } from "../src/route-engine";
import type { MapFeature } from "../src/landmark-localizer";
import type { POI, LandmarkCategory } from "../src/landmark-engine";
import type { LatLon } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
export type Fx = { features: MapFeature[]; junctions: LatLon[]; routes: { route: Route }[] };
export const loadFx = (n: string): Fx => JSON.parse(readFileSync(join(here, "..", "test", "fixtures", `osm-${n}.json`), "utf8"));
const CONTEXT = JSON.parse(readFileSync(join(here, "..", "test", "fixtures", "kyiv-bazhana-context.json"), "utf8")) as {
  reverse: { at: LatLon; street: string | null; area: string | null }[];
  shelters: { id: string; name: string; address: string | null; location: LatLon; kind: string; source: string }[];
};

export function along(route: Route, m: number): LatLon {
  let acc = 0; const g = route.geometry;
  for (let i = 1; i < g.length; i++) { const seg = haversineMeters(g[i - 1]!, g[i]!); if (acc + seg >= m) return destinationPoint(g[i - 1]!, initialBearing(g[i - 1]!, g[i]!), m - acc); acc += seg; }
  return g[g.length - 1]!;
}
const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("offline")), match: () => Promise.reject(new Error("offline")), searchAlternatives: () => Promise.reject(new Error("offline")) };

/** Map-tile classes → the co-pilot's place categories (same mapping as the app's tile search). */
function poiCategory(f: MapFeature): LandmarkCategory | null {
  if (f.cls === "fuel") return f.sub === "charging_station" ? "ev_charging" : "fuel";
  if (f.cls === "pharmacy" || f.sub === "chemist") return "pharmacy";
  if (f.cls === "restaurant") return "restaurant";
  if (f.cls === "cafe") return "cafe";
  if (f.cls === "fast_food") return "fast_food";
  if (f.sub === "supermarket") return "supermarket";
  if (f.cls === "atm" || f.cls === "bank") return "atm";
  if (f.cls === "hospital") return "hospital";
  return null;
}

export type WorldOpts = { fx: Fx; atM: number; lostS?: number; approxAccuracyM?: number; alert?: SafetyInfo["alert"] };

export function kyivCopilot(o: WorldOpts): NaviaCopilot {
  const route = o.fx.routes[0]!.route;
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(route);
  let seed = 11;
  const vib = (a: number) => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * a; };
  const imu = (t: number) => { for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.6), accelY: vib(0.6), accelZ: -9.81 + vib(0.8), gyroX: vib(0.02), gyroY: vib(0.02), gyroZ: vib(0.02) }); };
  const lostS = o.lostS ?? 0;
  let t = Date.now() - (lostS + 40) * 1000;
  const lostAt = o.atM - lostS * 12;
  if (o.approxAccuracyM == null) {
    for (let m = Math.max(0, lostAt - 360); m <= lostAt; m += 12, t += 1000) {
      const p = along(route, m);
      engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 12, headingDeg: null }, t);
      imu(t); engine.tick(t);
    }
    for (let i = 0; i < lostS; i++, t += 1000) { imu(t); engine.tick(t); }
  } else {
    // Coarse fixes keep arriving (indoors, no known Wi-Fi): GPS "unstable", nothing navigation-grade.
    for (let i = 0; i < 20; i++, t += 1000) {
      const p = along(route, o.atM);
      engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: o.approxAccuracyM, speedMps: null, headingDeg: null }, t);
      engine.tick(t);
    }
  }
  const now = t;
  const pos = along(route, o.atM);
  const pois: POI[] = o.fx.features.flatMap((f) => { const c = poiCategory(f); return c && f.name ? [{ id: f.id, name: f.name, category: c, location: f.location, source: "osm-online" as const }] : []; });
  const runtime = new EngineCopilotRuntime({
    host: engine, planner: new TripPlanner(noRouting), now: () => new Date(now),
    places: new LocalPlaceSearchProvider(pois, "osm-online"),
    mapFeatures: async (c, r) => ({ features: o.fx.features.filter((f) => haversineMeters(c, f.location) <= r), junctions: o.fx.junctions.filter((j) => haversineMeters(c, j) <= r) }),
    describePlace: async (p) => {
      const best = CONTEXT.reverse.map((x) => ({ x, d: haversineMeters(p, x.at) })).sort((a, b) => a.d - b.d)[0];
      return best && best.d <= 300 ? { street: best.x.street, area: best.x.area } : null;
    },
    safetyInfo: () => ({ alert: o.alert ?? null, shelters: CONTEXT.shelters.map((s) => ({ id: s.id, name: s.address ? `${s.name}, ${s.address}` : s.name, location: s.location, kind: s.kind, source: s.source })) }),
    ...(o.approxAccuracyM != null ? { approximatePosition: () => ({ location: pos, accuracyM: o.approxAccuracyM!, ageS: 3 }) } : {}),
  });
  const llm = new BackendLLMClient({ baseUrl: process.env.NAVIA_BACKEND_URL!, clientToken: process.env.NAVIA_BACKEND_TOKEN, timeoutMs: 60_000 });
  return new NaviaCopilot({ runtime, llm, aiEnabled: () => true });
}

export const STREETS = CONTEXT.reverse.map((r) => r.street).filter((s): s is string => !!s);
export const SHELTER_TEXT = CONTEXT.shelters.map((s) => `${s.name} ${s.address ?? ""}`);
