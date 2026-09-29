// Air targets shared by the home sheet row and the targets map. Polled only
// while something shows them and the app is in the foreground: every 15 s
// with the map open, every 60 s for the row's count. The source's CDN keeps
// a response ~5 s and tracks move every minute or two, so faster polling
// would only repeat the same data.
import { useEffect } from "react";
import { AppState } from "react-native";
import { create } from "zustand";
import { fetchTargets, mergeTracks, type AirTargetsSnapshot, type Tracks } from "../providers/AirTargetsProvider";

export const MAP_POLL_MS = 15_000;
export const ROW_POLL_MS = 60_000;

type TargetsState = {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: AirTargetsSnapshot | null;
  tracks: Tracks;
  /** When the last good snapshot arrived (phone clock). */
  lastOkAt: number | null;
  /** Why the last attempt failed (Ukrainian, for the screen). */
  error: string | null;
  refresh: () => Promise<void>;
};

let inFlight: Promise<void> | null = null;

export const useAirTargetsStore = create<TargetsState>((set, get) => ({
  status: "idle",
  snapshot: null,
  tracks: {},
  lastOkAt: null,
  error: null,
  refresh: () => {
    if (inFlight) return inFlight;
    if (!get().snapshot) set({ status: "loading" });
    inFlight = fetchTargets()
      .then((snapshot) => set((s) => ({ status: "ready", snapshot, tracks: mergeTracks(s.tracks, snapshot.targets), lastOkAt: Date.now(), error: null })))
      // The last good snapshot stays, marked as out of date by `error` — never an empty "no targets".
      .catch((e: unknown) => set({ status: "error", error: (e as Error).message }))
      .finally(() => { inFlight = null; });
    return inFlight;
  },
}));

/** Keeps the targets fresh while mounted and enabled, at the given pace, in the foreground only. */
export function useAirTargetsPolling(enabled: boolean, intervalMs: number): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = () => { if (AppState.currentState === "active") void useAirTargetsStore.getState().refresh(); };
    refresh();
    const id = setInterval(refresh, intervalMs);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") refresh(); });
    return () => { clearInterval(id); sub.remove(); };
  }, [enabled, intervalMs]);
}
