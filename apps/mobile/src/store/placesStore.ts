// Saved places (home, work, custom) and recent destinations, persisted on the
// phone. Cloud sync is added later behind sign-in.
import { create } from "zustand";
import Storage from "expo-sqlite/kv-store";

export type PlaceRef = { id: string; label: string; subtitle?: string; lat: number; lon: number };
export type SavedSlot = "home" | "work";

type PlacesState = {
  loaded: boolean;
  home: PlaceRef | null;
  work: PlaceRef | null;
  custom: PlaceRef[];
  recents: PlaceRef[];
  load: () => Promise<void>;
  setSlot: (slot: SavedSlot, place: PlaceRef | null) => void;
  saveCustom: (place: PlaceRef) => void;
  removeCustom: (id: string) => void;
  addRecent: (place: PlaceRef) => void;
};

const KEY = "navia.places.v1";
const MAX_RECENTS = 10;

export function placeId(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function persist(state: PlacesState): void {
  const { home, work, custom, recents } = state;
  void Storage.setItemAsync(KEY, JSON.stringify({ home, work, custom, recents })).catch(() => {});
}

function isPlace(value: unknown): value is PlaceRef {
  const v = value as PlaceRef | null;
  return !!v && typeof v.label === "string" && Number.isFinite(v.lat) && Number.isFinite(v.lon) && typeof v.id === "string";
}

export const usePlacesStore = create<PlacesState>((set, get) => ({
  loaded: false,
  home: null,
  work: null,
  custom: [],
  recents: [],
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await Storage.getItemAsync(KEY);
      const data = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      set({
        home: isPlace(data.home) ? data.home : null,
        work: isPlace(data.work) ? data.work : null,
        custom: Array.isArray(data.custom) ? data.custom.filter(isPlace) : [],
        recents: Array.isArray(data.recents) ? data.recents.filter(isPlace).slice(0, MAX_RECENTS) : [],
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },
  setSlot: (slot, place) => { set({ [slot]: place } as Pick<PlacesState, SavedSlot>); persist(get()); },
  saveCustom: (place) => { set((s) => ({ custom: [place, ...s.custom.filter((p) => p.id !== place.id)] })); persist(get()); },
  removeCustom: (id) => { set((s) => ({ custom: s.custom.filter((p) => p.id !== id) })); persist(get()); },
  addRecent: (place) => { set((s) => ({ recents: [place, ...s.recents.filter((p) => p.id !== place.id)].slice(0, MAX_RECENTS) })); persist(get()); },
}));
