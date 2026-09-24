// Route-constrained dead reckoning: keeps guiding along an active route when
// GNSS is jammed, lost or spoofed.
//
// Principle: the driver is following the route, so the best available
// estimate of position is "somewhere further along the route". Progress
// advances by speed × time while the phone's motion sensors say the vehicle
// is moving; speed comes from the last trusted GNSS speed, or — when none is
// known (e.g. GPS lost before the trip began) — the route's own expected pace
// for the current leg. Uncertainty grows with time and distance and is always
// reported; it never pretends to be a GNSS fix.
import type { IMUSample, LatLon } from "./types";
import type { Route } from "./route-engine";
import { positionAtDistance } from "./route-engine";
import { haversineMeters, initialBearing } from "./geodesy";

// ——— Motion detection from the accelerometer ———

/** Classifies the phone as moving or stationary from accelerometer
 * variability. A phone in a moving car vibrates continuously; one in a
 * stopped car (or on a table) is nearly still. Returns null until enough
 * samples have arrived. */
export class MotionDetector {
  private magnitudes: number[] = [];
  private lastAt = 0;

  constructor(private windowSize = 30, private stillStdG = 0.012, private maxGapMs = 3_000) {}

  push(sample: IMUSample): void {
    if (sample.timestamp - this.lastAt > this.maxGapMs) this.magnitudes = [];
    this.lastAt = sample.timestamp;
    const m = Math.sqrt(sample.accelX ** 2 + sample.accelY ** 2 + sample.accelZ ** 2);
    if (!Number.isFinite(m)) return;
    this.magnitudes.push(m);
    if (this.magnitudes.length > this.windowSize) this.magnitudes.shift();
  }

  /** true = moving, false = stationary, null = unknown (not enough data or stale). */
  isMoving(nowMs: number): boolean | null {
    if (this.magnitudes.length < Math.min(10, this.windowSize) || nowMs - this.lastAt > this.maxGapMs) return null;
    const mean = this.magnitudes.reduce((a, b) => a + b, 0) / this.magnitudes.length;
    const variance = this.magnitudes.reduce((a, b) => a + (b - mean) ** 2, 0) / this.magnitudes.length;
    return Math.sqrt(variance) > this.stillStdG;
  }

  reset(): void {
    this.magnitudes = [];
    this.lastAt = 0;
  }
}

// ——— Dead reckoning along the route ———

export type DeadReckoningEstimate = {
  position: LatLon;
  headingDeg: number;
  progressM: number;
  speedMps: number;
  /** One-sigma-ish along-route uncertainty in metres; grows over time. */
  uncertaintyM: number;
  /** Seconds since the last trusted anchor (GNSS fix or user confirmation). */
  ageS: number;
  anchorSource: "gnss" | "manual" | "confirmation";
};

type Anchor = { progressM: number; atMs: number; accuracyM: number; source: DeadReckoningEstimate["anchorSource"] };

export const DR_MAX_AGE_S = 15 * 60;
const SPEED_SMOOTHING = 0.35;

export class RouteDeadReckoner {
  private anchor: Anchor | null = null;
  private progressM = 0;
  private travelledSinceAnchorM = 0;
  private lastStepAt = 0;
  private trustedSpeedMps: number | null = null;
  private cumulativeLegEnds: number[] = [];
  private route: Route | null = null;

  setRoute(route: Route | null): void {
    this.route = route;
    this.cumulativeLegEnds = [];
    let cum = 0;
    for (const step of route?.steps ?? []) { cum += step.distanceM; this.cumulativeLegEnds.push(cum); }
    this.anchor = null;
    this.trustedSpeedMps = null;
  }

  /** A trusted GNSS fix placed the vehicle at `progressM` along the route. */
  anchorFromGnss(progressM: number, speedMps: number | null, accuracyM: number | null, nowMs: number): void {
    if (speedMps != null && speedMps >= 0) {
      this.trustedSpeedMps = this.trustedSpeedMps == null ? speedMps : this.trustedSpeedMps + SPEED_SMOOTHING * (speedMps - this.trustedSpeedMps);
    }
    this.setAnchor(progressM, nowMs, accuracyM ?? 15, "gnss");
  }

  /** The user placed themselves manually ("I am here"); speed is unknown. */
  anchorManually(progressM: number, nowMs: number): void {
    this.trustedSpeedMps = null;
    this.setAnchor(progressM, nowMs, 60, "manual");
  }

  /** The user confirmed a maneuver (e.g. "I've turned"): snap to its position. */
  confirmReached(progressM: number, nowMs: number): void {
    this.setAnchor(progressM, nowMs, 30, "confirmation");
  }

  hasAnchor(): boolean {
    return this.anchor != null;
  }

  private setAnchor(progressM: number, nowMs: number, accuracyM: number, source: Anchor["source"]): void {
    this.anchor = { progressM, atMs: nowMs, accuracyM, source };
    this.progressM = progressM;
    this.travelledSinceAnchorM = 0;
    this.lastStepAt = nowMs;
  }

  /** Expected pace of the leg containing `progressM`, from the route itself. */
  private routePaceMps(progressM: number): number {
    const route = this.route;
    if (!route) return 0;
    const i = this.cumulativeLegEnds.findIndex((end) => progressM < end);
    const step = route.steps[i >= 0 ? i : route.steps.length - 1];
    if (step && step.durationS > 0 && step.distanceM > 0) return step.distanceM / step.durationS;
    return route.durationS > 0 ? route.distanceM / route.durationS : 0;
  }

  /** Advance to `nowMs`. `moving` comes from MotionDetector (null = unknown). */
  estimate(nowMs: number, moving: boolean | null): DeadReckoningEstimate | null {
    const route = this.route;
    const anchor = this.anchor;
    if (!route || !anchor || route.geometry.length < 2) return null;
    const dtS = Math.max(0, (nowMs - this.lastStepAt) / 1000);
    this.lastStepAt = nowMs;
    // Unknown motion state: keep going, but only at the trusted speed (never
    // an assumed pace) — standing still is the safer assumption without it.
    const speed = moving === false ? 0
      : this.trustedSpeedMps != null && this.trustedSpeedMps > 0.5 ? this.trustedSpeedMps
        : moving === true ? this.routePaceMps(this.progressM) : 0;
    const step = speed * dtS;
    this.progressM = Math.min(route.distanceM, this.progressM + step);
    this.travelledSinceAnchorM += step;
    const ageS = (nowMs - anchor.atMs) / 1000;
    // Along-route error: anchor error + 10 % of distance (speed error) + slow
    // drift; an assumed pace (no trusted speed) is far less certain.
    const paceFactor = this.trustedSpeedMps != null ? 0.1 : 0.3;
    const uncertaintyM = anchor.accuracyM + paceFactor * this.travelledSinceAnchorM + 0.5 * ageS;
    const position = positionAtDistance(route.geometry, this.progressM);
    const ahead = positionAtDistance(route.geometry, Math.min(route.distanceM, this.progressM + 15));
    const headingDeg = haversineMeters(position, ahead) > 1 ? initialBearing(position, ahead) : 0;
    return { position, headingDeg, progressM: this.progressM, speedMps: speed, uncertaintyM, ageS, anchorSource: anchor.source };
  }

  /** Whether a returning GNSS fix is consistent with where we believe the
   * vehicle is — a fix far outside the uncertainty is treated as spoofed. */
  isConsistent(fix: LatLon, nowMs: number): boolean {
    if (!this.anchor || !this.route) return true;
    const estimatePoint = positionAtDistance(this.route.geometry, this.progressM);
    const ageS = (nowMs - this.anchor.atMs) / 1000;
    const tolerance = Math.max(300, 3 * (this.anchor.accuracyM + 0.3 * this.travelledSinceAnchorM + 0.5 * ageS));
    return haversineMeters(fix, estimatePoint) <= tolerance;
  }

  reset(): void {
    this.setRoute(null);
    this.progressM = 0;
    this.travelledSinceAnchorM = 0;
  }
}

/** Maps along-route uncertainty to a confidence value and band (never HIGH
 * without GNSS). */
export function deadReckoningConfidence(est: DeadReckoningEstimate): { value: number; band: "MEDIUM" | "LOW" | "UNKNOWN" } {
  if (est.ageS > DR_MAX_AGE_S || est.uncertaintyM > 600) return { value: 0.15, band: "UNKNOWN" };
  if (est.uncertaintyM <= 60) return { value: 0.6, band: "MEDIUM" };
  if (est.uncertaintyM <= 250) return { value: 0.4, band: "LOW" };
  return { value: 0.25, band: "LOW" };
}
