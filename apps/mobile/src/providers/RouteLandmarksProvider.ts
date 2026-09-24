// Fetches what a driver can see along a route (traffic lights, fuel stations,
// shops, churches, crossings, bridges…) from OpenStreetMap once, when the
// route is built, so turn cues work later without GPS or network.
import type { LatLon, Route } from "@navia/core";
import { overpass } from "./overpass";
import { tileLandmarksAlong } from "./vectorTiles";
import { landmarkKind, type RawLandmark } from "../navigation/landmarks";

const CORRIDOR_M = 45;
const TURN_RADIUS_M = 90;

/** Douglas–Peucker in local metres; keeps the corridor query small. */
export function simplify(points: LatLon[], toleranceM: number): LatLon[] {
  if (points.length < 3) return points;
  const lat0 = points[0]!.lat;
  const k = Math.cos(lat0 * Math.PI / 180) * 111_320;
  const xy = points.map((p) => ({ x: p.lon * k, y: p.lat * 110_540 }));
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, index = -1;
    const A = xy[a]!, B = xy[b]!;
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    for (let i = a + 1; i < b; i++) {
      const P = xy[i]!;
      const d = Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / len;
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > toleranceM && index > 0) { keep[index] = true; stack.push([a, index], [index, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const SELECTORS = [
  'node{A}["highway"="traffic_signals"]',
  'node{A}["railway"="level_crossing"]',
  'nwr{A}["amenity"~"^(fuel|pharmacy|place_of_worship|school|hospital|clinic|bank|police|post_office|cafe|restaurant|fast_food)$"]',
  'nwr{A}["shop"]["name"]',
  'node{A}["highway"="bus_stop"]["name"]',
  'nwr{A}["historic"="monument"]',
  'way{A}["bridge"]["name"]',
];

export function buildQuery(route: Pick<Route, "geometry" | "steps" | "distanceM">): string {
  const parts: string[] = [];
  if (route.distanceM <= 40_000) {
    const line = simplify(route.geometry, 8).slice(0, 600).map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(",");
    const around = `(around:${CORRIDOR_M},${line})`;
    parts.push(...SELECTORS.map((s) => s.replace("{A}", around)));
  } else {
    // Long trips: only around the turns.
    for (const step of route.steps.slice(0, 80)) {
      if (step.maneuver === "straight" || step.maneuver === "merge") continue;
      const around = `(around:${TURN_RADIUS_M},${step.location.lat.toFixed(6)},${step.location.lon.toFixed(6)})`;
      parts.push(...SELECTORS.map((s) => s.replace("{A}", around)));
    }
  }
  return `[out:json][timeout:25];(${parts.map((p) => `${p};`).join("")});out center tags 1500;`;
}

/** Map tiles (fast, reliable) plus Overpass (adds traffic lights; best effort). */
export async function fetchRouteLandmarks(route: Pick<Route, "geometry" | "steps" | "distanceM">): Promise<RawLandmark[]> {
  const [tiles, osm] = await Promise.allSettled([tileLandmarksAlong(route.geometry), overpassLandmarks(route)]);
  if (tiles.status === "rejected" && osm.status === "rejected") throw tiles.reason;
  return mergeLandmarks(osm.status === "fulfilled" ? osm.value : [], tiles.status === "fulfilled" ? tiles.value : []);
}

/** Overpass wins on duplicates (richer tags); the other source fills gaps. */
export function mergeLandmarks(primary: RawLandmark[], extra: RawLandmark[]): RawLandmark[] {
  const merged = [...primary];
  for (const l of extra) {
    if (!merged.some((m) => m.kind === l.kind && near(m.location, l.location, 35))) merged.push(l);
  }
  return merged;
}

export { tileLandmarksAlong };

function near(a: { lat: number; lon: number }, b: { lat: number; lon: number }, m: number): boolean {
  const dy = (a.lat - b.lat) * 110_540;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy) < m;
}

export async function overpassLandmarks(route: Pick<Route, "geometry" | "steps" | "distanceM">): Promise<RawLandmark[]> {
  const elements = await overpass(buildQuery(route), { perEndpointTimeoutMs: 12_000 });
  const seen = new Set<string>();
  return elements.flatMap((e) => {
    const tags = e.tags ?? {};
    const kind = landmarkKind(tags);
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!kind || lat == null || lon == null) return [];
    const id = `${e.type}-${e.id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const name = tags["name:uk"] ?? tags.name ?? tags.brand ?? null;
    return [{ id, kind, name, location: { lat, lon } }];
  });
}
