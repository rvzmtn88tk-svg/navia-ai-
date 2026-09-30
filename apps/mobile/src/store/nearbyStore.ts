// Nearby places by category, shared by the map, the Safety panel and the
// co-pilot so every screen sees the same shelters, fuel, pharmacies, etc.
// Loaded on demand around the current fix; optionally strictly within the
// radius the user chose.
import { create } from "zustand";
import { NearbyPlacesProvider, isInKyiv, type FetchCategory, type NearbyPlace } from "../providers/NearbyPlacesProvider";
import { useNaviaStore } from "../engine/naviaController";

export type LoadState = "idle" | "loading" | "ready" | "error";
/** radiusM: the user's strict search radius (null = automatic "nearest"). */
export type CategoryEntry = { state: LoadState; places: NearbyPlace[]; radiusM: number | null; unavailable?: string[]; usedOffline?: boolean };

const provider = new NearbyPlacesProvider();
const inFlight = new Map<FetchCategory, { radiusM: number | null; task: Promise<NearbyPlace[]> }>();

type NearbyState = {
  byCategory: Partial<Record<FetchCategory, CategoryEntry>>;
  /** Loads (or refreshes) one category around the current fix; resolves to
   * the places. `radiusM` undefined keeps the radius already chosen. */
  load: (category: FetchCategory, force?: boolean, radiusM?: number | null) => Promise<NearbyPlace[]>;
};

export const useNearbyStore = create<NearbyState>((set, get) => ({
  byCategory: {},
  load: async (category, force = false, radiusM) => {
    // Nearby places and shelters also around an approximate position (±a few hundred metres is fine for "nearest").
    const st = useNaviaStore.getState();
    const fix = st.currentFix ?? (st.approxFix && (st.approxFix.accuracyM ?? Infinity) <= 500 ? st.approxFix : null);
    const prev = get().byCategory[category];
    const radius = radiusM === undefined ? prev?.radiusM ?? null : radiusM;
    if (!fix) return prev?.places ?? [];
    const running = inFlight.get(category);
    if (running && !force && running.radiusM === radius) return running.task;
    const sameRadius = radius === (prev?.radiusM ?? null);
    const keep = sameRadius ? prev?.places ?? [] : [];
    set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: keep.length ? "ready" : "loading", places: keep, radiusM: radius } } }));
    const search = provider.searchCategory({ lat: fix.lat, lon: fix.lon }, category, { includeKyivOfficialData: isInKyiv(fix), force, radiusM: radius });
    const task = search.then((r) => r.places);
    inFlight.set(category, { radiusM: radius, task });
    const current = () => (get().byCategory[category]?.radiusM ?? null) === radius;
    try {
      const { places, unavailable, usedOffline } = await search;
      if (current()) set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: "ready", places, radiusM: radius, unavailable, usedOffline } } }));
      return places;
    } catch {
      if (current()) set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: keep.length ? "ready" : "error", places: keep, radiusM: radius } } }));
      return keep;
    } finally {
      if (inFlight.get(category)?.task === task) inFlight.delete(category);
    }
  },
}));
