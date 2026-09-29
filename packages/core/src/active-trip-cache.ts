// ActiveTripCache — the trip in progress, saved on the phone so that losing
// mobile data (or the app being killed) doesn't destroy navigation. Saved
// whenever the route changes: destination, stops, preferences and the full
// route (geometry + maneuvers + timings). On restart without internet the
// app restores it and keeps guiding along it; rerouting needs the network
// (or an offline routing package) and is reported as unavailable meanwhile.
//
// Map tiles are a separate concern (MapLibre's own tile cache / offline
// packs); the route itself is enough for guidance, GNSS-denied tracking and
// the co-pilot's route questions.

import type { Route } from "./route-engine";
import type { TripPlan } from "./trip-planner";
import type { KeyValueStore } from "./storage";

export type CachedTrip = { version: 1; savedAt: number; plan: TripPlan; route: Route };

export class ActiveTripCache {
  constructor(private store: KeyValueStore, private key = "navia.activeTrip.v1") {}

  async save(plan: TripPlan, route: Route, now = Date.now()): Promise<void> {
    if (!plan.destination) return;
    const trip: CachedTrip = { version: 1, savedAt: now, plan, route };
    await this.store.setItem(this.key, JSON.stringify(trip));
  }

  /** The cached trip, if one exists and is younger than `maxAgeMs` (a trip from yesterday is not "the active trip"). */
  async load(now = Date.now(), maxAgeMs = 12 * 3600_000): Promise<CachedTrip | null> {
    let raw: string | null;
    try { raw = await this.store.getItem(this.key); } catch { return null; }
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as CachedTrip;
      if (t.version !== 1 || !t.route?.geometry?.length || !t.plan?.destination) return null;
      if (now - t.savedAt > maxAgeMs) return null;
      return t;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.store.removeItem(this.key);
  }
}
