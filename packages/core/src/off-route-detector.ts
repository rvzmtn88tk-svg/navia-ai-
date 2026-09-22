// OffRouteDetector — spec section 22 ("OFF-ROUTE").
//
// Detects: distance from route corridor, map-matched road mismatch, heading
// mismatch, sustained deviation — via a timer/hysteresis, not a single noisy
// sample ("do not say 'you left the route' after a single 10m deviation").
// Confirms only after the deviation condition holds continuously for
// `sustainMs`; a single good sample resets the timer immediately, so a brief
// GPS blip can't trigger a false reroute.

export type OffRouteSample = {
  distanceFromRouteM: number;
  roadMismatch: boolean; // map-matched road segment differs from the expected route segment
  headingMismatchDeg: number | null; // angle between travel heading and route bearing, if known
  timestamp: number;
};

export type OffRouteConfig = {
  corridorM: number; // beyond this distance from the route line, the sample counts as "off"
  headingMismatchDeg: number; // beyond this angle, counts toward "off" (independent of distance)
  sustainMs: number; // how long the condition must hold continuously before confirming off-route
};

const DEFAULT_CONFIG: OffRouteConfig = {
  corridorM: 40,
  headingMismatchDeg: 60,
  sustainMs: 8000,
};

export class OffRouteDetector {
  private config: OffRouteConfig;
  private offSinceMs: number | null = null;
  private confirmed = false;

  constructor(config: Partial<OffRouteConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Feed one sample; returns whether off-route is CONFIRMED after this sample. */
  update(sample: OffRouteSample): boolean {
    const isOffThisSample =
      sample.distanceFromRouteM > this.config.corridorM ||
      sample.roadMismatch ||
      (sample.headingMismatchDeg != null && sample.headingMismatchDeg > this.config.headingMismatchDeg);

    if (!isOffThisSample) {
      this.offSinceMs = null;
      this.confirmed = false;
      return false;
    }

    if (this.offSinceMs == null) this.offSinceMs = sample.timestamp;
    const dwellMs = sample.timestamp - this.offSinceMs;
    if (dwellMs >= this.config.sustainMs) this.confirmed = true;
    return this.confirmed;
  }

  reset(): void {
    this.offSinceMs = null;
    this.confirmed = false;
  }

  isConfirmed(): boolean {
    return this.confirmed;
  }
}
