// Fused heading for "me on the map": compass (magnetometer, via iOS
// CoreLocation heading) + gyroscope. The gyroscope's rotation about the
// vertical axis is integrated on every motion sample (≈60 Hz), so turning the
// phone moves the marker immediately; each compass reading pulls the result
// back towards magnetic truth (no gyro drift). GPS course is used ONLY when no
// fresh compass reading exists (e.g. the simulator, or compass unavailable).
// Pure; unit-tested.

export type HeadingSource = "COMPASS" | "GPS_COURSE_FALLBACK";
export type FusedHeadingOut = { deg: number | null; source: HeadingSource | null };

/** Rotation rate about the vertical, clockwise-positive (deg/s), from a
 * device-frame rotation rate (deg/s) and the gravity vector (any units,
 * pointing to the Earth). Works in any phone orientation (flat, in a mount). */
export function yawRateFromMotion(rate: { x: number; y: number; z: number }, gravity: { x: number; y: number; z: number }): number | null {
  const g = Math.hypot(gravity.x, gravity.y, gravity.z);
  if (!Number.isFinite(g) || g < 1e-6) return null;
  // Right-hand rule about "up" (= -gravity) is counter-clockwise from above;
  // compass headings grow clockwise, hence the projection onto +gravity.
  return (rate.x * gravity.x + rate.y * gravity.y + rate.z * gravity.z) / g;
}

export function wrap360(d: number): number {
  return ((d % 360) + 360) % 360;
}

function diff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180; // a - b in -180..180
}

export type HeadingFusionConfig = {
  /** Share of the compass/gyro disagreement corrected per compass reading. */
  compassGain: number;
  /** Disagreement above this snaps to the compass (re-initialise). */
  snapDeg: number;
  compassMaxAgeMs: number;
  compassMaxErrorDeg: number;
  courseMinSpeedMps: number;
};

const DEFAULTS: HeadingFusionConfig = { compassGain: 0.2, snapDeg: 60, compassMaxAgeMs: 2000, compassMaxErrorDeg: 45, courseMinSpeedMps: 1 };

export class HeadingFusion {
  private cfg: HeadingFusionConfig;
  private heading: number | null = null;
  private lastGyroAt: number | null = null;
  private lastCompassAt: number | null = null;
  private course: { deg: number; speedMps: number | null; at: number } | null = null;

  constructor(config: Partial<HeadingFusionConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** One motion sample: clockwise yaw rate (deg/s) at `tMs`. */
  onGyro(yawRateDegS: number | null, tMs: number): void {
    if (yawRateDegS != null && Number.isFinite(yawRateDegS) && this.heading != null && this.lastGyroAt != null) {
      const dt = (tMs - this.lastGyroAt) / 1000;
      if (dt > 0 && dt < 0.5) this.heading = wrap360(this.heading + yawRateDegS * dt);
    }
    this.lastGyroAt = tMs;
  }

  /** One compass reading (true heading, degrees) with iOS accuracy (deg; null/negative = unknown). */
  onCompass(deg: number, accuracyDeg: number | null, tMs: number): void {
    if (!Number.isFinite(deg)) return;
    if (accuracyDeg != null && accuracyDeg >= 0 && accuracyDeg > this.cfg.compassMaxErrorDeg) return;
    const target = wrap360(deg);
    // Without a live gyro stream there is nothing to blend: take the compass as is.
    const gyroLive = this.lastGyroAt != null && tMs - this.lastGyroAt <= 200;
    if (!gyroLive || this.heading == null || Math.abs(diff(target, this.heading)) > this.cfg.snapDeg || this.lastCompassAt == null || tMs - this.lastCompassAt > this.cfg.compassMaxAgeMs) {
      this.heading = target;
    } else {
      this.heading = wrap360(this.heading + this.cfg.compassGain * diff(target, this.heading));
    }
    this.lastCompassAt = tMs;
  }

  /** GPS course over ground (fallback only). */
  onCourse(deg: number | null, speedMps: number | null, tMs: number): void {
    this.course = deg != null && Number.isFinite(deg) ? { deg: wrap360(deg), speedMps, at: tMs } : null;
  }

  current(tMs: number): FusedHeadingOut {
    if (this.heading != null && this.lastCompassAt != null && tMs - this.lastCompassAt <= this.cfg.compassMaxAgeMs) {
      return { deg: this.heading, source: "COMPASS" };
    }
    const c = this.course;
    if (c && (c.speedMps == null || c.speedMps >= this.cfg.courseMinSpeedMps)) return { deg: c.deg, source: "GPS_COURSE_FALLBACK" };
    return { deg: null, source: null };
  }

  reset(): void {
    this.heading = null;
    this.lastGyroAt = null;
    this.lastCompassAt = null;
    this.course = null;
  }
}
