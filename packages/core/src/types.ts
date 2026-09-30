// Core domain types, transcribed verbatim from
// CLAUDE_CODE_MASTER_PROMPT.md section 5 ("TYPESCRIPT DOMAIN TYPES"),
// plus NavigationEvent from section 32 ("LOGGING"). These are the shared
// vocabulary every engine module below is built against.

export type LatLon = {
  lat: number;
  lon: number;
};

export type TimestampMs = number;

export type Position = LatLon & {
  timestamp: TimestampMs;
  accuracyM: number | null;
  altitudeM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  source: "GNSS" | "DEAD_RECKONING" | "MAP_MATCH" | "FUSED";
};

export type GNSSSample = {
  position: LatLon;
  timestamp: TimestampMs;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
};

export type IMUSample = {
  timestamp: TimestampMs;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  magneticX?: number;
  magneticY?: number;
  magneticZ?: number;
};

export type GNSSIntegrityState =
  | "NORMAL"
  | "DEGRADED"
  | "LOST";

export type NavigationMode =
  | "IDLE"
  | "ROUTING"
  | "ACTIVE"
  | "GNSS_DEGRADED"
  | "GNSS_LOST"
  | "POSITION_UNCERTAIN"
  | "OFFLINE"
  | "OFF_ROUTE"
  | "RECOVERING"
  | "ARRIVED";

export type ConfidenceBand =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export type PositionEstimate = {
  position: Position;
  covariance?: number[][];
  confidence: number; // 0..1
  band: ConfidenceBand;
  source: Position["source"];
};

export type RoadSegment = {
  id: string;
  geometry: LatLon[];
  name?: string;
  ref?: string;
  roadClass?: string;
  speedLimitKph?: number;
  oneWay?: boolean;
};

export type RouteStep = {
  id: string;
  roadName: string;
  maneuver:
    | "depart"
    | "straight"
    | "slight_left"
    | "slight_right"
    | "left"
    | "right"
    | "sharp_left"
    | "sharp_right"
    | "uturn"
    | "roundabout"
    | "exit_left"
    | "exit_right"
    | "merge"
    | "arrive";
  /** Roundabout exit number (1 = first exit), when the router provides it. */
  roundaboutExit?: number;
  distanceM: number;
  durationS: number;
  location: LatLon;
  bearingBefore?: number;
  bearingAfter?: number;
  roadSegmentId?: string;
  /** Index of the maneuver point in `route.geometry` (Valhalla's
   * begin_shape_index). When every step has it, route progress places the
   * maneuvers on the line itself instead of adding up the router's rounded
   * leg lengths (which drift from the geometry by tens of metres). */
  geometryIndex?: number;
};

export type Landmark = {
  id: string;
  name: string;
  type: string;
  location: LatLon;
  sideOfRoad?: "left" | "right" | "ahead";
  distanceM: number;
  routeRelevance: number;
  brand?: string;
};

export type NavigationState = {
  mode: NavigationMode;
  position: PositionEstimate | null;
  trustedPosition: PositionEstimate | null;
  gnss: GNSSIntegrityState;
  confidence: number;
  confidenceBand: ConfidenceBand;
  speedMps: number | null;
  headingDeg: number | null;
  routeProgressM: number;
  routeRemainingM: number;
  nextStep: RouteStep | null;
  /** Computed live distance to the next maneuver, not the original leg length. */
  nextStepDistanceM?: number | null;
  /** Computed ETA from route duration and current progress/speed. */
  etaSeconds?: number | null;
  nearbyLandmarks: Landmark[];
  offRoute: boolean;
  networkAvailable: boolean;
  offlineMapAvailable: boolean;
  lastTrustedFixAt: TimestampMs | null;
  /** How the shown position is produced while a route is active: GNSS, dead
   * reckoning along the route, or a user-placed start. */
  positionMode?: "GNSS" | "DEAD_RECKONING" | "MANUAL" | null;
  /** Along-route uncertainty in metres while not on GNSS (grows over time). */
  positionUncertaintyM?: number | null;
  /** GNSS has consistently reported a place far from the dead-reckoned one
   * for a few seconds: either a real correction or spoofing — ask the user. */
  gnssConflict?: { distanceM: number; sinceMs: TimestampMs } | null;
  /** Early warning: how the fix stream behaves (see gnss-trend.ts). */
  gnssTrend?: {
    level: "stable" | "degrading" | "lost";
    reasons: ("accuracy_poor" | "accuracy_rising" | "fixes_slowing" | "fix_overdue" | "no_fix")[];
    sinceLastFixMs: number | null;
    expectedIntervalMs: number;
    accuracyM: number | null;
  } | null;
  updatedAt: TimestampMs;
  /** Distance from the current position to `nextStep`'s maneuver, metres (when known). */
  nextManeuverDistanceM?: number | null;
  /** GNSS-independent positioning detail, when the resilient navigator is running. */
  positioning?: ResilientPositioning;
};

/** How the position is being determined when GNSS may be jammed or spoofed. */
export type ResilientPositioning = {
  /** GNSS = following fixes; FUSED = fixes blended with motion; DEAD_RECKONING = no usable GNSS, road + gyro + speed model only. */
  source: "GNSS" | "FUSED" | "DEAD_RECKONING";
  /** OK / DEGRADED / LOST, or REJECTED: fixes arrive but contradict the car's measured motion. */
  gnssVerdict: "OK" | "DEGRADED" | "LOST" | "REJECTED";
  /** Fixes have contradicted motion for a while — interference or spoofing is likely. */
  gnssSuspectedSpoofing: boolean;
  /** One-sigma position uncertainty, metres. */
  uncertaintyM: number;
  /** One-sigma uncertainty of the distance to the next maneuver, metres. */
  maneuverUncertaintyM: number | null;
  /** Probability the car is still on the planned route. */
  onRouteProbability: number;
  /** Motion sensors (gyro/accelerometer) are feeding the navigator. */
  imuAvailable: boolean;
  /** Seconds since the last GNSS fix the navigator accepted, null if none yet. */
  secondsSinceTrustedFix: number | null;
  /** PRECISE / REDUCED_ACCURACY / STALE / UNSTABLE / LOST / SPOOFED / RECOVERED (see LocationStateTracker). */
  locationState: "PRECISE" | "REDUCED_ACCURACY" | "STALE" | "UNSTABLE" | "LOST" | "SPOOFED" | "RECOVERED";
  /** How maneuvers may be announced from this position: exact distances, approximate ones, or none (don't guess). */
  guidance: "exact" | "approximate" | "none";
  /** 0..1 location confidence, falling with uncertainty. */
  locationConfidence: number;
  /** Last reliable (accepted-GNSS) position; for the app/map only, never sent to the AI. */
  lastReliablePosition: LatLon | null;
};

// Section 32 (LOGGING): every navigation event gets one of these.
export type NavigationEvent = {
  timestamp: number;
  type:
    | "GNSS_FIX"
    | "GNSS_DEGRADED"
    | "GNSS_LOST"
    | "MAP_MATCH"
    | "ROUTE_UPDATE"
    | "OFF_ROUTE"
    | "RECOVERY"
    | "LANDMARK"
    | "VOICE"
    | "ALERT"
    | "DEAD_RECKONING"
    | "SPOOF_SUSPECT"
    | "MANUAL_POSITION";
  payload: Record<string, unknown>;
};
