// NAVIA navigator — LAYER 1: context snapshot.
// One function collects everything the navigator may say, at the moment of a
// question or a state change: GNSS state and its age, position source and
// confidence, route progress and next maneuver, off-route, air alert, nearest
// shelters / places with real distances, speed, heading, online/offline.
// Every answer and every proactive message is built from this object only.
// Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import { gpsDetails, type PositionSourceKind } from "../../engine/liveStatus";
import { navigatorModeOf, type NavigatorMode } from "../../navigation/navigatorMode";
import type { CopilotWorld, PlaceKind, WorldPlace } from "../copilotBrain";

export type Snapshot = {
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
};

export function buildSnapshot({ state, world, online = true, now = Date.now() }: SnapshotInput): Snapshot {
  const d = gpsDetails(state);
  const r = world.route;
  return {
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
