// GPS and air-alert status as the map shows it: one source for the beacon
// colours (home map and turn-by-turn navigation) and for the details panel.
// Pure; unit-tested.
import type { NavigationState } from "@navia/core";
import type { StringKey } from "../i18n/strings";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";

export type GpsStatus = "checking" | "permission" | "searching" | "ready" | "error";
export type GnssHealth = "stable" | "unstable" | "lost";
export type BeaconTone = "success" | "warning" | "critical" | "neutral";

export function healthFrom(gnss: NavigationState["gnss"] | string): GnssHealth {
  return gnss === "NORMAL" ? "stable" : gnss === "DEGRADED" ? "unstable" : "lost";
}

/** Beacon colour and headline for GPS. Before the first fix it is neutral
 * ("searching"), never red: no data is not the same as a lost signal. */
export function gpsTone(status: GpsStatus, health: GnssHealth): { tone: BeaconTone; key: StringKey } {
  if (status === "permission") return { tone: "neutral", key: "gps.permission" };
  if (status === "error") return { tone: "critical", key: "gps.error" };
  if (status !== "ready") return { tone: "neutral", key: "gps.searching" };
  return health === "stable" ? { tone: "success", key: "gps.stable" } : health === "unstable" ? { tone: "warning", key: "gps.unstable" } : { tone: "critical", key: "gps.lost" };
}

export type PositionSourceKind = "GNSS" | "DEAD_RECKONING" | "FUSED" | "MANUAL" | "NONE";

export type GpsDetails = {
  gnss: NavigationState["gnss"];
  /** Reported accuracy of the current GNSS fix (m); null when not on GNSS. */
  accuracyM: number | null;
  /** Estimated error while the position is dead-reckoned (m). */
  uncertaintyM: number | null;
  source: PositionSourceKind;
  /** Age of the last trusted fix on the engine's own clock (demo = simulated time). */
  lastTrustedFixAgeS: number | null;
};

/** What the GPS panel shows, straight from the engine state. */
export function gpsDetails(state: NavigationState): GpsDetails {
  const pos = state.position;
  const source: PositionSourceKind =
    state.positionMode === "MANUAL" ? "MANUAL"
      : state.positionMode === "DEAD_RECKONING" ? "DEAD_RECKONING"
        : !pos ? "NONE"
          : pos.source === "GNSS" ? "GNSS"
            : pos.source === "DEAD_RECKONING" ? "DEAD_RECKONING"
              : "FUSED"; // FUSED and MAP_MATCH both blend GNSS with other evidence
  const onGnss = source === "GNSS" || source === "FUSED";
  const acc = pos?.position.accuracyM;
  return {
    gnss: state.gnss,
    accuracyM: onGnss && acc != null && Number.isFinite(acc) ? acc : null,
    uncertaintyM: !onGnss && state.positionUncertaintyM != null ? state.positionUncertaintyM : null,
    source,
    lastTrustedFixAgeS: state.lastTrustedFixAt != null ? Math.max(0, Math.round((state.updatedAt - state.lastTrustedFixAt) / 1000)) : null,
  };
}

export type AlertPhase = "unknown" | "none" | "active" | "ended";

/** Time the last alert at the user's place ended: set when an active alert
 * turns clear, cleared when a new one starts. */
export function nextAlertEndedAt(prev: GeolocatedAirAlert | null, next: GeolocatedAirAlert | null, prevEndedAt: number | null, nowMs: number): number | null {
  if (next?.active === true) return null;
  if (prev?.active === true && next?.active === false) return next.updatedAt ?? nowMs;
  return prevEndedAt;
}

/** Status for the alert panel. "ended" is shown for 30 minutes after the end. */
export function alertPhase(alert: GeolocatedAirAlert | null, endedAt: number | null, nowMs: number): AlertPhase {
  if (!alert || alert.active == null) return "unknown";
  if (alert.active) return "active";
  return endedAt != null && nowMs - endedAt < 30 * 60_000 ? "ended" : "none";
}
