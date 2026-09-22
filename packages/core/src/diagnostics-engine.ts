// DiagnosticsEngine — spec section 31 ("TELEMETRY / DEBUG").
// "Create developer diagnostics screen... This screen is for developers,
// not the driver." This module only assembles the snapshot object from real
// inputs the caller supplies (from GNSSMonitor, PositionEstimate, etc.) —
// it never estimates or fabricates a field; anything unavailable is null.

import type { GNSSIntegrityState, ConfidenceBand, TimestampMs } from "./types";

export type DiagnosticsInput = {
  gpsAccuracyM: number | null;
  gpsSpeedMps: number | null;
  gpsHeadingDeg: number | null;
  gnssState: GNSSIntegrityState;
  anomalyScore: number | null;
  trustedPositionAt: TimestampMs | null;
  deadReckoningActiveSince: TimestampMs | null;
  mapMatchScore: number | null;
  currentRoadName: string | null;
  routeDistanceRemainingM: number | null;
  confidence: number;
  confidenceBand: ConfidenceBand;
  sensorsAvailable: { gnss: boolean; accelerometer: boolean; gyroscope: boolean; magnetometer: boolean };
  networkAvailable: boolean;
  offlinePackageState: "not_downloaded" | "downloading" | "ready" | "unavailable";
};

export type DiagnosticsSnapshot = DiagnosticsInput & {
  trustedPositionAgeMs: number | null;
  deadReckoningAgeMs: number | null;
  capturedAt: TimestampMs;
};

export class DiagnosticsEngine {
  snapshot(input: DiagnosticsInput, now: TimestampMs = Date.now()): DiagnosticsSnapshot {
    return {
      ...input,
      trustedPositionAgeMs: input.trustedPositionAt != null ? now - input.trustedPositionAt : null,
      deadReckoningAgeMs: input.deadReckoningActiveSince != null ? now - input.deadReckoningActiveSince : null,
      capturedAt: now,
    };
  }
}
