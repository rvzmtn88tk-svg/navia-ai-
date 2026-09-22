export type ConfidenceInputs = {
  gnssQuality:number;          // 0..1
  freshness:number;            // 0..1
  sensorAgreement:number;      // 0..1
  mapMatchQuality:number;      // 0..1
  routeConsistency:number;     // 0..1
};

export type ConfidenceResult = {
  value:number;
  band:"HIGH"|"MEDIUM"|"LOW"|"UNKNOWN";
};

export function calculateConfidence(i:ConfidenceInputs):ConfidenceResult {
  const value=Math.max(0,Math.min(1,
    .28*i.gnssQuality+
    .16*i.freshness+
    .18*i.sensorAgreement+
    .22*i.mapMatchQuality+
    .16*i.routeConsistency
  ));
  const band=value>=.75?"HIGH":value>=.5?"MEDIUM":value>=.25?"LOW":"UNKNOWN";
  return {value,band};
}
