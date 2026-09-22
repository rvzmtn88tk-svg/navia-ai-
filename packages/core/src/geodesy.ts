// LatLon is the canonical shared type from ./types — re-exported here so
// existing imports of `LatLon` from "./geodesy" keep working unchanged.
import type {LatLon} from "./types";
export type {LatLon};

const R = 6371000;
const rad=(d:number)=>d*Math.PI/180;
const deg=(r:number)=>r*180/Math.PI;

export function haversineMeters(a:LatLon,b:LatLon):number {
  const p1=rad(a.lat), p2=rad(b.lat);
  const dp=rad(b.lat-a.lat), dl=rad(b.lon-a.lon);
  const x=Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

export function initialBearing(a:LatLon,b:LatLon):number {
  const y=Math.sin(rad(b.lon-a.lon))*Math.cos(rad(b.lat));
  const x=Math.cos(rad(a.lat))*Math.sin(rad(b.lat))
    - Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lon-a.lon));
  return (deg(Math.atan2(y,x))+360)%360;
}

export function destinationPoint(origin:LatLon,bearingDeg:number,distanceM:number):LatLon {
  const d=distanceM/R, br=rad(bearingDeg), p1=rad(origin.lat), l1=rad(origin.lon);
  const p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(br));
  const l2=l1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));
  return {lat:deg(p2),lon:((deg(l2)+540)%360)-180};
}

export function angleDeltaDeg(a:number,b:number):number {
  return Math.abs(((a-b+540)%360)-180);
}
