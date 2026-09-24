// Nearby places by category, shared by the map, the Safety panel and the
// co-pilot so every screen sees the same shelters, fuel, pharmacies, etc.
// Loaded on demand around the current fix.
import { create } from "zustand";
import { NearbyPlacesProvider, isInKyiv, type FetchCategory, type NearbyPlace } from "../providers/NearbyPlacesProvider";
import { useNaviaStore } from "../engine/naviaController";

export type LoadState = "idle" | "loading" | "ready" | "error";
export type CategoryEntry = { state: LoadState; places: NearbyPlace[] };

const provider = new NearbyPlacesProvider();
const inFlight = new Map<FetchCategory, Promise<NearbyPlace[]>>();

type NearbyState = {
  byCategory: Partial<Record<FetchCategory, CategoryEntry>>;
  /** Loads (or refreshes) one category around the current fix; resolves to the places. */
  load: (category: FetchCategory, force?: boolean) => Promise<NearbyPlace[]>;
};

export const useNearbyStore = create<NearbyState>((set, get) => ({
  byCategory: {},
  load: async (category, force = false) => {
    const fix = useNaviaStore.getState().currentFix;
    if (!fix) return get().byCategory[category]?.places ?? [];
    const running = inFlight.get(category);
    if (running && !force) return running;
    const prev = get().byCategory[category];
    set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: prev?.places.length ? "ready" : "loading", places: prev?.places ?? [] } } }));
    const task = provider.fetchCategory({ lat: fix.lat, lon: fix.lon }, category, { includeKyivOfficialData: isInKyiv(fix), force });
    inFlight.set(category, task);
    try {
      const places = await task;
      set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: "ready", places } } }));
      return places;
    } catch {
      set((s) => ({ byCategory: { ...s.byCategory, [category]: { state: prev?.places.length ? "ready" : "error", places: prev?.places ?? [] } } }));
      return prev?.places ?? [];
    } finally {
      inFlight.delete(category);
    }
  },
}));
