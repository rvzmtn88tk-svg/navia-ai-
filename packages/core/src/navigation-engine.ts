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
import type { Route, RoutingProvider, RoutePreferences } from "./route-engine";
import { RouteProgressEngine, distanceFromRouteCorridorM } from "./route-engine";
import { OffRouteDetector } from "./off-route-detector";
import { NavigationStateMachine } from "./navigation-state-machine";
import { TelemetryLogger } from "./telemetry-logger";
import { RoadNetwork } from "./resilient/road-network";
import { ResilientNavigator, type ResilientConfig, type NavigatorEstimate, type NavigatorMotion } from "./resilient/resilient-navigator";
import { MotionPreprocessor, type MotionPreprocessorOptions } from "./resilient/motion-preprocessor";
import { rerouteOriginAhead, prependCurrentRoad } from "./resilient/reroute";
import { haversineMeters } from "./geodesy";

const DEFAULT_GNSS_CONFIG: GNSSConfig = {
  maxPlausibleSpeedMps: 45, maxJumpM: 150, maxFreshAgeMs: 6000, accuracyGoodM: 10, accuracyBadM: 80,
};

export type ResilientNavigationOptions = {
  /**
   * The road graph around the route (offline map package), so the navigator
   * can follow the car through junctions it takes off the route without
   * GNSS. When absent, the route itself is used as the road network: the car
   * is still tracked along the route through GNSS outages and spoofing, and
   * leaving the route is detected from GNSS fixes the gyro confirms.
   */
  networkForRoute?: (route: Route) => RoadNetwork | null;
  config?: Partial<ResilientConfig>;
  motion?: MotionPreprocessorOptions;
};

export type NavigationEngineOptions = {
  routingProvider: RoutingProvider;
  gnssConfig?: Partial<GNSSConfig>;
  /** How long with no new GNSS fix before declaring GNSS_LOST (staleness, not sample quality). */
  staleAfterMs?: number;
  /**
   * Keep navigating to the destination when GNSS is jammed, degraded or
   * spoofed (ResilientNavigator: road-constrained particle filter + gyro +
   * accelerometer). Off by default so the classic pipeline's behaviour is
   * unchanged for callers that don't opt in.
   */
  resilient?: ResilientNavigationOptions | boolean;
};

const BAND_CONFIDENCE: Record<ConfidenceBand, number> = { HIGH: 0.9, MEDIUM: 0.65, LOW: 0.35, UNKNOWN: 0.1 };

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

  // Resilient (GNSS-independent) navigation.
  private resilientOptions: ResilientNavigationOptions | null;
  private resilient: ResilientNavigator | null = null;
  /** The resilient network is the route polyline only (no side roads). */
  private resilientRouteOnly = false;
  private motionPre: MotionPreprocessor | null = null;
  private pendingMotion: NavigatorMotion[] = [];
  private lastImuAtMs: number | null = null;
  private lastResilientStepMs: number | null = null;
  private lastFedGnssTs: number | null = null;
  private lastEstimate: NavigatorEstimate | null = null;

  constructor(options: NavigationEngineOptions) {
    this.routingProvider = options.routingProvider;
    this.gnssMonitor = new GNSSMonitor({ ...DEFAULT_GNSS_CONFIG, ...options.gnssConfig });
    this.staleAfterMs = options.staleAfterMs ?? 6000;
    this.resilientOptions = options.resilient === true ? {} : options.resilient ? options.resilient : null;
    if (this.resilientOptions) this.motionPre = new MotionPreprocessor(this.resilientOptions.motion);
  }

  /** The resilient navigator's latest estimate (null when disabled or no route). */
  getResilientEstimate(): NavigatorEstimate | null { return this.resilient ? this.lastEstimate : null; }

  /**
   * Where a reroute should start. With the resilient navigator tracking the
   * car off the route without GNSS, that's the next junction ahead of it on
   * the road it is on; otherwise the current position.
   */
  getRerouteOrigin(): LatLon | null {
    const est = this.lastEstimate;
    if (this.resilient && est?.offRouteEdge && !this.resilientRouteOnly) {
      return rerouteOriginAhead(this.resilient.net, est.offRouteEdge.edge, est.offRouteEdge.offset).ahead;
    }
    const p = this.currentState.position?.position;
    return p ? { lat: p.lat, lon: p.lon } : null;
  }

  getState(): NavigationState { return this.currentState; }
  getRoute(): Route | null { return this.route; }
  getTelemetry(): TelemetryLogger { return this.telemetry; }
  setNetworkAvailable(v: boolean): void { this.networkAvailable = v; }

  /** Request a real route from the configured RoutingProvider. Rejects
   * honestly (no silent demo fallback — spec section 40/user's explicit
   * "don't switch to DemoRoutingProvider and call it real") if the
   * provider fails (e.g. Valhalla endpoint unreachable). */
  async requestRoute(
    origin: LatLon,
    destination: LatLon,
    options: { waypoints?: LatLon[]; preferences?: RoutePreferences } = {},
  ): Promise<Route> {
    const route = await this.routingProvider.route({ origin, destination, ...options });
    this.applyRoute(route);
    return route;
  }

  getRoutingProvider(): RoutingProvider { return this.routingProvider; }

  /** Adopt an already-computed route (a reroute with a new stop, a chosen
   * alternative, new road preferences) as the active one. */
  applyRoute(route: Route): void {
    if (this.resilientOptions) route = this.adoptResilientRoute(route);
    this.route = route;
    this.offRouteDetector.reset();
    this.telemetry.log("ROUTE_UPDATE", { distanceM: route.distanceM, source: route.source, waypoints: route.waypointCount ?? 0 }, Date.now());
    this.stateMachine.tick(baseSmInput({ routeRequested: true }));
    this.stateMachine.tick(baseSmInput({ routeReady: true }));
  }

  clearRoute(): void {
    this.route = null;
    this.resilient = null;
    this.lastEstimate = null;
  }

  /**
   * Hand a new route to the resilient navigator. A reroute that starts at
   * the junction ahead of a car tracked off the route gets the rest of the
   * current road prepended; the navigator keeps its hypotheses when the road
   * network is shared, and is rebuilt (seeded at the route start when GNSS
   * isn't trusted) when the network is the route itself.
   */
  private adoptResilientRoute(route: Route): Route {
    const opts = this.resilientOptions!;
    const prev = this.resilient, prevEst = this.lastEstimate;
    if (prev && prevEst?.offRouteEdge && !this.resilientRouteOnly && route.geometry[0]) {
      const { ahead } = rerouteOriginAhead(prev.net, prevEst.offRouteEdge.edge, prevEst.offRouteEdge.offset);
      if (haversineMeters(ahead, route.geometry[0]) < 5) route = prependCurrentRoad(prev.net, prevEst.offRouteEdge.edge, prevEst.offRouteEdge.offset, route);
    }
    const graph = opts.networkForRoute?.(route) ?? null;
    if (prev && graph && prev.net === graph) {
      prev.setRoute(route);
      return route;
    }
    const net = graph ?? RoadNetwork.fromRoute(route);
    this.resilientRouteOnly = graph == null;
    const nav = new ResilientNavigator(net, { ...(graph == null ? { turnAnchoredCheck: false } : {}), ...opts.config });
    nav.setRoute(route);
    // Mid-drive reroute without trusted GNSS: the new route starts where the car is.
    if (prevEst && prevEst.gnss !== "OK") nav.initAtRouteStart(prevEst.speedMps);
    this.resilient = nav;
    this.lastEstimate = null;
    this.lastResilientStepMs = null;
    return route;
  }

  pushImuSample(sample: IMUSample): void {
    this.lastImuSample = sample;
    if (this.motionPre) {
      const m = this.motionPre.push(sample);
      if (m) {
        this.pendingMotion.push(m);
        if (this.pendingMotion.length > 10) this.pendingMotion.shift();
      }
      this.lastImuAtMs = sample.timestamp;
    }
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

    const resilient = route ? this.stepResilient(nowMs, route, offRouteConfirmed) : null;
    if (resilient) {
      const s = resilient.state;
      const mode = this.stateMachine.tick({
        gnssIntegrity: s.gnss,
        confidenceBand: s.confidenceBand,
        offRouteConfirmed: s.offRoute,
        hasArrived: resilient.arrived,
        routeRequested: false,
        routeReady: false,
      });
      if (mode === "RECOVERING" && this.currentState.mode !== "RECOVERING") this.telemetry.log("RECOVERY", {}, nowMs);
      if (s.offRoute && !this.currentState.offRoute) this.telemetry.log("OFF_ROUTE", { source: "resilient" }, nowMs);
      this.currentState = { ...s, mode };
      return this.currentState;
    }

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
      nextManeuverDistanceM: progress?.nextStepDistanceM ?? null,
      nearbyLandmarks: [],
      offRoute: offRouteConfirmed,
      networkAvailable: this.networkAvailable,
      offlineMapAvailable: false,
      lastTrustedFixAt: this.lastTrustedPosition?.position.timestamp ?? null,
      updatedAt: nowMs,
    };
    return this.currentState;
  }

  private resilientTrusted: NavigationState["trustedPosition"] = null;

  /**
   * Advance the resilient navigator (at most once per ~second — its gyro
   * window is in steps of one second) and build the NavigationState from it.
   * `classicOffRoute` is the corridor detector's verdict on raw GNSS; it is
   * used only when the network is the route itself and the rejected fixes
   * look like a real drive confirmed by a gyro turn.
   */
  private stepResilient(nowMs: TimestampMs, route: Route, classicOffRoute: boolean): { state: Omit<NavigationState, "mode">; arrived: boolean } | null {
    const nav = this.resilient;
    if (!nav) return null;
    let est = this.lastEstimate;
    if (this.lastResilientStepMs == null || nowMs - this.lastResilientStepMs >= 900) {
      const raw = this.lastGnssRaw;
      const fresh = raw && raw.timestamp !== this.lastFedGnssTs && nowMs - raw.timestamp <= this.staleAfterMs ? raw : null;
      if (fresh) this.lastFedGnssTs = fresh.timestamp;
      const imuLive = this.lastImuAtMs != null && nowMs - this.lastImuAtMs < 3000;
      let motion: NavigatorMotion | null = null;
      if (imuLive && this.pendingMotion.length > 0) {
        const n = this.pendingMotion.length;
        motion = {
          yawRateDps: this.pendingMotion.reduce((a, m) => a + m.yawRateDps, 0) / n,
          accelStd: this.pendingMotion.reduce((a, m) => a + m.accelStd, 0) / n,
        };
      }
      this.pendingMotion = [];
      est = nav.step({
        t: nowMs / 1000,
        gnss: fresh ? { lat: fresh.lat, lon: fresh.lon, accuracyM: fresh.accuracyM, speedMps: fresh.speedMps, courseDeg: fresh.headingDeg } : null,
        motion,
      });
      // Healthy fixes calibrate the phone-mount-dependent IMU parameters.
      if (fresh && est.gnss === "OK") this.motionPre?.observeGnss(fresh.timestamp, fresh.speedMps, fresh.headingDeg);
      if (est.gnss !== (this.lastEstimate?.gnss ?? "OK")) this.telemetry.log(est.gnss === "OK" ? "GNSS_FIX" : "GNSS_DEGRADED", { resilientVerdict: est.gnss, uncertaintyM: Math.round(est.uncertaintyM) }, nowMs);
      this.lastEstimate = est;
      this.lastResilientStepMs = nowMs;
    }
    if (!est) return null;

    // Route-only network: a departure from the route shows up as GNSS fixes
    // the filter rejects (it can't follow them off the chain) but that are a
    // plausible drive with a gyro-confirmed turn. Then the raw fixes win.
    const leftChain = this.resilientRouteOnly && classicOffRoute && nav.rejectedTrackPlausible();
    const offRoute = est.offRoute || leftChain;
    const raw = this.lastGnssRaw;
    const useRaw = leftChain && raw != null;
    const position: LatLon = useRaw ? { lat: raw.lat, lon: raw.lon } : est.position;
    const source = useRaw ? "GNSS" : est.source;
    const band: ConfidenceBand = useRaw ? "LOW" : est.band;
    const confidence = BAND_CONFIDENCE[band];
    const accuracyM = useRaw ? raw.accuracyM : Math.round(est.uncertaintyM);
    const posEstimate = { position: { ...position, timestamp: nowMs, accuracyM, source }, confidence, band, source };
    if (!useRaw && (est.gnss === "OK" || est.gnss === "DEGRADED")) this.resilientTrusted = posEstimate;

    const gnss: GNSSIntegrityState = est.gnss === "OK" ? "NORMAL" : est.gnss === "DEGRADED" ? "DEGRADED" : "LOST";
    const step = est.next ? route.steps[est.next.stepIndex] ?? null : null;
    const remaining = est.routeRemainingM ?? route.distanceM;
    const state: Omit<NavigationState, "mode"> = {
      position: posEstimate,
      trustedPosition: this.resilientTrusted,
      gnss,
      confidence,
      confidenceBand: band,
      speedMps: useRaw ? raw.speedMps : est.speedMps,
      headingDeg: useRaw ? raw.headingDeg : est.headingDeg,
      routeProgressM: est.routeAlongM ?? 0,
      routeRemainingM: remaining,
      nextStep: step,
      nextManeuverDistanceM: est.next ? est.next.distanceM : null,
      nearbyLandmarks: [],
      offRoute,
      networkAvailable: this.networkAvailable,
      offlineMapAvailable: false,
      lastTrustedFixAt: this.resilientTrusted?.position.timestamp ?? null,
      updatedAt: nowMs,
      positioning: {
        source,
        gnssVerdict: est.gnss,
        gnssSuspectedSpoofing: est.gnssInconsistent,
        uncertaintyM: est.uncertaintyM,
        maneuverUncertaintyM: est.next ? est.next.uncertaintyM : null,
        onRouteProbability: est.onRouteProbability,
        imuAvailable: this.lastImuAtMs != null && nowMs - this.lastImuAtMs < 3000,
        secondsSinceTrustedFix: est.secondsSinceAcceptedFix,
      },
    };
    return { state, arrived: est.arrived };
  }
}
