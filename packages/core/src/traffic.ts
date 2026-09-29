// Live traffic — an explicit provider seam, not a guess.
//
// NAVIA has no live-traffic data source wired in yet (Valhalla's public
// HTTP API computes static costing; live speeds need a traffic feed).
// UnavailableTrafficProvider is therefore the default and says so, so the
// AI co-pilot answers "Are there jams ahead?" with "I don't have live
// traffic data" instead of inventing congestion.

import type { Route } from "./route-engine";

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
