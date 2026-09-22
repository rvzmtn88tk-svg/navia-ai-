// Flat raw-fix shape used internally by GNSSMonitor.evaluate(). This is
// distinct from the canonical, nested `GNSSSample` in ./types (which wraps
// lat/lon in a `position` field) — kept as its own name to avoid colliding
// with that export from the package's public barrel (./index).
export type GNSSRawSample = {
  lat:number; lon:number; timestamp:number;
  accuracyM:number|null; speedMps:number|null; headingDeg:number|null;
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
    if (!prev) {
      const freshness = cur.timestamp > now-this.cfg.maxFreshAgeMs ? 1 : 0;
      const aq = cur.accuracyM == null ? .5 : Math.max(0,Math.min(1,1-cur.accuracyM/this.cfg.accuracyBadM));
      return {anomalyScore:1-aq,jumpScore:0,speedScore:0,headingScore:0,freshnessScore:freshness,trusted:freshness>.5 && aq>.45};
    }
    const dt=Math.max(.05,(cur.timestamp-prev.timestamp)/1000);
    const d=haversineMeters(prev,cur);
    const implied=d/dt;

    const jumpScore=Math.min(1,d/this.cfg.maxJumpM);
    const speedScore=Math.min(1,Math.max(0,(implied-this.cfg.maxPlausibleSpeedMps)/this.cfg.maxPlausibleSpeedMps));

    let headingScore=0;
    if(prev.headingDeg!=null && cur.headingDeg!=null) {
      const delta=angleDeltaDeg(prev.headingDeg,cur.headingDeg);
      const maxTurn=dt<1 ? 120 : Math.min(180,60*dt);
      headingScore=Math.min(1,Math.max(0,(delta-maxTurn)/90));
    }

    const age=Math.max(0,now-cur.timestamp);
    const freshnessScore=Math.max(0,1-age/this.cfg.maxFreshAgeMs);
    const accuracyQuality=cur.accuracyM==null ? .5 : Math.max(0,Math.min(1,1-cur.accuracyM/this.cfg.accuracyBadM));

    const anomalyScore =
      .30*jumpScore +
      .25*speedScore +
      .15*headingScore +
      .20*(1-accuracyQuality) +
      .10*(1-freshnessScore);

    return {
      anomalyScore,
      jumpScore,
      speedScore,
      headingScore,
      freshnessScore,
      trusted: anomalyScore < .35 && accuracyQuality > .45 && freshnessScore > .5
    };
  }
}
