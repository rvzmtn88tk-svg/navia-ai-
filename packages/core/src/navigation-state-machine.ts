// NavigationStateMachine — spec section 21 ("STATE MACHINE").
//
//   IDLE -> ROUTING -> ACTIVE -> GNSS_DEGRADED -> GNSS_LOST ->
//   POSITION_UNCERTAIN -> GNSS_RECOVERED -> ACTIVE
//   ACTIVE <-> OFF_ROUTE, ACTIVE -> ARRIVED
//
// "GNSS_RECOVERED" in the spec's diagram is this package's `RECOVERING`
// NavigationMode (types.ts's NavigationMode union uses that name).
//
// "Use hysteresis. Do not switch state on one noisy sample." — degrading out
// of ACTIVE requires `degradedConfirmSamples`/`lostConfirmSamples`
// consecutive bad samples (a single noisy fix can't trip it), and returning
// to ACTIVE from any degraded state always passes through RECOVERING first,
// validated by RecoveryEngine's consecutive-good-samples counter — a single
// clean fix after an outage doesn't instantly restore full trust either.

import type { NavigationMode, GNSSIntegrityState, ConfidenceBand } from "./types";
import { RecoveryEngine } from "./recovery-engine";

export type StateMachineInput = {
  gnssIntegrity: GNSSIntegrityState;
  confidenceBand: ConfidenceBand;
  /** Confirmed by OffRouteDetector (already hysteresis-filtered upstream). */
  offRouteConfirmed: boolean;
  hasArrived: boolean;
  /** User picked a destination; fires the IDLE -> ROUTING transition. */
  routeRequested: boolean;
  /** RoutingProvider resolved a route; fires ROUTING -> ACTIVE and (after a
   * confirmed off-route reroute) OFF_ROUTE -> ROUTING -> ACTIVE. */
  routeReady: boolean;
};

export type StateMachineConfig = {
  degradedConfirmSamples: number;
  lostConfirmSamples: number;
  recovery: { confirmSamples: number };
};

const DEFAULT_CONFIG: StateMachineConfig = {
  degradedConfirmSamples: 3,
  lostConfirmSamples: 3,
  recovery: { confirmSamples: 3 },
};

const GNSS_DEGRADING_MODES: NavigationMode[] = ["GNSS_DEGRADED", "GNSS_LOST", "POSITION_UNCERTAIN"];

export class NavigationStateMachine {
  private mode: NavigationMode = "IDLE";
  private config: StateMachineConfig;
  private degradedStreak = 0;
  private lostStreak = 0;
  private recoveryEngine: RecoveryEngine;

  constructor(config: Partial<StateMachineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config, recovery: { ...DEFAULT_CONFIG.recovery, ...config.recovery } };
    this.recoveryEngine = new RecoveryEngine(this.config.recovery);
  }

  getMode(): NavigationMode {
    return this.mode;
  }

  tick(input: StateMachineInput): NavigationMode {
    const isGoodSample = input.gnssIntegrity === "NORMAL" && input.confidenceBand !== "UNKNOWN";

    switch (this.mode) {
      case "IDLE":
        if (input.routeRequested) this.mode = "ROUTING";
        break;

      case "ROUTING":
        if (input.routeReady) { this.mode = "ACTIVE"; this.resetStreaks(); }
        break;

      case "ACTIVE": {
        if (input.hasArrived) { this.mode = "ARRIVED"; break; }
        if (input.offRouteConfirmed) { this.mode = "OFF_ROUTE"; break; }
        this.trackDegradation(input);
        break;
      }

      case "OFF_ROUTE":
        // A confirmed off-route condition triggers a reroute request
        // upstream; once the new route is ready, resume ACTIVE via ROUTING.
        if (input.routeReady) { this.mode = "ACTIVE"; this.resetStreaks(); }
        else if (!input.offRouteConfirmed) this.mode = "ROUTING";
        break;

      case "GNSS_DEGRADED":
      case "GNSS_LOST":
      case "POSITION_UNCERTAIN": {
        // Escalate further if it's getting worse; otherwise look for recovery.
        this.trackDegradation(input);
        if (GNSS_DEGRADING_MODES.includes(this.mode) && isGoodSample) {
          this.mode = "RECOVERING";
          this.recoveryEngine.reset();
          this.recoveryEngine.update(true);
        }
        break;
      }

      case "RECOVERING": {
        if (!isGoodSample) {
          // Recovery attempt failed — drop back to the state that matches
          // current conditions rather than pretending we're still healing.
          this.mode = this.degradedModeFor(input);
          this.recoveryEngine.reset();
          break;
        }
        const validated = this.recoveryEngine.update(true);
        if (validated) { this.mode = "ACTIVE"; this.resetStreaks(); }
        break;
      }

      case "ARRIVED":
        // Terminal for this trip; a new routeRequested starts a fresh one.
        if (input.routeRequested) { this.mode = "ROUTING"; this.resetStreaks(); }
        break;
    }

    return this.mode;
  }

  private trackDegradation(input: StateMachineInput): void {
    if (input.gnssIntegrity === "LOST") {
      this.lostStreak++;
      this.degradedStreak = 0;
    } else if (input.gnssIntegrity === "DEGRADED" || input.confidenceBand === "LOW" || input.confidenceBand === "UNKNOWN") {
      this.degradedStreak++;
      this.lostStreak = 0;
    } else {
      this.degradedStreak = 0;
      this.lostStreak = 0;
      return;
    }

    if (this.lostStreak >= this.config.lostConfirmSamples) {
      this.mode = input.confidenceBand === "UNKNOWN" ? "POSITION_UNCERTAIN" : "GNSS_LOST";
    } else if (this.degradedStreak >= this.config.degradedConfirmSamples) {
      if (this.mode === "ACTIVE") this.mode = "GNSS_DEGRADED";
    }
  }

  private degradedModeFor(input: StateMachineInput): NavigationMode {
    if (input.gnssIntegrity === "LOST") return input.confidenceBand === "UNKNOWN" ? "POSITION_UNCERTAIN" : "GNSS_LOST";
    return "GNSS_DEGRADED";
  }

  private resetStreaks(): void {
    this.degradedStreak = 0;
    this.lostStreak = 0;
    this.recoveryEngine.reset();
  }
}
