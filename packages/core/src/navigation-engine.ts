// NavigationEngine — the top-level orchestrator named first in spec
// section 4's core-module list. This is the REAL-sensor counterpart to
// DemoEngine: DemoEngine synthesizes GNSS/IMU samples for Demo Mode;
// NavigationEngine only ever runs on samples the caller pushes in from
// actual device sensors (ExpoLocationPositionProvider/
// ExpoSensorsMotionProvider in apps/mobile). Both run the exact same
// downstream pipeline (GNSSMonitor -> SensorFusionEngine ->
// RouteProgressEngine -> OffRouteDetector -> NavigationStateMachine) —
// this class exists so that pipeline lives in ONE place, and mobile
// screens only push samples in and read NavigationState out, per the
// spec's repeated "screens must not duplicate navigation logic" rule
// (sections 5's structure and section 26's Demo Mode rule apply here too).
//
// Real-world GNSS loss is a STALENESS condition — no new fix arriving —
// not a property of the last fix itself, so tick(nowMs) (called on a
// regular clock by the caller, independent of when fixes arrive) is what
// actually declares GNSS_LOST once `staleAfterMs` has passed since the last
// sample, and keeps advancing a dead-reckoned position in the meantime.

import type {
  LatLon, NavigationState, GNSSIntegrityState, ConfidenceBand, TimestampMs, IMUSample,
} from "./types";
import type { GNSSRawSample, GNSSConfig } from "./gnss-monitor";
import { GNSSMonitor } from "./gnss-monitor";
import { deadReckon } from "./dead-reckoning";
import { calculateConfidence } from "./confidence";
import { SensorFusionEngine } from "./sensor-fusion";
import type { Route, RoutingProvider } from "./route-engine";
import { RouteProgressEngine, distanceFromRouteCorridorM } from "./route-engine";
import { OffRouteDetector } from "./off-route-detector";
import { NavigationStateMachine } from "./navigation-state-machine";
import { TelemetryLogger } from "./telemetry-logger";

const DEFAULT_GNSS_CONFIG: GNSSConfig = {
  maxPlausibleSpeedMps: 45, maxJumpM: 150, maxFreshAgeMs: 6000, accuracyGoodM: 10, accuracyBadM: 80,
};

export type NavigationEngineOptions = {
  routingProvider: RoutingProvider;
  gnssConfig?: Partial<GNSSConfig>;
  /** How long with no new GNSS fix before declaring GNSS_LOST (staleness, not sample quality). */
  staleAfterMs?: number;
};

function idleState(): NavigationState {
  return {
    mode: "IDLE", position: null, trustedPosition: null, gnss: "NORMAL",
    confidence: 0, confidenceBand: "UNKNOWN", speedMps: null, headingDeg: null,
    routeProgressM: 0, routeRemainingM: 0, nextStep: null, nearbyLandmarks: [],
    offRoute: false, networkAvailable: true, offlineMapAvailable: false,
    lastTrustedFixAt: null, updatedAt: 0,
  };
}

function baseSmInput(overrides: Partial<{
  gnssIntegrity: GNSSIntegrityState; confidenceBand: ConfidenceBand; offRouteConfirmed: boolean;
  hasArrived: boolean; routeRequested: boolean; routeReady: boolean;
}>) {
  return {
    gnssIntegrity: "NORMAL" as GNSSIntegrityState, confidenceBand: "HIGH" as ConfidenceBand,
    offRouteConfirmed: false, hasArrived: false, routeRequested: false, routeReady: false,
    ...overrides,
  };
}

export class NavigationEngine {
  private routingProvider: RoutingProvider;
  private gnssMonitor: GNSSMonitor;
  private staleAfterMs: number;
  private fusion = new SensorFusionEngine();
  private progressEngine = new RouteProgressEngine();
  private offRouteDetector = new OffRouteDetector();
  private stateMachine = new NavigationStateMachine();
  private telemetry = new TelemetryLogger(20_000);

  private route: Route | null = null;
  private lastGnssRaw: GNSSRawSample | null = null;
  private lastGnssIntegrity: { trusted: boolean; anomalyScore: number; freshnessScore: number } | null = null;
  private lastTrustedPosition: NavigationState["trustedPosition"] = null;
  private lastImuSample: IMUSample | null = null;
  private networkAvailable = true;
  private currentState: NavigationState = idleState();

  constructor(options: NavigationEngineOptions) {
    this.routingProvider = options.routingProvider;
    this.gnssMonitor = new GNSSMonitor({ ...DEFAULT_GNSS_CONFIG, ...options.gnssConfig });
    this.staleAfterMs = options.staleAfterMs ?? 6000;
  }

  getState(): NavigationState { return this.currentState; }
  getRoute(): Route | null { return this.route; }
  getTelemetry(): TelemetryLogger { return this.telemetry; }
  setNetworkAvailable(v: boolean): void { this.networkAvailable = v; }

  /** Request a real route from the configured RoutingProvider. Rejects
   * honestly (no silent demo fallback — spec section 40/user's explicit
   * "don't switch to DemoRoutingProvider and call it real") if the
   * provider fails (e.g. Valhalla endpoint unreachable). */
  async requestRoute(origin: LatLon, destination: LatLon): Promise<Route> {
    const route = await this.routingProvider.route({ origin, destination });
    this.route = route;
    this.offRouteDetector.reset();
    this.telemetry.log("ROUTE_UPDATE", { distanceM: route.distanceM, source: route.source }, Date.now());
    this.stateMachine.tick(baseSmInput({ routeRequested: true }));
    this.stateMachine.tick(baseSmInput({ routeReady: true }));
    return route;
  }

  clearRoute(): void {
    this.route = null;
  }

  pushImuSample(sample: IMUSample): void {
    this.lastImuSample = sample;
  }
  getLastImuSample(): IMUSample | null {
    return this.lastImuSample;
  }

  /** Feed one real GNSS fix (from ExpoLocationPositionProvider). Runs
   * GNSSMonitor immediately; the resulting NavigationState comes from the
   * next tick() call, same clock-driven design as staleness detection. */
  pushGnssSample(sample: GNSSRawSample): void {
    const integrity = this.gnssMonitor.evaluate(this.lastGnssRaw, sample, sample.timestamp);
    this.lastGnssRaw = sample;
    this.lastGnssIntegrity = integrity;
    this.telemetry.log("GNSS_FIX", { accuracyM: sample.accuracyM, trusted: integrity.trusted }, sample.timestamp);
  }

  /** Advance the engine's state to `nowMs`. Call this on a regular clock
   * (e.g. every ~1s) independent of when GNSS fixes arrive — this is what
   * actually detects GNSS_LOST via staleness and keeps a dead-reckoned
   * position moving between fixes. */
  tick(nowMs: TimestampMs = Date.now()): NavigationState {
    const ageMs = this.lastGnssRaw ? nowMs - this.lastGnssRaw.timestamp : Infinity;
    const isStale = ageMs > this.staleAfterMs;

    const gnssIntegrityState: GNSSIntegrityState = !this.lastGnssRaw
      ? "LOST"
      : isStale
        ? "LOST"
        : this.lastGnssIntegrity?.trusted
          ? "NORMAL"
          : "DEGRADED";

    if (gnssIntegrityState === "LOST" && this.currentState.gnss !== "LOST") {
      this.telemetry.log("GNSS_LOST", { ageMs }, nowMs);
    }

    // Position: fresh trusted GNSS -> fuse with DR; stale/no GNSS -> pure DR
    // from the last trusted fix; nothing yet -> no position at all (honest,
    // not a fabricated 0,0).
    let fusedPosition: LatLon | null = null;
    let fusedSpeedMps: number | null = null;
    let fusedHeadingDeg: number | null = null;
    let positionSource: "GNSS" | "DEAD_RECKONING" | "FUSED" | null = null;

    if (this.lastGnssRaw && !isStale && this.lastGnssIntegrity) {
      const gnssQuality = 1 - this.lastGnssIntegrity.anomalyScore;
      const dr = this.lastTrustedPosition
        ? deadReckon({
            position: this.lastTrustedPosition.position,
            speedMps: this.lastGnssRaw.speedMps ?? 0,
            headingDeg: this.lastGnssRaw.headingDeg ?? 0,
            dtSeconds: Math.max(0, (this.lastGnssRaw.timestamp - this.lastTrustedPosition.position.timestamp) / 1000),
          })
        : { lat: this.lastGnssRaw.lat, lon: this.lastGnssRaw.lon };
      const fused = this.fusion.fuse({
        gnss: {
          position: { lat: this.lastGnssRaw.lat, lon: this.lastGnssRaw.lon },
          speedMps: this.lastGnssRaw.speedMps, headingDeg: this.lastGnssRaw.headingDeg,
          timestamp: this.lastGnssRaw.timestamp, quality: gnssQuality,
        },
        deadReckoned: { position: dr, speedMps: this.lastGnssRaw.speedMps, headingDeg: this.lastGnssRaw.headingDeg },
      });
      fusedPosition = fused.position;
      fusedSpeedMps = fused.speedMps;
      fusedHeadingDeg = fused.headingDeg;
      positionSource = fused.source;
      if (this.lastGnssIntegrity.trusted) {
        this.lastTrustedPosition = {
          position: { ...fused.position, timestamp: nowMs, accuracyM: this.lastGnssRaw.accuracyM, source: "GNSS" },
          confidence: 0, band: "UNKNOWN", source: "GNSS", // confidence filled in below once computed
        };
      }
    } else if (this.lastTrustedPosition) {
      // Stale or lost — pure dead reckoning forward from the last trusted fix.
      const dtSeconds = Math.max(0, (nowMs - this.lastTrustedPosition.position.timestamp) / 1000);
      fusedPosition = deadReckon({
        position: this.lastTrustedPosition.position,
        speedMps: this.lastGnssRaw?.speedMps ?? 0,
        headingDeg: this.lastGnssRaw?.headingDeg ?? this.currentState.headingDeg ?? 0,
        dtSeconds,
      });
      fusedSpeedMps = this.lastGnssRaw?.speedMps ?? null;
      fusedHeadingDeg = this.lastGnssRaw?.headingDeg ?? this.currentState.headingDeg;
      positionSource = "DEAD_RECKONING";
    }

    const gnssQuality = this.lastGnssIntegrity ? 1 - this.lastGnssIntegrity.anomalyScore : 0;
    const freshness = gnssIntegrityState === "LOST" ? 0 : (this.lastGnssIntegrity?.freshnessScore ?? 0);
    const route = this.route;
    let distanceOffRouteM = 0;
    if (route && fusedPosition) distanceOffRouteM = distanceFromRouteCorridorM(route, fusedPosition);

    const confidence = calculateConfidence({
      gnssQuality, freshness,
      sensorAgreement: this.lastImuSample ? 0.85 : 0.5, // no live sensor data yet -> honestly lower, not faked high
      mapMatchQuality: gnssIntegrityState === "LOST" ? 0.3 : route ? 0.85 : 0.5,
      routeConsistency: route ? Math.max(0, 1 - distanceOffRouteM / 200) : 0.5,
    });

    if (this.lastTrustedPosition && this.lastTrustedPosition.confidence === 0) {
      this.lastTrustedPosition = { ...this.lastTrustedPosition, confidence: confidence.value, band: confidence.band };
    }

    const progress = route && fusedPosition ? this.progressEngine.computeProgress(route, fusedPosition, fusedSpeedMps) : null;
    const offRouteConfirmed = route && fusedPosition
      ? this.offRouteDetector.update({ distanceFromRouteM: distanceOffRouteM, roadMismatch: false, headingMismatchDeg: null, timestamp: nowMs })
      : false;
    if (offRouteConfirmed && !this.currentState.offRoute) this.telemetry.log("OFF_ROUTE", { distanceOffRouteM }, nowMs);

    const hasArrived = progress != null && progress.distanceRemainingM < 10;

    const mode = this.stateMachine.tick({
      gnssIntegrity: gnssIntegrityState,
      confidenceBand: confidence.band,
      offRouteConfirmed,
      hasArrived,
      routeRequested: false,
      routeReady: false,
    });
    if (mode === "RECOVERING" && this.currentState.mode !== "RECOVERING") this.telemetry.log("RECOVERY", {}, nowMs);

    this.currentState = {
      mode,
      position: fusedPosition && positionSource
        ? { position: { ...fusedPosition, timestamp: nowMs, accuracyM: this.lastGnssRaw?.accuracyM ?? null, source: positionSource }, confidence: confidence.value, band: confidence.band, source: positionSource }
        : null,
      trustedPosition: this.lastTrustedPosition,
      gnss: gnssIntegrityState,
      confidence: confidence.value,
      confidenceBand: confidence.band,
      speedMps: fusedSpeedMps,
      headingDeg: fusedHeadingDeg,
      routeProgressM: progress?.distanceCompletedM ?? 0,
      routeRemainingM: progress?.distanceRemainingM ?? (route?.distanceM ?? 0),
      nextStep: progress?.nextStep ?? route?.steps[0] ?? null,
      nearbyLandmarks: [],
      offRoute: offRouteConfirmed,
      networkAvailable: this.networkAvailable,
      offlineMapAvailable: false,
      lastTrustedFixAt: this.lastTrustedPosition?.position.timestamp ?? null,
      updatedAt: nowMs,
    };
    return this.currentState;
  }
}
