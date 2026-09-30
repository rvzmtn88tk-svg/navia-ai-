// Live traffic — an explicit provider seam, not a guess.
//
// NAVIA has no live-traffic data source wired in yet (Valhalla's public
// HTTP API computes static costing; live speeds need a traffic feed).
// UnavailableTrafficProvider is therefore the default and says so, so the
// AI co-pilot answers "Are there jams ahead?" with "I don't have live
// traffic data" instead of inventing congestion.

import type { Route } from "./route-engine";
import type { LatLon } from "./types";
import { RouteGeometryIndex } from "./route-geometry";

export type TrafficDelay = {
  /** Along-route start/end of the slowdown, metres from route start. */
  startAlongM: number;
  endAlongM: number;
  /** Extra seconds vs. free flow. */
  delayS: number;
  severity: "light" | "moderate" | "heavy";
};

export type TrafficReport =
  | { available: false; reason: string }
  | { available: true; source: string; updatedAt: number; delays: TrafficDelay[] };

export interface TrafficProvider {
  getTrafficAlongRoute(route: Route, fromAlongM: number, toAlongM: number): Promise<TrafficReport>;
}

export class UnavailableTrafficProvider implements TrafficProvider {
  constructor(private reason = "no live traffic provider is configured in this build") {}

  async getTrafficAlongRoute(): Promise<TrafficReport> {
    return { available: false, reason: this.reason };
  }
}

/** Live flow on the road at a point (e.g. TomTom Flow Segment Data through the NAVIA proxy). */
export type PointFlow = { currentMps: number; freeFlowMps: number; confidence: number; closed?: boolean };

/**
 * Traffic along a route from point samples: the flow speed about every
 * kilometre of the stretch asked; a sample clearly below free flow becomes a
 * slowdown of ±500 m with the extra time it costs. Honest when the feed
 * fails: available=false with the reason, never a guessed jam.
 */
export class PointFlowTrafficProvider implements TrafficProvider {
  constructor(private flowAt: (p: LatLon) => Promise<PointFlow | null>, private source: string, private maxSamples = 8) {}

  async getTrafficAlongRoute(route: Route, fromAlongM: number, toAlongM: number): Promise<TrafficReport> {
    if (route.geometry.length < 2) return { available: false, reason: "no route geometry" };
    const index = new RouteGeometryIndex(route.geometry);
    const from = Math.max(0, fromAlongM), to = Math.min(index.lengthM, toAlongM);
    if (to - from < 100) return { available: true, source: this.source, updatedAt: Date.now(), delays: [] };
    const n = Math.max(1, Math.min(this.maxSamples, Math.round((to - from) / 1000)));
    const at = Array.from({ length: n }, (_, i) => from + ((i + 0.5) * (to - from)) / n);
    let flows: (PointFlow | null)[];
    try {
      flows = await Promise.all(at.map((m) => this.flowAt(index.pointAt(m)).catch(() => null)));
    } catch (e) {
      return { available: false, reason: `traffic feed failed: ${(e as Error).message}` };
    }
    if (flows.every((f) => f == null)) return { available: false, reason: "the traffic feed did not answer" };
    const delays: TrafficDelay[] = [];
    flows.forEach((f, i) => {
      if (!f || f.confidence < 0.5 || f.freeFlowMps <= 0) return;
      const ratio = f.closed ? 0 : f.currentMps / f.freeFlowMps;
      if (ratio >= 0.75) return;
      const startAlongM = Math.max(from, at[i]! - 500), endAlongM = Math.min(to, at[i]! + 500);
      const len = endAlongM - startAlongM;
      const delayS = f.closed ? 600 : Math.max(0, len / Math.max(0.5, f.currentMps) - len / f.freeFlowMps);
      delays.push({ startAlongM, endAlongM, delayS: Math.round(delayS), severity: ratio < 0.3 ? "heavy" : ratio < 0.55 ? "moderate" : "light" });
    });
    return { available: true, source: this.source, updatedAt: Date.now(), delays };
  }
}
