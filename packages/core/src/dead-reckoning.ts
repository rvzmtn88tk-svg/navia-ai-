import {LatLon,destinationPoint} from "./geodesy";

export type DeadReckoningInput = {
  position:LatLon;
  speedMps:number;
  headingDeg:number;
  dtSeconds:number;
};

export function deadReckon(i:DeadReckoningInput):LatLon {
  if (!Number.isFinite(i.speedMps) || !Number.isFinite(i.headingDeg) || i.dtSeconds<=0) return i.position;
  return destinationPoint(i.position,i.headingDeg,i.speedMps*i.dtSeconds);
}
