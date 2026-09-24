// The trip in progress (destination and mode), readable by the co-pilot and
// other screens while the navigation screen owns the engine.
import { create } from "zustand";

type TripState = {
  destination: string | null;
  mode: "car" | "walk";
  offlineSaved: boolean;
  set: (patch: Partial<Omit<TripState, "set" | "clear">>) => void;
  clear: () => void;
};

export const useTripStore = create<TripState>((set) => ({
  destination: null,
  mode: "car",
  offlineSaved: false,
  set: (patch) => set(patch),
  clear: () => set({ destination: null, mode: "car", offlineSaved: false }),
}));
