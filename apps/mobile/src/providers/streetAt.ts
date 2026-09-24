// Street name at a point (OpenStreetMap Nominatim reverse geocoding), for
// "where am I". Cached per ~60 m and throttled; the co-pilot works without it.
import type { LatLon } from "@navia/core";

type Hit = { location: LatLon; at: number; street: string | null; area: string | null };
let last: Hit | null = null;
let lastCallAt = 0;

function near(a: LatLon, b: LatLon, m: number): boolean {
  const dy = (a.lat - b.lat) * 110_540;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy) < m;
}

export function cachedStreet(p: LatLon): { street: string | null; area: string | null } | null {
  return last && near(last.location, p, 60) ? { street: last.street, area: last.area } : null;
}

export async function streetAt(p: LatLon): Promise<{ street: string | null; area: string | null } | null> {
  const hit = cachedStreet(p);
  if (hit) return hit;
  if (Date.now() - lastCallAt < 15_000) return null;
  lastCallAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=uk&lat=${p.lat}&lon=${p.lon}`;
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "NAVIA/0.1 (navigation app)" }, signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json() as { address?: Record<string, string> };
    const a = data.address ?? {};
    const road = a.road ?? a.pedestrian ?? a.footway ?? null;
    const street = road ? `${road}${a.house_number ? `, ${a.house_number}` : ""}` : null;
    const area = a.suburb ?? a.city_district ?? a.village ?? a.town ?? a.city ?? null;
    last = { location: p, at: Date.now(), street, area };
    return { street, area };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
