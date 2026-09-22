import {LatLon,haversineMeters,initialBearing,angleDeltaDeg} from "./geodesy";

export type RoadCandidate = {
  id:string;
  point:LatLon;
  roadBearingDeg:number;
  distanceM:number;
  routeContinuity:number; // 0..1
  speedCompatibility:number; // 0..1
};

export type MatchResult = {
  roadId:string|null;
  score:number;
  ambiguous:boolean;
};

export function scoreCandidate(
  candidate:RoadCandidate,
  user:LatLon,
  userHeading:number|null
):number {
  const distancePenalty=Math.min(1,candidate.distanceM/80);
  const headingPenalty=userHeading==null ? .5 :
    Math.min(1,angleDeltaDeg(userHeading,candidate.roadBearingDeg)/90);
  return .45*distancePenalty+
         .25*headingPenalty+
         .20*(1-candidate.routeContinuity)+
         .10*(1-candidate.speedCompatibility);
}

export function chooseRoad(
  candidates:RoadCandidate[],
  user:LatLon,
  userHeading:number|null,
  ambiguityMargin=.08
):MatchResult {
  if(!candidates.length) return {roadId:null,score:1,ambiguous:true};
  const ranked=candidates.map(c=>({id:c.id,score:scoreCandidate(c,user,userHeading)}))
    .sort((a,b)=>a.score-b.score);
  // ranked has at least one entry: candidates.length was checked above and
  // .map() preserves array length, so this index access is always in-bounds.
  const best=ranked[0]!, second=ranked[1];
  const ambiguous=!!second && second.score-best.score<ambiguityMargin;
  return {roadId:ambiguous?null:best.id,score:best.score,ambiguous};
}
