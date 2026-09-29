// NAVIA navigator — LAYER 1: context snapshot.
// One function collects everything the navigator may say, at the moment of a
// question or a state change: GNSS state and its age, position source and
// confidence, route progress and next maneuver, off-route, air alert, nearest
// shelters / places with real distances, speed, heading, online/offline.
// Every answer and every proactive message is built from this object only.
// Pure; unit-tested.
import { drErrorGrowthMPerMin, type NavigationState } from "@navia/core";
import { gpsDetails, type PositionSourceKind } from "../../engine/liveStatus";
import { navigatorModeOf, type NavigatorMode } from "../../navigation/navigatorMode";
import type { CopilotWorld, PlaceKind, WorldPlace } from "../copilotBrain";

/**
 * The programme's context contract (part 2.1): one flat record with every
 * field an answer may use. Every number or name the navigator says must come
 * from here (or the nested views below, built from the same inputs). null =
 * not known — handlers then say so instead of guessing.
 */
export type NavFields = {
  gnssState: "NORMAL" | "DEGRADED" | "LOST";
  /** ms since the last trusted fix; null = no trusted fix yet. */
  gnssLastFixAgeMs: number | null;
  /** MAP_MATCH is not produced by the engine (dead reckoning runs along the route itself). */
  positionSource: "GNSS" | "DEAD_RECKONING" | "MAP_MATCH" | "FUSED" | "MANUAL" | "NONE";
  positionConfidence: number;
  positionConfidenceBand: string;
  /** Accuracy of the GNSS fix / error of the estimate, metres. */
  positionAccuracyM: number | null;
  currentLat: number | null;
  currentLon: number | null;
  routeActive: boolean;
  routeProgressM: number;
  routeRemainingM: number;
  nextManeuver: { type: string; distanceM: number | null; roadName: string | null } | null;
  etaTimestamp: number | null;
  offRoute: boolean;
  reroutingInProgress: boolean;
  /** UNKNOWN = the alert source has not answered. */
  alarmStatus: "NONE" | "ACTIVE" | "CLEARED" | "UNKNOWN";
  alarmDeclaredAt: number | null;
  nearbyShelters: { id: string; label: string; distanceM: number; source: "real" | "demo" }[];
  nearbyPOI: { id: string; category: string; label: string; distanceM: number }[];
  speedMps: number | null;
  headingDeg: number | null;
  networkOnline: boolean;
  /** null = not known (package status not read). */
  offlinePackageAvailable: boolean | null;
  isDemoMode: boolean;
  lastNavaResponse: string | null;
  snapshotTimestamp: number;
  /** Dead-reckoning error growth at the current speed, m/min (engine's model); null without speed. */
  drErrorGrowthMPerMin: number | null;
};

export type Snapshot = {
  /** Part 2.1 contract (flat). */
  fields: NavFields;
  lang: "uk" | "en";
  at: number;
  gnss: {
    state: NavigationState["gnss"];
    mode: NavigatorMode;
    /** Reported accuracy of the current GNSS fix (m). */
    accuracyM: number | null;
    /** Seconds since the last trusted fix (engine clock). */
    sinceFixS: number | null;
    /** Early-warning reasons in words ("точність погіршується"). */
    trend: string | null;
  };
  position: {
    known: boolean;
    source: PositionSourceKind;
    confidence: NavigationState["confidenceBand"];
    /** Estimated error while dead-reckoning (m). */
    uncertaintyM: number | null;
    street: string | null;
    area: string | null;
  };
  motion: { speedKmh: number | null; headingDeg: number | null };
  route: null | {
    destination: string;
    mode: "car" | "walk";
    remainingM: number;
    etaS: number | null;
    offRoute: boolean;
    next: null | { action: string; road: string | null; distanceM: number | null; cue: string | null; confirm: string | null };
    then: string | null;
    behind: string | null;
    ahead: string | null;
    landmarks: number;
  };
  alert: null | {
    active: boolean | null;
    scope: "district" | "city" | "region" | null;
    since: number | null;
    area: string | null;
    reasons: string[];
    otherDistricts: number;
  };
  places: Partial<Record<PlaceKind, WorldPlace[]>>;
  placeStates: NonNullable<CopilotWorld["placeStates"]>;
  placeGaps: NonNullable<CopilotWorld["placeGaps"]>;
  online: boolean;
  /** The world view the classic co-pilot functions understand (place search,
   * describe, emergency) — derived from the same inputs. */
  world: CopilotWorld;
};

export type SnapshotInput = {
  state: NavigationState;
  world: CopilotWorld;
  /** false when the phone has no network (or the "no internet" test mode). */
  online?: boolean;
  now?: number;
  /** "Київ + область" offline package ready on the phone; null = unknown. */
  offlinePackageAvailable?: boolean | null;
  isDemo?: boolean;
  /** When the last alert at the user's place ended (for CLEARED). */
  alertEndedAt?: number | null;
  rerouting?: boolean;
  lastResponse?: string | null;
};

/** An alert that ended less than this long ago is reported as "cleared". */
const CLEARED_FOR_MS = 30 * 60_000;

export function buildSnapshot({ state, world, online = true, now = Date.now(), offlinePackageAvailable = null, isDemo = false, alertEndedAt = null, rerouting = false, lastResponse = null }: SnapshotInput): Snapshot {
  const d = gpsDetails(state);
  const r = world.route;
  const pos = state.position?.position ?? null;
  const active = world.alert?.active ?? null;
  const speedTrusted = state.gnss === "NORMAL";
  const fields: NavFields = {
    gnssState: state.gnss,
    gnssLastFixAgeMs: d.lastTrustedFixAgeS != null ? Math.round(d.lastTrustedFixAgeS * 1000) : world.gps.lastFixAgeS != null ? Math.round(world.gps.lastFixAgeS * 1000) : null,
    positionSource: d.source,
    positionConfidence: Math.max(0, Math.min(1, state.confidence)),
    positionConfidenceBand: state.confidenceBand,
    positionAccuracyM: d.uncertaintyM ?? d.accuracyM ?? null,
    currentLat: pos?.lat ?? null,
    currentLon: pos?.lon ?? null,
    routeActive: !!r,
    routeProgressM: r ? state.routeProgressM : 0,
    routeRemainingM: r ? r.remainingM : 0,
    nextManeuver: r?.next && state.nextStep ? { type: state.nextStep.maneuver, distanceM: r.next.distanceM ?? null, roadName: r.next.road ?? null } : null,
    etaTimestamp: r?.etaS != null ? now + r.etaS * 1000 : null,
    offRoute: r?.offRoute ?? false,
    reroutingInProgress: rerouting,
    alarmStatus: active == null ? "UNKNOWN" : active ? "ACTIVE" : alertEndedAt != null && now - alertEndedAt < CLEARED_FOR_MS ? "CLEARED" : "NONE",
    alarmDeclaredAt: active ? world.alert?.since ?? null : null,
    nearbyShelters: (world.places.shelter ?? []).map((p) => ({ id: p.id, label: p.name, distanceM: p.distanceM, source: p.origin === "demo" ? "demo" : "real" })),
    nearbyPOI: Object.entries(world.places).filter(([k]) => k !== "shelter").flatMap(([k, list]) => (list ?? []).map((p) => ({ id: p.id, category: k, label: p.name, distanceM: p.distanceM }))),
    speedMps: state.speedMps != null && Number.isFinite(state.speedMps) ? state.speedMps : null,
    headingDeg: state.headingDeg,
    networkOnline: online,
    offlinePackageAvailable,
    isDemoMode: isDemo,
    lastNavaResponse: lastResponse,
    snapshotTimestamp: now,
    drErrorGrowthMPerMin: state.speedMps != null && Number.isFinite(state.speedMps) ? drErrorGrowthMPerMin(state.speedMps, speedTrusted) : null,
  };
  return {
    fields,
    lang: world.lang,
    at: now,
    gnss: {
      state: state.gnss,
      mode: navigatorModeOf(state),
      accuracyM: d.accuracyM ?? (state.gnss !== "LOST" ? world.gps.accuracyM : null),
      sinceFixS: d.lastTrustedFixAgeS ?? world.gps.lastFixAgeS,
      trend: world.gps.trendText ?? null,
    },
    position: {
      known: world.gps.hasPosition,
      source: d.source,
      confidence: state.confidenceBand,
      uncertaintyM: d.uncertaintyM,
      street: world.here?.street ?? null,
      area: world.here?.area ?? null,
    },
    motion: {
      speedKmh: state.speedMps != null && Number.isFinite(state.speedMps) ? Math.round(state.speedMps * 3.6) : null,
      headingDeg: state.headingDeg,
    },
    route: r ? {
      destination: r.destination,
      mode: r.mode,
      remainingM: r.remainingM,
      etaS: r.etaS,
      offRoute: r.offRoute,
      next: r.next ? { action: r.next.action, road: r.next.road ?? null, distanceM: r.next.distanceM, cue: r.next.cue ?? null, confirm: r.next.confirm ?? null } : null,
      then: r.then ?? null,
      behind: r.behind ?? null,
      ahead: r.ahead ?? null,
      landmarks: r.landmarkCount,
    } : null,
    alert: world.alert ? {
      active: world.alert.active,
      scope: world.alert.scope ?? null,
      since: world.alert.since ?? null,
      area: world.alert.area ?? null,
      reasons: world.alert.reasons ?? [],
      otherDistricts: world.alert.otherDistricts ?? 0,
    } : null,
    places: world.places,
    placeStates: world.placeStates ?? {},
    placeGaps: world.placeGaps ?? {},
    online,
    world,
  };
}
