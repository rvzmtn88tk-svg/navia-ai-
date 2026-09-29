// MotionPreprocessor — turns raw phone IMU samples (any mounting, ~10 Hz)
// into the per-second NavigatorMotion summary the ResilientNavigator uses:
//   - yaw rate about the VERTICAL axis: the gyro vector projected on the
//     gravity direction, so it works whether the phone lies flat, stands in a
//     holder or leans against the console;
//   - motion roughness: the standard deviation of |acceleration| over the
//     last second (a parked car is far smoother than a moving one).
//
// Two things differ between phones/platforms and mounts and are LEARNED
// while GNSS is healthy instead of being assumed:
//   - the sign convention of "up" in the accelerometer (iOS and Android
//     report gravity with opposite signs): learned by comparing integrated
//     yaw with GNSS course changes through real turns;
//   - the vibration level that separates "stopped" from "moving": learned
//     from accelerometer roughness at GNSS-reported standstill vs. driving,
//     and rescaled so the navigator's fixed threshold applies.
// Until enough evidence is collected the platform default is used.

import type { IMUSample } from "../types";
import type { NavigatorMotion } from "./resilient-navigator";
import { wrapDeg } from "./road-network";

export type MotionPreprocessorOptions = {
  /** Accelerometer units → m/s². expo-sensors reports g. */
  accelScale?: number;
  /** Gyro units → deg/s. expo-sensors reports rad/s. */
  gyroScale?: number;
  /** Initial guess: +1 if the accelerometer at rest points UP (reaction to gravity), −1 if it points down. */
  upSign?: 1 | -1;
  /** The navigator's stationary threshold (m/s²) that output roughness is scaled to. */
  navigatorStationaryThreshold?: number;
};

const G = 9.80665;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]!;
}

export class MotionPreprocessor {
  private accelScale: number;
  private gyroScale: number;
  private upSign: 1 | -1;
  private signVotes = 0;
  private navThreshold: number;

  private gravity: { x: number; y: number; z: number } | null = null;
  private windowStartMs: number | null = null;
  private yawSum = 0;
  private yawDt = 0;
  private lastSampleMs: number | null = null;
  private mags: number[] = [];

  private idleRough: number[] = [];
  private movingRough: number[] = [];
  private lastRawRough: number | null = null;

  // Sign learning: integrated yaw vs. GNSS course over the same interval.
  private yawIntegral = 0;
  private courseRef: { course: number; yaw: number; t: number } | null = null;

  constructor(options: MotionPreprocessorOptions = {}) {
    this.accelScale = options.accelScale ?? G;
    this.gyroScale = options.gyroScale ?? 180 / Math.PI;
    this.upSign = options.upSign ?? 1;
    this.navThreshold = options.navigatorStationaryThreshold ?? 0.1;
  }

  /** Feed one raw IMU sample. Returns a per-second summary when a second has elapsed, else null. */
  push(s: IMUSample): NavigatorMotion | null {
    const ax = s.accelX * this.accelScale, ay = s.accelY * this.accelScale, az = s.accelZ * this.accelScale;
    // Low-pass the accelerometer to track the gravity direction (τ ≈ 2 s at 10 Hz).
    if (!this.gravity) this.gravity = { x: ax, y: ay, z: az };
    else {
      const k = 0.05;
      this.gravity = { x: this.gravity.x + k * (ax - this.gravity.x), y: this.gravity.y + k * (ay - this.gravity.y), z: this.gravity.z + k * (az - this.gravity.z) };
    }
    const gn = Math.hypot(this.gravity.x, this.gravity.y, this.gravity.z) || 1;
    const ux = (this.upSign * this.gravity.x) / gn, uy = (this.upSign * this.gravity.y) / gn, uz = (this.upSign * this.gravity.z) / gn;
    // Rotation about "up", counter-clockwise positive (right-hand rule) → clockwise (compass) positive.
    const yawDps = -(s.gyroX * ux + s.gyroY * uy + s.gyroZ * uz) * this.gyroScale;
    const dt = this.lastSampleMs == null ? 0 : Math.max(0, Math.min(0.5, (s.timestamp - this.lastSampleMs) / 1000));
    this.lastSampleMs = s.timestamp;
    this.yawSum += yawDps * dt;
    this.yawDt += dt;
    this.yawIntegral += yawDps * dt;
    this.mags.push(Math.hypot(ax, ay, az));

    if (this.windowStartMs == null) this.windowStartMs = s.timestamp;
    if (s.timestamp - this.windowStartMs < 1000) return null;

    const mean = this.mags.reduce((a, b) => a + b, 0) / this.mags.length;
    const rough = Math.sqrt(this.mags.reduce((a, b) => a + (b - mean) ** 2, 0) / this.mags.length);
    const yawRate = this.yawDt > 0 ? this.yawSum / this.yawDt : 0;
    this.windowStartMs = s.timestamp;
    this.yawSum = 0; this.yawDt = 0; this.mags = [];
    this.lastRawRough = rough;
    return { yawRateDps: yawRate, accelStd: rough * this.roughScale() };
  }

  /**
   * Feed a TRUSTED GNSS fix (while GNSS is healthy). Used only to learn the
   * mounting-dependent calibration; the navigator itself gets fixes directly.
   */
  observeGnss(tMs: number, speedMps: number | null, courseDeg: number | null): void {
    if (this.lastRawRough != null && speedMps != null) {
      if (speedMps < 0.3) this.idleRough.push(this.lastRawRough);
      else if (speedMps > 5) this.movingRough.push(this.lastRawRough);
      if (this.idleRough.length > 200) this.idleRough.shift();
      if (this.movingRough.length > 200) this.movingRough.shift();
    }
    if (courseDeg == null || speedMps == null || speedMps < 5) { this.courseRef = null; return; }
    if (!this.courseRef) { this.courseRef = { course: courseDeg, yaw: this.yawIntegral, t: tMs }; return; }
    const dCourse = wrapDeg(courseDeg - this.courseRef.course);
    const dYaw = this.yawIntegral - this.courseRef.yaw;
    if ((tMs - this.courseRef.t) / 1000 > 15) { this.courseRef = { course: courseDeg, yaw: this.yawIntegral, t: tMs }; return; }
    if (Math.abs(dCourse) >= 40 && Math.abs(Math.abs(dYaw) - Math.abs(dCourse)) < 25) {
      // A real turn seen by both: do the signs agree?
      const agree = Math.sign(dCourse) === Math.sign(dYaw);
      this.signVotes += agree ? 1 : -1;
      if (this.signVotes <= -2) { this.upSign = this.upSign === 1 ? -1 : 1; this.signVotes = 0; }
      this.signVotes = Math.max(-2, Math.min(5, this.signVotes));
      this.courseRef = { course: courseDeg, yaw: this.yawIntegral, t: tMs };
    }
  }

  /** Scale so that the learned stopped/moving boundary maps to the navigator's threshold. */
  private roughScale(): number {
    if (this.idleRough.length < 10 || this.movingRough.length < 10) return 1;
    const idle = median(this.idleRough), moving = median(this.movingRough);
    if (!(moving > idle * 1.3)) return 1; // not separable on this mount: keep the default
    const boundary = Math.sqrt(Math.max(1e-4, idle) * moving);
    return this.navThreshold / boundary;
  }

  /** Calibration state, for diagnostics/telemetry. */
  getCalibration(): { upSign: 1 | -1; signConfirmed: boolean; roughnessCalibrated: boolean } {
    return { upSign: this.upSign, signConfirmed: this.signVotes >= 2, roughnessCalibrated: this.roughScale() !== 1 };
  }
}
