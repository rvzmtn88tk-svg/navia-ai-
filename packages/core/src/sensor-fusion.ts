// SensorFusionEngine — spec section 9 ("SENSOR FUSION").
//
// Spec text (paraphrased): don't do "magic AI"; build a v1 that does
// quality-aware weighted fusion of GNSS and dead-reckoning estimates, and
// reserve an Extended Kalman Filter with state vector [x,y,vx,vy,heading,
// gyroBias] for v2. This file implements v1 in full (weighted blend, with
// circular averaging for heading since bearings wrap at 360°) and provides
// the EKF class as an explicit, honestly-unimplemented placeholder — per
// section 40 ("NO FAKE DATA IN PRODUCTION PATH"), it throws rather than
// silently returning a plausible-looking fused position, because a real EKF
// needs IMU noise covariances calibrated against real device sensor data
// that this sandbox has no way to capture.
//
// v1 fuses directly in lat/lon space (a locally-linear approximation valid
// over the short distances — tens of meters — that separate a GNSS fix from
// a dead-reckoned estimate between fixes); it does not use the Cartesian
// [x,y] state vector the spec names for the EKF, since that projection is
// only needed once the EKF's process/measurement model is implemented.

import type {LatLon, TimestampMs} from "./types";

export type FusionSample = {
  position: LatLon;
  speedMps: number | null;
  headingDeg: number | null;
};

export type FusionInput = {
  /** Latest GNSS-derived estimate, or null during a GPS outage. */
  gnss: (FusionSample & {
    timestamp: TimestampMs;
    /** 0..1 trust score — typically 1 - GNSSMonitor's anomalyScore. */
    quality: number;
  }) | null;
  /** Latest dead-reckoning estimate propagated from the last trusted fix. */
  deadReckoned: FusionSample | null;
};

export type FusionSource = "GNSS" | "DEAD_RECKONING" | "FUSED";

export type FusedEstimate = {
  position: LatLon;
  speedMps: number | null;
  headingDeg: number | null;
  source: FusionSource;
  /** Weight actually applied to the GNSS sample, 0..1 (0 = pure DR, 1 = pure GNSS). */
  gnssWeight: number;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Weighted circular mean of two headings (degrees), so blending 350° and
 * 10° yields ~0°, not the wrong-answer ~180° a naive linear average gives. */
function blendHeadingDeg(a: number, b: number, weightA: number): number | null {
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const x = weightA * Math.cos(rad(a)) + (1 - weightA) * Math.cos(rad(b));
  const y = weightA * Math.sin(rad(a)) + (1 - weightA) * Math.sin(rad(b));
  if (x === 0 && y === 0) return null;
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export class SensorFusionEngine {
  /**
   * Fuse the latest GNSS and dead-reckoning estimates.
   * - GNSS only (DR unavailable, e.g. no prior trusted fix yet): pass GNSS through, weight 1.
   * - DR only (GPS outage, `gnss` is null): pass DR through, weight 0.
   * - Both present: quality-aware linear blend, weighted by `gnss.quality`.
   */
  fuse(input: FusionInput): FusedEstimate {
    const { gnss, deadReckoned } = input;

    if (!gnss && !deadReckoned) {
      throw new Error("SensorFusionEngine.fuse: need at least one of gnss or deadReckoned");
    }
    if (gnss && !deadReckoned) {
      return {
        position: gnss.position,
        speedMps: gnss.speedMps,
        headingDeg: gnss.headingDeg,
        source: "GNSS",
        gnssWeight: 1,
      };
    }
    if (!gnss && deadReckoned) {
      return {
        position: deadReckoned.position,
        speedMps: deadReckoned.speedMps,
        headingDeg: deadReckoned.headingDeg,
        source: "DEAD_RECKONING",
        gnssWeight: 0,
      };
    }

    // Both present (TS can't narrow the double-optional above through the throws, so assert).
    const g = gnss!;
    const dr = deadReckoned!;
    const w = clamp01(g.quality);

    const position: LatLon = {
      lat: g.position.lat * w + dr.position.lat * (1 - w),
      lon: g.position.lon * w + dr.position.lon * (1 - w),
    };

    const speedMps =
      g.speedMps == null && dr.speedMps == null
        ? null
        : (g.speedMps ?? dr.speedMps ?? 0) * w + (dr.speedMps ?? g.speedMps ?? 0) * (1 - w);

    const headingDeg =
      g.headingDeg == null
        ? dr.headingDeg
        : dr.headingDeg == null
          ? g.headingDeg
          : blendHeadingDeg(g.headingDeg, dr.headingDeg, w);

    const source: FusionSource = w >= 0.95 ? "GNSS" : w <= 0.05 ? "DEAD_RECKONING" : "FUSED";

    return { position, speedMps, headingDeg, source, gnssWeight: w };
  }
}

/**
 * v2 placeholder per spec section 9: "Следующая версия: Extended Kalman
 * Filter... Вынести EKF в отдельный класс." State vector [x,y,vx,vy,heading,
 * gyroBias] as specified. Left unimplemented on purpose — see file header —
 * rather than faked, so nothing downstream can mistake a stub for a working
 * filter.
 */
export class ExtendedKalmanFilterFusion {
  step(_gnss: unknown, _imu: unknown, _dtSeconds: number): never {
    throw new Error(
      "ExtendedKalmanFilterFusion (sensor-fusion v2) is not implemented. " +
      "SensorFusionEngine (weighted fusion v1) is the production path until " +
      "an EKF with real-device-calibrated noise covariances is built."
    );
  }
}
