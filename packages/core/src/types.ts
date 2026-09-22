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
    | "left"
    | "right"
    | "uturn"
    | "roundabout"
    | "arrive";
  distanceM: number;
  durationS: number;
  location: LatLon;
  bearingBefore?: number;
  bearingAfter?: number;
  roadSegmentId?: string;
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
  nearbyLandmarks: Landmark[];
  offRoute: boolean;
  networkAvailable: boolean;
  offlineMapAvailable: boolean;
  lastTrustedFixAt: TimestampMs | null;
  updatedAt: TimestampMs;
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
    | "ALERT";
  payload: Record<string, unknown>;
};
