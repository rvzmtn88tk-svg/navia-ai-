// Places for the navigator's world view: every category ranked by the one
// shared nearest-first search (the same as the map's list), distance and
// direction from the user now, top 12. Real mode never carries demo records.
// Pure; unit-tested (test/shelterChain.test.ts).
import { haversineMeters, initialBearing, nearestFirst, type LatLon } from "@navia/core";
import type { PlaceKind, WorldPlace } from "../ai/copilotBrain";

type Entry = { places: { id: string; name: string; location: LatLon; address?: string; openingHours?: string; origin?: "online" | "offline" | "demo"; source?: string }[] };

export function rankWorldPlaces(byCategory: Partial<Record<PlaceKind, Entry>>, here: LatLon | null, isDemo: boolean, limit = 12): Partial<Record<PlaceKind, WorldPlace[]>> {
  const out: Partial<Record<PlaceKind, WorldPlace[]>> = {};
  for (const [kind, entry] of Object.entries(byCategory) as [PlaceKind, Entry][]) {
    // A demo record is never shown as real.
    const pool = entry.places.filter((p) => isDemo || p.origin !== "demo");
    const ranked = here ? nearestFirst(pool.map((p) => ({ ...p, category: kind })), here, { limit }) : pool.slice(0, limit);
    out[kind] = ranked.map<WorldPlace>((p) => ({
      id: p.id, name: p.name, kind, location: p.location,
      distanceM: here ? haversineMeters(here, p.location) : 0,
      ...(here ? { bearingDeg: initialBearing(here, p.location) } : {}),
      ...(p.address ? { address: p.address } : {}),
      ...(p.openingHours ? { hours: p.openingHours } : {}),
      ...(p.origin ? { origin: p.origin } : {}),
      ...(p.source ? { source: p.source } : {}),
    }));
  }
  return out;
}
