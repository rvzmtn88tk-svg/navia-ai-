// LocationState — one answer to "how much do we know about where the car is",
// shared by the navigation engine, the voice guidance and the AI co-pilot.
//
// Position estimation stays in the navigator; this only classifies its
// output (source, uncertainty, GNSS verdict, fix age, recent history) into
// states and a guidance policy:
//   exact        — say "in 300 m turn right";
//   approximate  — say "in about 300 m", ask to confirm by signs/landmarks;
//   none         — don't give distances or turns from a guess; say that the
//                  position is temporarily unavailable.

import type { NavigatorEstimate } from "./resilient-navigator";

export type LocationStateKind =
  /** Trusted GNSS, small uncertainty. */
  | "PRECISE"
  /** GNSS used, but its accuracy is poor (urban canyon, weak signal). */
  | "REDUCED_ACCURACY"
  /** No new fix for a few seconds; still estimating from motion. */
  | "STALE"
  /** GNSS keeps coming and going / being accepted and rejected. */
  | "UNSTABLE"
  /** No usable GNSS; position from road + motion sensors only. */
  | "LOST"
  /** GNSS contradicts the car's motion and is being ignored. */
  | "SPOOFED"
  /** GNSS just came back after an outage and is being verified. */
  | "RECOVERED";

export type GuidancePolicy = "exact" | "approximate" | "none";

export type LocationStatus = {
  state: LocationStateKind;
  /** 0..1, falls with uncertainty and time without a reliable fix. */
  confidence: number;
  uncertaintyM: number;
  guidance: GuidancePolicy;
  secondsSinceReliableFix: number | null;
};

export type LocationStateConfig = {
  /** Up to this uncertainty (m), maneuver distances are given as exact. */
  exactMaxM: number;
  /** Up to this uncertainty, as approximate; beyond it no distances/turns from a guess. */
  approximateMaxM: number;
  /** Fix age (s) after which a missing fix counts as LOST rather than STALE. */
  lostAfterS: number;
  /** How long after a recovery the state reads RECOVERED. */
  recoveredForS: number;
};

export const DEFAULT_LOCATION_STATE_CONFIG: LocationStateConfig = {
  exactMaxM: 30,
  approximateMaxM: 150,
  lostAfterS: 12,
  recoveredForS: 15,
};

export class LocationStateTracker {
  private cfg: LocationStateConfig;
  private history: { t: number; verdict: NavigatorEstimate["gnss"] }[] = [];
  private outageStartedAt: number | null = null;
  private recoveredAt: number | null = null;

  constructor(config: Partial<LocationStateConfig> = {}) {
    this.cfg = { ...DEFAULT_LOCATION_STATE_CONFIG, ...config };
  }

  update(est: NavigatorEstimate): LocationStatus {
    const t = est.t;
    this.history.push({ t, verdict: est.gnss });
    while (this.history.length > 0 && t - this.history[0]!.t > 30) this.history.shift();

    const tracking = est.gnss === "OK" || est.gnss === "DEGRADED";
    if (!tracking) {
      if (this.outageStartedAt == null) this.outageStartedAt = t;
    } else if (this.outageStartedAt != null) {
      if (t - this.outageStartedAt >= 10) this.recoveredAt = t;
      this.outageStartedAt = null;
    }

    // Flip-flopping between tracking and not tracking within the last 30 s.
    let flips = 0;
    for (let i = 1; i < this.history.length; i++) {
      const a = this.history[i - 1]!.verdict, b = this.history[i]!.verdict;
      const ta = a === "OK" || a === "DEGRADED", tb = b === "OK" || b === "DEGRADED";
      if (ta !== tb) flips++;
    }

    const age = est.secondsSinceAcceptedFix;
    let state: LocationStateKind;
    if (est.gnssInconsistent || (est.gnss === "REJECTED" && this.outageStartedAt != null && t - this.outageStartedAt >= 5)) state = "SPOOFED";
    else if (flips >= 4) state = "UNSTABLE";
    else if (!tracking) state = age != null && age <= this.cfg.lostAfterS ? "STALE" : "LOST";
    else if (this.recoveredAt != null && t - this.recoveredAt <= this.cfg.recoveredForS) state = "RECOVERED";
    else if (est.gnss === "DEGRADED" || est.uncertaintyM > this.cfg.exactMaxM) state = "REDUCED_ACCURACY";
    else state = "PRECISE";

    const u = est.uncertaintyM;
    let guidance: GuidancePolicy = u <= this.cfg.exactMaxM ? "exact" : u <= this.cfg.approximateMaxM ? "approximate" : "none";
    // Band UNKNOWN means the navigator itself has no usable estimate.
    if (est.band === "UNKNOWN") guidance = "none";
    // Dead reckoning can't see an unmeasured speed change: after a few seconds
    // without an accepted fix, distances are "about", never exact.
    if (guidance === "exact" && !tracking && (age == null || age > 5)) guidance = "approximate";
    // A position being verified after recovery or under suspected spoofing is never "exact".
    if (guidance === "exact" && (state === "SPOOFED" || state === "UNSTABLE" || (state === "RECOVERED" && est.band !== "HIGH"))) guidance = "approximate";

    const confidence = Math.max(0, Math.min(1, 1 / (1 + (u / 40) ** 2) * (est.onRouteProbability > 0.5 || est.offRoute ? 1 : 0.7)));
    return { state, confidence: Math.round(confidence * 100) / 100, uncertaintyM: u, guidance, secondsSinceReliableFix: age };
  }
}
