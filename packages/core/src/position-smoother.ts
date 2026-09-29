// PositionSmoother — what the MAP shows, not what the navigator believes.
//
// When GNSS returns after a tunnel or an outage, the navigator's estimate
// may shift by tens of metres in one step. Drawing that as a jump is
// disorienting, so the displayed marker glides to the new estimate over a
// few seconds. Truly large corrections (a relocalisation, a wrong-road
// estimate, > `snapAboveM`) snap immediately — gliding across buildings for
// a kilometre would be worse. Navigation logic and the co-pilot always use
// the navigator's estimate, never this.

import type { LatLon } from "./types";
import { haversineMeters } from "./geodesy";

export type SmootherOptions = {
  /** Corrections smaller than this are applied directly (normal motion). */
  glideAboveM?: number;
  /** Corrections larger than this snap. */
  snapAboveM?: number;
  /** Seconds over which a correction is spread. */
  glideSeconds?: number;
};

export class PositionSmoother {
  private shown: LatLon | null = null;
  private lastTarget: LatLon | null = null;
  private lastT: number | null = null;
  private opts: Required<SmootherOptions>;

  constructor(options: SmootherOptions = {}) {
    this.opts = { glideAboveM: 15, snapAboveM: 400, glideSeconds: 3, ...options };
  }

  /**
   * `target` = navigator estimate at time `tMs`; `expectedMoveM` = how far the
   * car plausibly moved since the last update (speed × dt), which is not a
   * correction and is applied directly.
   */
  update(target: LatLon, tMs: number, expectedMoveM = 0): LatLon {
    if (!this.shown || this.lastT == null || !this.lastTarget) {
      this.shown = target; this.lastTarget = target; this.lastT = tMs;
      return target;
    }
    const dt = Math.max(0.05, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    // Where the old display would be after normal motion toward the target.
    const gap = haversineMeters(this.shown, target);
    const correction = Math.max(0, gap - expectedMoveM);
    this.lastTarget = target;
    if (correction <= this.opts.glideAboveM || gap >= this.opts.snapAboveM) {
      this.shown = target;
      return target;
    }
    // Move the full expected motion plus a share of the correction.
    const share = Math.min(1, (expectedMoveM + correction * Math.min(1, dt / this.opts.glideSeconds)) / gap);
    this.shown = {
      lat: this.shown.lat + (target.lat - this.shown.lat) * share,
      lon: this.shown.lon + (target.lon - this.shown.lon) * share,
    };
    return this.shown;
  }

  reset(): void { this.shown = null; this.lastTarget = null; this.lastT = null; }
}
