// Places the co-pilot found (search_near / search_along_route / get_safety_info)
// as the chat's place cards with a route button — the same cards the on-device
// navigator shows. Taken from the tool results and the co-pilot's own registry
// (ids → the real map records), never from the model's words.
import { haversineMeters, type EntityRegistry, type LatLon, type ToolTraceEntry } from "@navia/core";
import type { PlaceKind, WorldPlace } from "./copilotBrain";

const KIND: Record<string, PlaceKind> = {
  fuel: "fuel", ev_charging: "charger", pharmacy: "pharmacy", hospital: "hospital", atm: "atm", shelter: "shelter", resilience: "resilience",
  restaurant: "food", cafe: "food", fast_food: "food", supermarket: "shop", shopping_centre: "shop",
};

export function placesFromTrace(trace: readonly ToolTraceEntry[], registry: EntityRegistry, here: LatLon | null, max = 5): WorldPlace[] {
  const out: WorldPlace[] = [];
  for (const t of trace) {
    if (t.isError || !t.result) continue;
    const r = t.result as { results?: { id?: string }[]; shelters?: { id?: string }[] };
    for (const row of [...(r.results ?? []), ...(r.shelters ?? [])]) {
      if (!row.id || out.some((p) => p.id === row.id)) continue;
      const e = registry.get(row.id);
      if (!e || e.kind !== "place") continue;
      const kind = KIND[e.category ?? e.poi?.category ?? ""];
      if (!kind) continue;
      out.push({ id: row.id, name: e.label, kind, location: e.location, distanceM: here ? Math.round(haversineMeters(here, e.location)) : 0 });
      if (out.length >= max) return out;
    }
  }
  return out;
}
