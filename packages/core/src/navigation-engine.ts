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
// sample. The current mobile path does not integrate IMU into displacement,
// so the engine retains the last trusted point briefly and never invents travel.

import type {
  LatLon, NavigationState, GNSSIntegrityState, ConfidenceBand, TimestampMs, IMUSample,
} from "./types";
import type { GNSSRawSample, GNSSConfig } from "./gnss-monitor";
import { GNSSMonitor } from "./gnss-monitor";
import { calculateConfidence } from "./confidence";
import { SensorFusionEngine } from "./sensor-fusion";
import type { Route, RoutingProvider, RoutePreferences, TravelMode } from "./route-engine";
import { RouteProgressEngine, distanceFromRouteCorridorM, routeMeasure } from "./route-engine";
import { OffRouteDetector } from "./off-route-detector";
import { NavigationStateMachine } from "./navigation-state-machine";
import { TelemetryLogger } from "./telemetry-logger";
import { haversineMeters } from "./geodesy";
import { GnssTrendMonitor, type GnssTrend } from "./gnss-trend";
import { MotionDetector, RouteDeadReckoner, deadReckoningConfidence, type DeadReckoningEstimate } from "./route-dead-reckoning";
import { RoadNetwork } from "./resilient/road-network";
import { ResilientNavigator, type ResilientConfig, type NavigatorEstimate, type NavigatorMotion } from "./resilient/resilient-navigator";
import { MotionPreprocessor, type MotionPreprocessorOptions } from "./resilient/motion-preprocessor";
import { rerouteOriginAhead, prependCurrentRoad } from "./resilient/reroute";
import { LocationStateTracker, type LocationStatus } from "./resilient/location-state";

const DEFAULT_GNSS_CONFIG: GNSSConfig = {
  maxPlausibleSpeedMps: 45, maxJumpM: 150, maxFreshAgeMs: 6000, accuracyGoodM: 10, accuracyBadM: 80,
};
const GNSS_LOST_CONFIRM_MS = 3_000;
/** Standing still: a fix of the same place this old is still the truth. */
const STATIONARY_FIX_MAX_AGE_MS = 15_000;

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
  /** Same, while the device is standing still: iOS sends few or no fixes when
   * the position does not change, so silence is not signal loss. */
  stationaryStaleAfterMs?: number;
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
    // Until the first accepted fix arrives, no location signal can be called
    // healthy. This state is exposed before tick() on initial screen render.
    mode: "IDLE", position: null, trustedPosition: null, gnss: "LOST",
    confidence: 0, confidenceBand: "UNKNOWN", speedMps: null, headingDeg: null,
    routeProgressM: 0, routeRemainingM: 0, nextStep: null, nextStepDistanceM: null, etaSeconds: null, nearbyLandmarks: [],
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
  private gnssMaxFreshAgeMs: number;
  private staleAfterMs: number;
  private stationaryStaleAfterMs: number;
  private prevTrustedGnssRaw: GNSSRawSample | null = null;
  /** Watches the fix stream for degradation before the signal is lost. */
  private trend = new GnssTrendMonitor();
  private lastTrend: GnssTrend | null = null;
  private fusion = new SensorFusionEngine();
  private progressEngine = new RouteProgressEngine();
  private offRouteDetector = new OffRouteDetector();
  private stateMachine = new NavigationStateMachine();
  private telemetry = new TelemetryLogger(20_000);

  private route: Route | null = null;
  /** Where the vehicle was on the current route at the last update (m). */
  private lastProgressM: number | null = null;
  /** Latest received sample (used only to determine whether the stream has stopped). */
  private lastGnssRaw: GNSSRawSample | null = null;
  /** Last sample that passed the integrity checks; rejected fixes never replace it. */
  private lastTrustedGnssRaw: GNSSRawSample | null = null;
  private lastGnssIntegrity: { trusted: boolean; anomalyScore: number; freshnessScore: number } | null = null;
  private displayedGnss: GNSSIntegrityState = "LOST";
  private lastDisplayedFixTimestamp: string | number | null = null;
  private degradedFixStreak = 0;
  private recoveryFixStreak = 0;
  private lostSinceMs: number | null = null;
  private lastTrustedPosition: NavigationState["trustedPosition"] = null;
  private lastImuSample: IMUSample | null = null;
  private networkAvailable = true;
  private currentState: NavigationState = idleState();
  private routeRevision = 0;
  private deadReckoner = new RouteDeadReckoner();
  private motion = new MotionDetector();
  private manualStart: { position: LatLon; atMs: number } | null = null;
  private drWasActive = false;
  /** Consecutive plausible fixes rejected as inconsistent with dead reckoning. */
  private conflictFixes: GNSSRawSample[] = [];
  private conflictSuppressedUntil = 0;

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
    const gnssConfig = { ...DEFAULT_GNSS_CONFIG, ...options.gnssConfig };
    this.gnssMonitor = new GNSSMonitor(gnssConfig);
    this.gnssMaxFreshAgeMs = gnssConfig.maxFreshAgeMs;
    this.staleAfterMs = options.staleAfterMs ?? 6000;
    this.stationaryStaleAfterMs = options.stationaryStaleAfterMs ?? 30_000;
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
    options: TravelMode | { mode?: TravelMode; waypoints?: LatLon[]; preferences?: RoutePreferences } = "car",
  ): Promise<Route> {
    const o = typeof options === "string" ? { mode: options } : options;
    const revision = ++this.routeRevision;
    const route = await this.routingProvider.route({ origin, destination, mode: o.mode ?? "car", ...(o.waypoints ? { waypoints: o.waypoints } : {}), ...(o.preferences ? { preferences: o.preferences } : {}) });
    if (revision !== this.routeRevision) throw new Error("NavigationEngine: route request was cancelled or superseded.");
    this.applyRoute(route);
    return route;
  }

  getRoutingProvider(): RoutingProvider { return this.routingProvider; }

  /** Adopt an already-computed route (a reroute with a new stop, a chosen
   * alternative, new road preferences) as the active one. */
  applyRoute(route: Route): void {
    if (this.resilientOptions) route = this.adoptResilientRoute(route);
    this.route = route;
    this.lastProgressM = 0;
    this.offRouteDetector.reset();
    this.deadReckoner.setRoute(route);
    // Seed dead reckoning: from the user-placed start, or the last trusted fix.
    const seedFrom = this.manualStart?.position ?? this.lastTrustedPosition?.position ?? null;
    if (seedFrom) {
      // A new route starts where the vehicle is: prefer the start of the line
      // when the route passes this place more than once.
      const seedProgress = this.progressEngine.computeProgress(route, seedFrom, null, 0).distanceCompletedM;
      if (this.manualStart) this.deadReckoner.anchorManually(seedProgress, Date.now());
      else this.deadReckoner.anchorFromGnss(seedProgress, this.lastTrustedGnssRaw?.speedMps ?? null, this.lastTrustedGnssRaw?.accuracyM ?? null, this.lastTrustedPosition!.position.timestamp);
    }
    this.currentState = {
      ...this.currentState,
      mode: "ACTIVE",
      routeProgressM: 0,
      routeRemainingM: route.distanceM,
      nextStep: route.steps[0] ?? null,
      nextStepDistanceM: null,
      etaSeconds: route.durationS,
      offRoute: false,
    };
    this.telemetry.log("ROUTE_UPDATE", { distanceM: route.distanceM, source: route.source, waypoints: route.waypointCount ?? 0 }, Date.now());
    this.stateMachine.tick(baseSmInput({ routeRequested: true }));
    this.stateMachine.tick(baseSmInput({ routeReady: true }));
  }

  clearRoute(): void {
    this.routeRevision++;
    this.route = null;
    this.lastProgressM = null;
    this.lastGnssRaw = null;
    this.lastTrustedGnssRaw = null;
    this.lastGnssIntegrity = null;
    this.displayedGnss = "LOST";
    this.lastDisplayedFixTimestamp = null;
    this.degradedFixStreak = 0;
    this.recoveryFixStreak = 0;
    this.lostSinceMs = null;
    this.lastTrustedPosition = null;
    this.lastImuSample = null;
    this.deadReckoner.reset();
    this.motion.reset();
    this.manualStart = null;
    this.drWasActive = false;
    this.conflictFixes = [];
    this.progressEngine = new RouteProgressEngine();
    this.offRouteDetector.reset();
    this.stateMachine.reset();
    this.currentState = idleState();
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
    this.motion.push(sample);
  }

  /** The user placed themselves on the map ("I am here") because no usable
   * GNSS is available. Used as the route origin and dead-reckoning anchor. */
  setManualPosition(position: LatLon, nowMs = Date.now()): void {
    this.manualStart = { position, atMs: nowMs };
    this.telemetry.log("MANUAL_POSITION", {}, nowMs);
    if (this.route) {
      this.deadReckoner.anchorManually(this.progressEngine.computeProgress(this.route, position, null, this.lastProgressM).distanceCompletedM, nowMs);
    }
  }

  /** The user confirmed they reached the upcoming maneuver while GNSS is
   * unavailable; snaps the along-route estimate to that point. */
  confirmManeuverReached(nowMs = Date.now()): boolean {
    const s = this.currentState;
    if (!this.route || s.nextStepDistanceM == null) return false;
    this.deadReckoner.confirmReached(Math.min(Math.max(this.route.distanceM, routeMeasure(this.route).totalM), s.routeProgressM + s.nextStepDistanceM), nowMs);
    this.telemetry.log("LANDMARK", { kind: "maneuver-confirmed" }, nowMs);
    return true;
  }

  /** The user confirmed the conflicting GNSS position is real: follow GNSS again. */
  acceptGnssConflict(nowMs = Date.now()): boolean {
    const last = this.conflictFixes[this.conflictFixes.length - 1];
    if (!last) return false;
    this.drWasActive = false;
    this.lastGnssRaw = last;
    this.lastGnssIntegrity = { trusted: true, anomalyScore: 0, freshnessScore: 1 };
    this.prevTrustedGnssRaw = this.lastTrustedGnssRaw;
    this.lastTrustedGnssRaw = last;
    this.conflictFixes = [];
    this.telemetry.log("MANUAL_POSITION", { kind: "gnss-conflict-accepted" }, nowMs);
    return true;
  }

  /** The user says the conflicting GNSS position is fake: keep dead reckoning, don't ask for 2 min. */
  rejectGnssConflict(nowMs = Date.now()): void {
    this.conflictFixes = [];
    this.conflictSuppressedUntil = nowMs + 120_000;
    this.telemetry.log("SPOOF_SUSPECT", { kind: "gnss-conflict-rejected" }, nowMs);
  }

  private currentConflict(nowMs: number, drPosition: LatLon | null): NavigationState["gnssConflict"] {
    const f = this.conflictFixes;
    if (f.length < 5 || nowMs < this.conflictSuppressedUntil || !drPosition) return null;
    const first = f[0]!, last = f[f.length - 1]!;
    if (last.timestamp - first.timestamp < 4_000 || nowMs - last.timestamp > 5_000) return null;
    return { distanceM: Math.round(haversineMeters(last, drPosition)), sinceMs: first.timestamp };
  }

  /** Last trusted fix, for offering "start from the last stable position". */
  getLastTrustedFix(): { position: LatLon; timestamp: number } | null {
    const p = this.lastTrustedPosition?.position;
    return p ? { position: { lat: p.lat, lon: p.lon }, timestamp: p.timestamp } : null;
  }
  getLastImuSample(): IMUSample | null {
    return this.lastImuSample;
  }

  /** Feed one real GNSS fix (from ExpoLocationPositionProvider). Runs
   * GNSSMonitor immediately; the resulting NavigationState comes from the
   * next tick() call, same clock-driven design as staleness detection. */
  pushGnssSample(sample: GNSSRawSample, nowMs = sample.timestamp): boolean {
    // A fix that is not newer than the last one (an OS cache replay, e.g. from
    // a one-off position request) carries no information: ignore it rather
    // than treat it as a signal anomaly.
    if (this.lastGnssRaw && sample.timestamp <= this.lastGnssRaw.timestamp) return this.lastGnssIntegrity?.trusted ?? false;
    const previousFix = this.lastTrustedGnssRaw;
    const isPreviousFixRecent = previousFix != null && nowMs - previousFix.timestamp <= this.gnssMaxFreshAgeMs;
    const baseline = previousFix && (sample.timestamp <= previousFix.timestamp || isPreviousFixRecent) ? previousFix : null;
    const integrity = this.gnssMonitor.evaluate(baseline, sample, nowMs);
    // Standing still, iOS answers a position request with a fix a few seconds
    // old. The same place a few seconds ago is still the truth: accept it if
    // it is otherwise clean (accuracy, no jump), instead of calling GPS weak.
    const lastTrusted = this.lastTrustedGnssRaw;
    if (!integrity.trusted && lastTrusted && this.movingKnown(nowMs) !== true) {
      const ageMs = nowMs - sample.timestamp;
      const samePlace = haversineMeters(lastTrusted, sample) < 10;
      const accurate = sample.accuracyM != null && sample.accuracyM <= 30;
      if (ageMs >= 0 && ageMs <= STATIONARY_FIX_MAX_AGE_MS && samePlace && accurate && integrity.jumpScore < 0.2 && integrity.speedScore < 0.35) {
        integrity.trusted = true;
      }
    }
    // While dead reckoning along a route, a "recovered" fix far from where the
    // vehicle must be is treated as spoofed, not as a jump to follow.
    if (integrity.trusted && this.route && this.drWasActive && !this.deadReckoner.isConsistent(sample, nowMs)) {
      integrity.trusted = false;
      this.telemetry.log("SPOOF_SUSPECT", { accuracyM: sample.accuracyM }, nowMs);
      // Keep a run of mutually plausible conflicting fixes: the user decides
      // whether it is a real correction (e.g. after a tunnel) or spoofing.
      const prev = this.conflictFixes[this.conflictFixes.length - 1];
      const dt = prev ? (sample.timestamp - prev.timestamp) / 1000 : 0;
      const plausible = prev != null && dt > 0 && haversineMeters(prev, sample) / dt <= 45;
      this.conflictFixes = plausible ? [...this.conflictFixes.slice(-19), sample] : [sample];
    } else if (integrity.trusted) {
      this.conflictFixes = [];
    }
    this.trend.push(sample.accuracyM, nowMs, this.movingKnown(nowMs) === false);
    this.lastGnssRaw = sample;
    this.lastGnssIntegrity = integrity;
    this.telemetry.log("GNSS_FIX", { accuracyM: sample.accuracyM, trusted: integrity.trusted }, sample.timestamp);
    if (integrity.trusted) {
      this.prevTrustedGnssRaw = this.lastTrustedGnssRaw;
      this.lastTrustedGnssRaw = sample;
    }
    return integrity.trusted;
  }

  /** Standing still (last trusted fix nearly motionless and the accelerometer,
   * when available, not reporting motion) gets a longer silence allowance. */
  private currentStaleLimitMs(nowMs: number): number {
    const last = this.lastTrustedGnssRaw;
    if (!last) return this.staleAfterMs;
    const moving = this.movingKnown(nowMs);
    if (moving === false) return this.stationaryStaleAfterMs;
    // Unknown (no speed from the receiver, not enough fixes yet): iOS may be
    // quiet because nothing moves — allow a medium silence.
    if (moving === null) return Math.max(this.staleAfterMs, 12_000);
    // Moving: lost after ≈3 missed fixes of the receiver's own rhythm.
    return Math.min(this.staleAfterMs, this.trend.lostAfterMs());
  }

  /** Moving / still / unknown, from the motion sensor or the last trusted fix. */
  private movingKnown(nowMs: number): boolean | null {
    const m = this.motion.isMoving(nowMs);
    if (m != null) return m;
    const last = this.lastTrustedGnssRaw;
    if (!last) return null;
    if (last.speedMps != null) return last.speedMps >= 0.7;
    const prev = this.prevTrustedGnssRaw;
    return prev != null ? haversineMeters(prev, last) >= 8 : null;
  }

  /** Advance the engine's state to `nowMs`. Call this on a regular clock
   * (e.g. every ~1s) independent of when GNSS fixes arrive — this is what
   * detects GNSS_LOST via staleness and updates the route/status state. */
  tick(nowMs: TimestampMs = Date.now()): NavigationState {
    const ageMs = this.lastGnssRaw ? nowMs - this.lastGnssRaw.timestamp : Infinity;
    const staleLimitMs = this.currentStaleLimitMs(nowMs);
    const isStale = ageMs < -1_500 || ageMs > staleLimitMs;
    const moving = this.movingKnown(nowMs);
    const trend = this.trend.evaluate(nowMs, moving);
    this.lastTrend = trend;

    const gnssIntegrityState: GNSSIntegrityState = !this.lastGnssRaw
      ? "LOST"
      : isStale
        ? "LOST"
        : this.lastGnssIntegrity?.trusted
          ? "NORMAL"
          : "DEGRADED";

    const freshTrustedFix = gnssIntegrityState === "NORMAL";
    const displaySampleId = gnssIntegrityState === "LOST"
      ? `lost:${Math.floor(nowMs / 1000)}`
      : this.lastGnssRaw?.timestamp ?? null;
    if (gnssIntegrityState === "LOST") {
      this.recoveryFixStreak = 0;
      this.degradedFixStreak = 0;
      if (this.displayedGnss === "NORMAL") this.displayedGnss = "DEGRADED";
      if (this.lostSinceMs == null) this.lostSinceMs = nowMs - Math.max(0, ageMs - staleLimitMs);
      // Moving and ≈3 fixes missed: report the loss now, not metres later.
      if (nowMs - this.lostSinceMs >= GNSS_LOST_CONFIRM_MS || (moving !== false && trend.level === "lost")) this.displayedGnss = "LOST";
    } else if (gnssIntegrityState === "DEGRADED") {
      this.lostSinceMs = null;
      this.recoveryFixStreak = 0;
      if (displaySampleId !== this.lastDisplayedFixTimestamp) {
        this.lastDisplayedFixTimestamp = displaySampleId;
        this.degradedFixStreak++;
      }
      if (this.displayedGnss === "LOST" && this.lastTrustedPosition) this.displayedGnss = "DEGRADED";
      if (this.displayedGnss === "NORMAL" && this.degradedFixStreak >= 2) this.displayedGnss = "DEGRADED";
    } else {
      this.lostSinceMs = null;
      this.degradedFixStreak = 0;
      if (displaySampleId !== this.lastDisplayedFixTimestamp) {
        this.lastDisplayedFixTimestamp = displaySampleId;
        if (this.displayedGnss !== "NORMAL") this.recoveryFixStreak++;
      }
      if (trend.level === "degrading" && this.lastTrustedPosition) {
        // Fixes are still usable, but the stream is getting worse: warn now.
        this.recoveryFixStreak = 0;
        if (this.displayedGnss === "NORMAL") this.displayedGnss = "DEGRADED";
      } else if (!this.lastTrustedPosition) this.displayedGnss = "NORMAL";
      // Moving: 3 good fixes before calling GPS stable again. Standing still
      // with fixes that agree on the same place: one is enough (fixes then
      // arrive only every ~15 s).
      else if (this.recoveryFixStreak >= (this.movingKnown(nowMs) === true ? 3 : 1)) {
        this.displayedGnss = "NORMAL";
        this.recoveryFixStreak = 0;
      }
    }

    if (gnssIntegrityState === "LOST" && this.currentState.gnss !== "LOST") {
      this.telemetry.log("GNSS_LOST", { ageMs }, nowMs);
    }

    // Rejected fixes never move the map. This app path does not yet integrate
    // IMU data into a motion estimate, so GNSS loss keeps a short-lived last
    // known fix and never invents a dead-reckoned position.
    let fusedPosition: LatLon | null = null;
    let fusedSpeedMps: number | null = null;
    let fusedHeadingDeg: number | null = null;
    let positionSource: "GNSS" | "DEAD_RECKONING" | "FUSED" | null = null;

    if (this.lastGnssRaw && !isStale && this.lastGnssIntegrity?.trusted) {
      const gnssQuality = 1 - this.lastGnssIntegrity.anomalyScore;
      const fused = this.fusion.fuse({
        gnss: {
          position: { lat: this.lastGnssRaw.lat, lon: this.lastGnssRaw.lon },
          speedMps: this.lastGnssRaw.speedMps, headingDeg: this.lastGnssRaw.headingDeg,
          timestamp: this.lastGnssRaw.timestamp, quality: gnssQuality,
        },
        deadReckoned: null,
      });
      fusedPosition = fused.position;
      fusedSpeedMps = fused.speedMps;
      fusedHeadingDeg = fused.headingDeg;
      positionSource = fused.source;
      if (this.lastTrustedGnssRaw?.timestamp === this.lastGnssRaw.timestamp && this.lastTrustedPosition?.position.timestamp !== this.lastGnssRaw.timestamp) {
        this.lastTrustedPosition = {
          position: { ...fused.position, timestamp: this.lastGnssRaw.timestamp, accuracyM: this.lastGnssRaw.accuracyM, source: "GNSS" },
          confidence: 0, band: "UNKNOWN", source: "GNSS",
        };
      }
    }

    const gnssQuality = gnssIntegrityState === "NORMAL" && this.lastGnssIntegrity ? 1 - this.lastGnssIntegrity.anomalyScore : 0;
    const freshness = gnssIntegrityState === "LOST" ? 0 : (this.lastGnssIntegrity?.freshnessScore ?? 0);
    const route = this.route;
    let distanceOffRouteM = 0;
    const hasFreshTrustedPosition = freshTrustedFix && fusedPosition != null;
    if (route && fusedPosition && hasFreshTrustedPosition) distanceOffRouteM = distanceFromRouteCorridorM(route, fusedPosition);

    const confidence = calculateConfidence({
      gnssQuality, freshness,
      sensorAgreement: 0.5, // IMU is subscribed but is not yet integrated into motion estimates.
      mapMatchQuality: 0.5, // This engine does not perform road map matching yet.
      routeConsistency: route && hasFreshTrustedPosition ? Math.max(0, 1 - distanceOffRouteM / 200) : 0.5,
    });

    const pendingTrustedEstimate = this.lastTrustedPosition;
    if (pendingTrustedEstimate && pendingTrustedEstimate.position.timestamp === this.lastGnssRaw?.timestamp && pendingTrustedEstimate.confidence === 0) {
      this.lastTrustedPosition = { ...pendingTrustedEstimate, confidence: confidence.value, band: confidence.band };
    }

    let progress = route && fusedPosition && hasFreshTrustedPosition ? this.progressEngine.computeProgress(route, fusedPosition, fusedSpeedMps, this.lastProgressM,
      // Course over ground is meaningful only while moving.
      fusedSpeedMps != null && fusedSpeedMps >= 2 ? fusedHeadingDeg : null) : null;
    if (progress && route) {
      this.deadReckoner.anchorFromGnss(progress.distanceCompletedM, fusedSpeedMps, this.lastGnssRaw?.accuracyM ?? null, nowMs);
    }

    // No usable GNSS on an active route: keep guiding along the route.
    let dr: DeadReckoningEstimate | null = null;
    if (route && !hasFreshTrustedPosition && this.deadReckoner.hasAnchor()) {
      dr = this.deadReckoner.estimate(nowMs, this.motion.isMoving(nowMs));
      if (dr) progress = this.progressEngine.computeProgress(route, dr.position, dr.speedMps > 0 ? dr.speedMps : null, dr.progressM);
    }
    if (progress) this.lastProgressM = progress.distanceCompletedM;
    if (dr && !this.drWasActive) this.telemetry.log("DEAD_RECKONING", { started: true }, nowMs);
    if (!dr && this.drWasActive) this.telemetry.log("DEAD_RECKONING", { started: false }, nowMs);
    this.drWasActive = dr != null;
    const drConfidence = dr ? deadReckoningConfidence(dr) : null;
    const offRouteConfirmed = route && fusedPosition && hasFreshTrustedPosition
      ? this.offRouteDetector.update({ distanceFromRouteM: distanceOffRouteM, roadMismatch: false, headingMismatchDeg: null, timestamp: nowMs })
      : this.currentState.offRoute;
    if (offRouteConfirmed && !this.currentState.offRoute) this.telemetry.log("OFF_ROUTE", { distanceOffRouteM }, nowMs);

    // Without GNSS, arrival is not declared automatically: the estimate can be off.
    const hasArrived = !dr && progress != null && progress.distanceRemainingM < 10;

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
      confidenceBand: drConfidence?.band ?? confidence.band,
      offRouteConfirmed,
      hasArrived,
      routeRequested: false,
      routeReady: false,
      sampleId: displaySampleId ?? `none:${Math.floor(nowMs / 1000)}`,
    });
    if (mode === "RECOVERING" && this.currentState.mode !== "RECOVERING") this.telemetry.log("RECOVERY", {}, nowMs);

    this.currentState = {
      mode,
      position: hasFreshTrustedPosition && fusedPosition && positionSource
        ? { position: { ...fusedPosition, timestamp: this.lastGnssRaw!.timestamp, accuracyM: this.lastGnssRaw!.accuracyM, source: positionSource }, confidence: confidence.value, band: confidence.band, source: positionSource }
        : dr && drConfidence
          ? { position: { ...dr.position, timestamp: nowMs, accuracyM: dr.uncertaintyM, speedMps: dr.speedMps, headingDeg: dr.headingDeg, source: "DEAD_RECKONING" }, confidence: drConfidence.value, band: drConfidence.band, source: "DEAD_RECKONING" }
          : this.lastTrustedPosition && nowMs - this.lastTrustedPosition.position.timestamp <= 20_000
          ? { ...this.lastTrustedPosition, confidence: confidence.value, band: confidence.band }
          : null,
      trustedPosition: this.lastTrustedPosition,
      gnss: this.displayedGnss,
      confidence: drConfidence?.value ?? confidence.value,
      confidenceBand: drConfidence?.band ?? confidence.band,
      speedMps: dr ? dr.speedMps : fusedSpeedMps,
      headingDeg: dr ? dr.headingDeg : fusedHeadingDeg,
      routeProgressM: progress?.distanceCompletedM ?? this.currentState.routeProgressM,
      routeRemainingM: progress?.distanceRemainingM ?? this.currentState.routeRemainingM,
      nextStep: progress?.nextStep ?? this.currentState.nextStep ?? route?.steps[0] ?? null,
      nextStepDistanceM: progress?.nextStepDistanceM ?? this.currentState.nextStepDistanceM ?? null,
      etaSeconds: progress?.etaSeconds ?? this.currentState.etaSeconds ?? (route?.durationS ?? null),
      nextManeuverDistanceM: progress?.nextStepDistanceM ?? this.currentState.nextStepDistanceM ?? null,
      nearbyLandmarks: [],
      offRoute: offRouteConfirmed,
      networkAvailable: this.networkAvailable,
      offlineMapAvailable: false,
      lastTrustedFixAt: this.lastTrustedPosition?.position.timestamp ?? null,
      positionMode: route ? (hasFreshTrustedPosition ? "GNSS" : dr ? (dr.anchorSource === "manual" ? "MANUAL" : "DEAD_RECKONING") : null) : null,
      positionUncertaintyM: dr ? Math.round(dr.uncertaintyM) : null,
      gnssConflict: this.currentConflict(nowMs, dr ? dr.position : null),
      gnssTrend: this.lastTrend ? { level: this.lastTrend.level, reasons: this.lastTrend.reasons, sinceLastFixMs: this.lastTrend.sinceLastFixMs, expectedIntervalMs: this.lastTrend.expectedIntervalMs, accuracyM: this.lastTrend.accuracyM } : null,
      updatedAt: nowMs,
    };
    return this.currentState;
  }

  private resilientTrusted: NavigationState["trustedPosition"] = null;
  private locationTracker = new LocationStateTracker();
  private locationStatus: LocationStatus | null = null;
  private lastReliablePosition: LatLon | null = null;

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
      this.locationStatus = this.locationTracker.update(est);
      if (est.gnss === "OK" || est.gnss === "DEGRADED") this.lastReliablePosition = est.position;
    }
    if (!est) return null;
    const loc = this.locationStatus ?? this.locationTracker.update(est);

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
        locationState: useRaw ? "REDUCED_ACCURACY" : loc.state,
        guidance: useRaw ? "approximate" : loc.guidance,
        locationConfidence: loc.confidence,
        lastReliablePosition: this.lastReliablePosition,
      },
    };
    return { state, arrived: est.arrived };
  }
}
