// What NAVIA knows about the active route beyond the router's steps: the
// landmark at each turn and every landmark along the way. Filled once when
// the route is built, used offline afterwards.
import { create } from "zustand";
import type { Route } from "@navia/core";
import { mergeLandmarks, overpassLandmarks, tileLandmarksAlong } from "../providers/RouteLandmarksProvider";
import { alongRoute, cumulative, landmarkForTurn, project, type RawLandmark, type RouteLandmark, type StepLandmark } from "../navigation/landmarks";

type RouteIntel = {
  routeId: string | null;
  state: "idle" | "loading" | "ready" | "error";
  byStep: Record<string, StepLandmark>;
  along: RouteLandmark[];
  /** Metres from the route start to each step's maneuver. */
  stepAlong: Record<string, number>;
  prepare: (route: Route) => Promise<void>;
  clear: () => void;
};

export const useRouteIntel = create<RouteIntel>((set, get) => ({
  routeId: null,
  state: "idle",
  byStep: {},
  along: [],
  stepAlong: {},
  prepare: async (route) => {
    if (get().routeId === route.id && get().state !== "error") return;
    const cum = cumulative(route.geometry);
    const stepAlong: Record<string, number> = {};
    for (const step of route.steps) stepAlong[step.id] = project(step.location, route.geometry, cum).alongM;
    set({ routeId: route.id, state: "loading", byStep: {}, along: [], stepAlong });
    // Two sources: map tiles answer in ~1 s, Overpass (traffic lights) can
    // take 20 s. Publish tiles first, then merge Overpass when it arrives.
    let fromTiles: RawLandmark[] = [];
    let fromOsm: RawLandmark[] = [];
    const publish = () => {
      if (get().routeId !== route.id) return;
      const along = alongRoute(mergeLandmarks(fromOsm, fromTiles), route.geometry);
      const byStep: Record<string, StepLandmark> = {};
      for (const step of route.steps) {
        if (step.maneuver === "depart" || step.maneuver === "straight") continue;
        const s = landmarkForTurn(along, stepAlong[step.id] ?? 0);
        if (s) byStep[step.id] = s;
      }
      set({ state: "ready", along, byStep });
    };
    const tiles = tileLandmarksAlong(route.geometry).then((r) => { fromTiles = r; publish(); });
    const osm = overpassLandmarks(route).then((r) => { fromOsm = r; publish(); });
    const results = await Promise.allSettled([tiles, osm]);
    if (results.every((r) => r.status === "rejected") && get().routeId === route.id) set({ state: "error" });
  },
  clear: () => set({ routeId: null, state: "idle", byStep: {}, along: [], stepAlong: {} }),
}));
