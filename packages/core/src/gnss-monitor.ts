// Flat raw-fix shape used internally by GNSSMonitor.evaluate(). This is
// distinct from the canonical, nested `GNSSSample` in ./types (which wraps
// lat/lon in a `position` field) — kept as its own name to avoid colliding
// with that export from the package's public barrel (./index).
export type GNSSRawSample = {
  lat: number; lon: number; timestamp: number;
  accuracyM: number | null; speedMps: number | null; headingDeg: number | null;
};
export type Integrity = {
  anomalyScore:number;
  jumpScore:number;
  speedScore:number;
  headingScore:number;
  freshnessScore:number;
  trusted:boolean;
};

import {haversineMeters, angleDeltaDeg} from "./geodesy";

export type GNSSConfig = {
  maxPlausibleSpeedMps:number;
  maxJumpM:number;
  maxFreshAgeMs:number;
  accuracyGoodM:number;
  accuracyBadM:number;
};

export class GNSSMonitor {
  constructor(private cfg:GNSSConfig) {}

  evaluate(prev:GNSSRawSample|null, cur:GNSSRawSample, now=Date.now()):Integrity {
    const coordinatesValid = Number.isFinite(cur.lat) && cur.lat >= -90 && cur.lat <= 90
      && Number.isFinite(cur.lon) && cur.lon >= -180 && cur.lon <= 180;
    const timestampValid = Number.isFinite(cur.timestamp) && cur.timestamp <= now + 1_500;
    const age = now - cur.timestamp;
    const fresh = age >= -1_500 && age <= this.cfg.maxFreshAgeMs;
    const accuracyValid = cur.accuracyM != null && Number.isFinite(cur.accuracyM) && cur.accuracyM >= 0;
    const sensorsValid = (cur.speedMps == null || Number.isFinite(cur.speedMps) && cur.speedMps >= 0)
      && (cur.headingDeg == null || Number.isFinite(cur.headingDeg) && cur.headingDeg >= 0 && cur.headingDeg < 360);
    const accuracyQuality = accuracyValid
      ? Math.max(0, Math.min(1, (this.cfg.accuracyBadM - cur.accuracyM!) / (this.cfg.accuracyBadM - this.cfg.accuracyGoodM)))
      : 0;
    const freshnessScore = fresh ? Math.max(0, 1 - Math.max(0, age) / this.cfg.maxFreshAgeMs) : 0;

    if (!coordinatesValid || !timestampValid || !fresh || !accuracyValid || !sensorsValid) {
      return { anomalyScore: 1, jumpScore: coordinatesValid ? 0 : 1, speedScore: 0, headingScore: 0, freshnessScore, trusted: false };
    }

    let jumpScore = 0;
    let speedScore = cur.speedMps != null && Number.isFinite(cur.speedMps) && cur.speedMps >= 0
      ? Math.min(1, Math.max(0, (cur.speedMps - this.cfg.maxPlausibleSpeedMps) / this.cfg.maxPlausibleSpeedMps))
      : 0;
    let headingScore = 0;
    if (prev) {
      const dtMs = cur.timestamp - prev.timestamp;
      if (dtMs <= 0) {
        return { anomalyScore: 1, jumpScore: 1, speedScore: 1, headingScore: 0, freshnessScore, trusted: false };
      }
      const dt = dtMs / 1000;
      const distance = haversineMeters(prev, cur);
      const implied = distance / dt;
      jumpScore = Math.min(1, distance / this.cfg.maxJumpM);
      speedScore = Math.min(1, Math.max(0, (implied - this.cfg.maxPlausibleSpeedMps) / this.cfg.maxPlausibleSpeedMps));
      if (prev.headingDeg != null && cur.headingDeg != null && Number.isFinite(prev.headingDeg) && Number.isFinite(cur.headingDeg)) {
        const delta = angleDeltaDeg(prev.headingDeg, cur.headingDeg);
        const maxTurn = dt < 1 ? 120 : Math.min(180, 60 * dt);
        headingScore = Math.min(1, Math.max(0, (delta - maxTurn) / 90));
      }
    }

    const anomalyScore = .35 * jumpScore + .30 * speedScore + .10 * headingScore
      + .15 * (1 - accuracyQuality) + .10 * (1 - freshnessScore);

    return {
      anomalyScore,
      jumpScore,
      speedScore,
      headingScore,
      freshnessScore,
      // Extreme speed or an instantaneous near-reversal is a hard rejection
      // even if the weighted score would otherwise hide that one bad sensor.
      trusted: anomalyScore < .35 && accuracyQuality > .35 && freshnessScore > .5
        && speedScore < .35 && headingScore < .75,
    };
  }
}
