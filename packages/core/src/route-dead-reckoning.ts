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
import { positionAtDistance, stepLegEndsM } from "./route-engine";
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
  anchorSource: DrAnchorSource;
  /** Where the speed came from ("stationary", "vehicle" OBD, "gnss" last trusted, "driver", "traffic", "learned", "steps", "route_pace"). */
  speedSource: DrSpeedSource;
};

/** What the estimate counts from: GNSS, the driver (point / maneuver / landmark), or evidence
 * the phone gathered on its own (a coarse Wi-Fi/cell fix, a felt turn, a bridge/tunnel on the barometer). */
export type DrAnchorSource = "gnss" | "manual" | "confirmation" | "landmark" | "coarse" | "turn" | "structure";
export type DrSpeedSource = "stationary" | "vehicle" | "gnss" | "driver" | "traffic" | "learned" | "steps" | "route_pace";
/** Speed evidence other than GNSS (see estimate()). */
export type SpeedHintSource = "vehicle" | "driver" | "traffic" | "learned";

type Anchor = { progressM: number; atMs: number; accuracyM: number; source: DrAnchorSource };

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
  private trustedSpeedAtMs = 0;
  private hints = new Map<SpeedHintSource, { mps: number; atMs: number }>();
  private stationaryUntilMs = 0;
  /** Walking: cumulative distance from the pedometer (steps × learned stride). */
  private steps: { totalM: number; atMs: number } | null = null;
  private stepsAtLastEstimate: number | null = null;
  private lastUncertaintyM: number | null = null;
  private paceFactorNow = DR_PACE_ERROR_ASSUMED;

  setRoute(route: Route | null): void {
    this.route = route;
    this.cumulativeLegEnds = route ? stepLegEndsM(route) : [];
    this.anchor = null;
    this.trustedSpeedMps = null;
    this.lastUncertaintyM = null;
  }

  /** Speed evidence without GNSS: OBD vehicle speed, the driver's words, traffic flow, learned speed. null clears it. */
  setSpeedHint(source: SpeedHintSource, mps: number | null, nowMs: number): void {
    if (mps == null || !Number.isFinite(mps) || mps < 0) this.hints.delete(source);
    else this.hints.set(source, { mps, atMs: nowMs });
  }

  /** The driver says they are standing ("стою в пробці"): no progress until motion is felt again or `ms` pass. */
  setStationaryFor(ms: number, nowMs: number): void {
    this.stationaryUntilMs = ms > 0 ? nowMs + ms : 0;
  }

  /** Walking: cumulative metres from the pedometer; used instead of speed × time while it keeps arriving. */
  pushStepDistance(totalM: number, nowMs: number): void {
    this.steps = { totalM, atMs: nowMs };
  }

  /** Evidence placed the vehicle at `progressM` (a felt turn, a bridge, a coarse fix): speed is kept. */
  anchorAt(progressM: number, accuracyM: number, nowMs: number, source: DrAnchorSource): void {
    this.setAnchor(progressM, nowMs, accuracyM, source);
  }

  /**
   * A coarse fix (Wi-Fi / cell positioning keeps working when GNSS is jammed)
   * projected on the route: a 1-D Kalman update of the along-route estimate.
   * Ignored when it contradicts the estimate beyond both error bars.
   */
  fuseCoarse(progressFixM: number, accuracyM: number, nowMs: number): boolean {
    const sigma = this.lastUncertaintyM;
    if (!this.anchor || !this.route || sigma == null) return false;
    const innovation = progressFixM - this.progressM;
    if (Math.abs(innovation) > 3 * Math.hypot(sigma, accuracyM)) return false;
    const k = (sigma * sigma) / (sigma * sigma + accuracyM * accuracyM);
    const fused = this.progressM + k * innovation;
    const fusedSigma = Math.sqrt((sigma * sigma * accuracyM * accuracyM) / (sigma * sigma + accuracyM * accuracyM));
    // Never claim better than the fix could possibly give on its own when the estimate was wide.
    // A coarse fix can't make the estimate much better than a fraction of its own error.
    this.setAnchor(Math.max(0, Math.min(this.route.distanceM, fused)), nowMs, Math.max(25, 0.35 * accuracyM, fusedSigma), "coarse");
    return true;
  }

  /** The along-route uncertainty of the latest estimate (metres). */
  currentUncertaintyM(): number | null {
    return this.lastUncertaintyM;
  }

  /** A trusted GNSS fix placed the vehicle at `progressM` along the route. */
  anchorFromGnss(progressM: number, speedMps: number | null, accuracyM: number | null, nowMs: number): void {
    if (speedMps != null && speedMps >= 0) {
      this.trustedSpeedMps = this.trustedSpeedMps == null ? speedMps : this.trustedSpeedMps + SPEED_SMOOTHING * (speedMps - this.trustedSpeedMps);
      this.trustedSpeedAtMs = nowMs;
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

  /** The driver confirmed a landmark the map places at `progressM`; the trusted speed is kept. */
  anchorFromLandmark(progressM: number, accuracyM: number, nowMs: number): void {
    this.setAnchor(progressM, nowMs, accuracyM, "landmark");
  }

  /** Everything needed to undo an anchor ("no, I'm not there"). */
  snapshot(): { anchor: Anchor | null; progressM: number; travelledSinceAnchorM: number; lastStepAt: number } {
    return { anchor: this.anchor ? { ...this.anchor } : null, progressM: this.progressM, travelledSinceAnchorM: this.travelledSinceAnchorM, lastStepAt: this.lastStepAt };
  }

  restore(s: ReturnType<RouteDeadReckoner["snapshot"]>, nowMs: number): void {
    // Time spent since the snapshot still counts: continue from where the old estimate would be.
    this.anchor = s.anchor ? { ...s.anchor } : null;
    this.progressM = s.progressM;
    this.travelledSinceAnchorM = s.travelledSinceAnchorM;
    this.lastStepAt = Math.min(s.lastStepAt, nowMs);
  }

  hasAnchor(): boolean {
    return this.anchor != null;
  }

  private setAnchor(progressM: number, nowMs: number, accuracyM: number, source: Anchor["source"]): void {
    this.anchor = { progressM, atMs: nowMs, accuracyM, source };
    this.progressM = progressM;
    this.travelledSinceAnchorM = 0;
    this.lastStepAt = nowMs;
    this.lastUncertaintyM = accuracyM;
    this.paceFactorNow = this.trustedSpeedMps != null ? DR_PACE_ERROR_TRUSTED : DR_PACE_ERROR_ASSUMED;
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

  /** The speed to advance with now, where it comes from, and how much of the distance becomes error. */
  private chooseSpeed(nowMs: number, moving: boolean | null): { mps: number; source: DrSpeedSource; errorShare: number } {
    const fresh = (src: SpeedHintSource, maxAgeMs: number) => { const h = this.hints.get(src); return h && nowMs - h.atMs <= maxAgeMs ? h.mps : null; };
    const vehicle = fresh("vehicle", 3_000);
    // The car's own speedometer (OBD) beats everything, even the stationary guess.
    if (vehicle != null) return { mps: vehicle, source: vehicle < 0.3 ? "stationary" : "vehicle", errorShare: DR_PACE_ERROR_VEHICLE };
    if (nowMs < this.stationaryUntilMs && moving !== true) return { mps: 0, source: "stationary", errorShare: 0 };
    if (moving === false) return { mps: 0, source: "stationary", errorShare: 0 };
    const driver = fresh("driver", 5 * 60_000);
    const traffic = fresh("traffic", 3 * 60_000);
    const learned = fresh("learned", 2 * 60_000);
    const context = driver ?? traffic ?? learned;
    const contextSource: DrSpeedSource = driver != null ? "driver" : traffic != null ? "traffic" : "learned";
    const contextError = driver != null ? DR_PACE_ERROR_DRIVER : traffic != null ? DR_PACE_ERROR_TRAFFIC : DR_PACE_ERROR_LEARNED;
    if (this.trustedSpeedMps != null && this.trustedSpeedMps > 0.5) {
      // The last GNSS speed ages: after a few minutes the road ahead (traffic,
      // learned speed of this place) says more than how fast we went back then.
      const ageS = Math.max(0, (nowMs - this.trustedSpeedAtMs) / 1000);
      const w = Math.exp(-ageS / 180);
      if (context != null && w < 0.95) return { mps: w * this.trustedSpeedMps + (1 - w) * context, source: w >= 0.5 ? "gnss" : contextSource, errorShare: w * DR_PACE_ERROR_TRUSTED + (1 - w) * contextError };
      // Alone, an old speed says less and less about the speed now (the car slows, speeds up).
      return { mps: this.trustedSpeedMps, source: "gnss", errorShare: DR_PACE_ERROR_TRUSTED + (DR_PACE_ERROR_ASSUMED - DR_PACE_ERROR_TRUSTED) * (1 - w) };
    }
    if (context != null) return { mps: context, source: contextSource, errorShare: contextError };
    // Unknown motion state: keep going only at a known speed (never an assumed
    // pace) — standing still is the safer assumption without it.
    if (moving === true) return { mps: this.routePaceMps(this.progressM), source: "route_pace", errorShare: DR_PACE_ERROR_ASSUMED };
    return { mps: 0, source: "stationary", errorShare: 0 };
  }

  /** Advance to `nowMs`. `moving` comes from MotionDetector (null = unknown). */
  estimate(nowMs: number, moving: boolean | null): DeadReckoningEstimate | null {
    const route = this.route;
    const anchor = this.anchor;
    if (!route || !anchor || route.geometry.length < 2) return null;
    const dtS = Math.max(0, (nowMs - this.lastStepAt) / 1000);
    this.lastStepAt = nowMs;
    let speed: { mps: number; source: DrSpeedSource; errorShare: number };
    let step: number;
    const walking = this.steps && nowMs - this.steps.atMs <= 5_000;
    if (walking) {
      // Walking with the pedometer: metres actually walked, not speed × time.
      const prev = this.stepsAtLastEstimate ?? this.steps!.totalM;
      step = Math.max(0, this.steps!.totalM - prev);
      this.stepsAtLastEstimate = this.steps!.totalM;
      speed = { mps: dtS > 0 ? step / dtS : 0, source: "steps", errorShare: DR_PACE_ERROR_STEPS };
    } else {
      this.stepsAtLastEstimate = null;
      speed = this.chooseSpeed(nowMs, moving);
      step = speed.mps * dtS;
    }
    this.progressM = Math.min(route.distanceM, this.progressM + step);
    this.travelledSinceAnchorM += step;
    // The error share of the distance driven since the anchor, averaged over the sources used.
    if (step > 0) this.paceFactorNow = this.travelledSinceAnchorM > step ? (this.paceFactorNow * (this.travelledSinceAnchorM - step) + speed.errorShare * step) / this.travelledSinceAnchorM : speed.errorShare;
    const ageS = (nowMs - anchor.atMs) / 1000;
    // Along-route error: anchor error + a share of the distance (speed error)
    // + slow drift; an assumed pace is far less certain than a measured speed.
    const uncertaintyM = anchor.accuracyM + this.paceFactorNow * this.travelledSinceAnchorM + DR_DRIFT_MPS * ageS;
    this.lastUncertaintyM = uncertaintyM;
    const position = positionAtDistance(route.geometry, this.progressM);
    const ahead = positionAtDistance(route.geometry, Math.min(route.distanceM, this.progressM + 15));
    const headingDeg = haversineMeters(position, ahead) > 1 ? initialBearing(position, ahead) : 0;
    return { position, headingDeg, progressM: this.progressM, speedMps: speed.mps, uncertaintyM, ageS, anchorSource: anchor.source, speedSource: speed.source };
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

/** Share of the distance driven that becomes along-route error (trusted speed / assumed pace). */
export const DR_PACE_ERROR_TRUSTED = 0.1;
export const DR_PACE_ERROR_ASSUMED = 0.3;
/** The car's own speed (OBD) / pedometer steps / the driver's stated speed / traffic flow / learned speed of this place. */
export const DR_PACE_ERROR_VEHICLE = 0.03;
export const DR_PACE_ERROR_STEPS = 0.08;
export const DR_PACE_ERROR_DRIVER = 0.15;
export const DR_PACE_ERROR_TRAFFIC = 0.15;
export const DR_PACE_ERROR_LEARNED = 0.2;
/** Slow drift of the estimate per second, metres. */
export const DR_DRIFT_MPS = 0.5;

/** How fast the dead-reckoning error grows at a speed, metres per minute —
 * the same model as the estimate above (for "what if the signal is gone
 * for long?"). */
export function drErrorGrowthMPerMin(speedMps: number, speedTrusted: boolean): number {
  return 60 * ((speedTrusted ? DR_PACE_ERROR_TRUSTED : DR_PACE_ERROR_ASSUMED) * Math.max(0, speedMps) + DR_DRIFT_MPS);
}

/** Maps along-route uncertainty to a confidence value and band (never HIGH
 * without GNSS). */
export function deadReckoningConfidence(est: DeadReckoningEstimate): { value: number; band: "MEDIUM" | "LOW" | "UNKNOWN" } {
  if (est.ageS > DR_MAX_AGE_S || est.uncertaintyM > 600) return { value: 0.15, band: "UNKNOWN" };
  if (est.uncertaintyM <= 60) return { value: 0.6, band: "MEDIUM" };
  if (est.uncertaintyM <= 250) return { value: 0.4, band: "LOW" };
  return { value: 0.25, band: "LOW" };
}
