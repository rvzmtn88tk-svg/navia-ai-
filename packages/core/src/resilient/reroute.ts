// Rerouting after the ResilientNavigator detects that the car left the
// route. Without trustworthy GNSS the car's position is known as "on edge E,
// about O metres in", so the new route starts at the node AHEAD of the car
// (it can't turn around on the spot) with the rest of the current road
// prepended: never a route that begins by driving backwards.

import type { LatLon, RouteStep } from "../types";
import type { Route, RoutingProvider, RoutePreferences } from "../route-engine";
import { haversineMeters } from "../geodesy";
import { RoadNetwork, wrapDeg } from "./road-network";

/** Where a reroute should start: the next junction ahead of the car. */
export function rerouteOriginAhead(net: RoadNetwork, edge: number, offset: number): { here: LatLon; ahead: LatLon; restM: number } {
  const e = net.edges[edge]!;
  const here = net.pointOn(edge, offset), ahead = net.nodes[e.to]!;
  return { here: net.toLatLon(here.x, here.y), ahead: net.toLatLon(ahead.x, ahead.y), restM: Math.max(1, e.length - offset) };
}

/**
 * Prepend "the rest of the road the car is on" to a route that starts at
 * the junction ahead of it, and re-label the first maneuver relative to the
 * road the car arrives on.
 */
export function prependCurrentRoad(net: RoadNetwork, edge: number, offset: number, r: Route): Route {
  const e = net.edges[edge]!;
  const { here: hereLL, restM: rest } = rerouteOriginAhead(net, edge, offset);
  const lead: RouteStep = { id: "lead", roadName: e.name, maneuver: "depart", distanceM: rest, durationS: rest / 11, location: hereLL };
  const steps = r.steps.map((s) => ({ ...s }));
  if (steps[0] && r.geometry.length >= 2) {
    const g0 = net.toLocal(r.geometry[0]!), g1 = net.toLocal(r.geometry[1]!);
    const b = ((Math.atan2(g1.x - g0.x, g1.y - g0.y) * 180) / Math.PI + 360) % 360;
    const turn = wrapDeg(b - e.bearing);
    steps[0].maneuver = Math.abs(turn) < 30 ? "straight" : Math.abs(turn) > 160 ? "uturn" : turn > 0 ? "right" : "left";
  }
  return {
    ...r, id: `reroute-${r.id}`, steps: [lead, ...steps], geometry: [hereLL, ...r.geometry],
    distanceM: r.distanceM + rest, durationS: r.durationS + rest / 11,
  };
}

export async function rerouteFromEdge(
  router: RoutingProvider,
  net: RoadNetwork,
  edge: number,
  offset: number,
  destination: LatLon,
  options: { waypoints?: LatLon[]; preferences?: RoutePreferences } = {},
): Promise<Route | null> {
  const e = net.edges[edge]!;
  const { here: hereLL, ahead: aheadLL, restM: rest } = rerouteOriginAhead(net, edge, offset);
  if (haversineMeters(aheadLL, destination) < 5 && !(options.waypoints?.length)) {
    const lead: RouteStep = { id: "lead", roadName: e.name, maneuver: "depart", distanceM: rest, durationS: rest / 11, location: hereLL };
    return {
      id: "reroute", steps: [lead, { id: "arr", roadName: e.name, maneuver: "arrive", distanceM: 0, durationS: 0, location: aheadLL }],
      geometry: [hereLL, aheadLL], distanceM: rest, durationS: rest / 11, source: "demo",
    };
  }
  let r: Route;
  try { r = await router.route({ origin: aheadLL, destination, ...options }); } catch { return null; }
  return prependCurrentRoad(net, edge, offset, r);
}
