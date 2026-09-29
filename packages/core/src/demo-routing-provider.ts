// DemoRoutingProvider — one of the three providers spec section 11 names
// (the other two, Online/OfflineValhallaProvider, need a running Valhalla
// instance this sandbox doesn't have — see route-engine.ts header).
//
// This is a REAL routing engine over a small, hand-authored, typed road
// graph — an actual Dijkstra shortest-path search, not a hardcoded canned
// route. It exists to make the RoutingProvider abstraction concretely
// testable and to drive DemoEngine (task queued for later). It reports
// `source: "demo"` on every Route so nothing downstream can mistake it for
// live routing data (spec section 40).

import type { LatLon, RouteStep } from "./types";
import { haversineMeters, initialBearing, angleDeltaDeg } from "./geodesy";
import type { Route, RouteRequest, RoutingProvider, MapMatchResult } from "./route-engine";
import { requestedPreferenceKeys } from "./route-engine";
import { RouteGeometryIndex } from "./route-geometry";

export type DemoRoadNode = {
  id: string;
  position: LatLon;
};

export type DemoRoadEdge = {
  id: string;
  fromId: string;
  toId: string;
  roadName: string;
  /** Directed: true if travel is only allowed fromId -> toId. */
  oneWay?: boolean;
};

export type DemoRoadGraph = {
  nodes: DemoRoadNode[];
  edges: DemoRoadEdge[];
};

const AVERAGE_SPEED_MPS = 11; // ~40 km/h, a reasonable urban demo pace

function maneuverFor(turnDeltaDeg: number): RouteStep["maneuver"] {
  const d = ((turnDeltaDeg + 540) % 360) - 180; // -180..180
  if (Math.abs(d) < 12) return "straight";
  if (Math.abs(d) > 150) return "uturn";
  return d < 0 ? "left" : "right";
}

/** Real Dijkstra shortest-path search by distance over the demo graph. */
function shortestPath(graph: DemoRoadGraph, fromId: string, toId: string, excludeEdgeId?: string): DemoRoadEdge[] | null {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, DemoRoadEdge[]>();
  for (const e of graph.edges) {
    if (e.id === excludeEdgeId) continue;
    if (!adjacency.has(e.fromId)) adjacency.set(e.fromId, []);
    adjacency.get(e.fromId)!.push(e);
    if (!e.oneWay) {
      if (!adjacency.has(e.toId)) adjacency.set(e.toId, []);
      adjacency.get(e.toId)!.push({ ...e, fromId: e.toId, toId: e.fromId });
    }
  }

  const dist = new Map<string, number>([[fromId, 0]]);
  const prevEdge = new Map<string, DemoRoadEdge>();
  const visited = new Set<string>();
  const unvisited = new Set(graph.nodes.map((n) => n.id));

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDist = Infinity;
    for (const id of unvisited) {
      const d = dist.get(id) ?? Infinity;
      if (d < currentDist) { currentDist = d; currentId = id; }
    }
    if (currentId === null || currentDist === Infinity) break;
    unvisited.delete(currentId);
    visited.add(currentId);
    if (currentId === toId) break;

    for (const edge of adjacency.get(currentId) ?? []) {
      if (visited.has(edge.toId)) continue;
      const a = nodeById.get(edge.fromId)!, b = nodeById.get(edge.toId)!;
      const edgeLen = haversineMeters(a.position, b.position);
      const candidate = currentDist + edgeLen;
      if (candidate < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, candidate);
        prevEdge.set(edge.toId, edge);
      }
    }
  }

  if (!dist.has(toId) || dist.get(toId) === Infinity) return null;

  const path: DemoRoadEdge[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const edge = prevEdge.get(cursor);
    if (!edge) return null;
    path.unshift(edge);
    cursor = edge.fromId;
  }
  return path;
}

function nearestNode(graph: DemoRoadGraph, p: LatLon): DemoRoadNode {
  let best = graph.nodes[0]!;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const d = haversineMeters(p, n.position);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function edgesToRoute(graph: DemoRoadGraph, edges: DemoRoadEdge[], id: string): Route {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const geometry: LatLon[] = [];
  const legLengths: number[] = [];
  for (const e of edges) {
    const a = nodeById.get(e.fromId)!.position;
    const b = nodeById.get(e.toId)!.position;
    if (geometry.length === 0) geometry.push(a);
    geometry.push(b);
    legLengths.push(haversineMeters(a, b));
  }

  const steps: RouteStep[] = [];
  let bearingBefore: number | undefined;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const a = nodeById.get(edge.fromId)!.position;
    const b = nodeById.get(edge.toId)!.position;
    const bearingAfter = initialBearing(a, b);
    const maneuver: RouteStep["maneuver"] =
      i === 0 ? "depart" : maneuverFor(angleDeltaDeg(bearingBefore ?? bearingAfter, bearingAfter));
    steps.push({
      id: `step-${i}`,
      roadName: edge.roadName,
      maneuver,
      distanceM: legLengths[i]!,
      durationS: legLengths[i]! / AVERAGE_SPEED_MPS,
      location: a,
      bearingBefore,
      bearingAfter,
      roadSegmentId: edge.id,
    });
    bearingBefore = bearingAfter;
  }
  // Arrival step: zero-length maneuver at the final node.
  const lastNode = nodeById.get(edges[edges.length - 1]!.toId)!;
  steps.push({
    id: `step-${edges.length}`,
    roadName: edges[edges.length - 1]!.roadName,
    maneuver: "arrive",
    distanceM: 0,
    durationS: 0,
    location: lastNode.position,
    bearingBefore,
    roadSegmentId: edges[edges.length - 1]!.id,
  });

  const distanceM = legLengths.reduce((a, b) => a + b, 0);
  return {
    id,
    steps,
    geometry,
    distanceM,
    durationS: distanceM / AVERAGE_SPEED_MPS,
    source: "demo",
  };
}

/** Points farther than this from every graph node are attached by splitting the nearest edge. */
const SNAP_TO_NODE_M = 30;

/**
 * Attach an off-node point to the graph: project it onto the nearest edge,
 * split that edge at the projection, and return the (possibly new) node id
 * plus how far the real point is from the road. Mirrors what a real routing
 * engine does when it snaps a location to the nearest road edge.
 */
function attachPoint(graph: DemoRoadGraph, p: LatLon, tag: string): { graph: DemoRoadGraph; nodeId: string; offsetM: number } {
  const node = nearestNode(graph, p);
  const nodeDist = haversineMeters(node.position, p);
  if (nodeDist <= SNAP_TO_NODE_M) return { graph, nodeId: node.id, offsetM: nodeDist };

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  let best: { edge: DemoRoadEdge; projected: LatLon; offsetM: number; alongM: number; lenM: number } | null = null;
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.fromId)!.position, b = nodeById.get(edge.toId)!.position;
    const idx = new RouteGeometryIndex([a, b]);
    const proj = idx.project(p);
    if (proj && (!best || proj.offsetM < best.offsetM)) {
      best = { edge, projected: proj.projected, offsetM: proj.offsetM, alongM: proj.alongM, lenM: idx.lengthM };
    }
  }
  if (!best || best.offsetM >= nodeDist) return { graph, nodeId: node.id, offsetM: nodeDist };
  if (best.alongM < SNAP_TO_NODE_M) return { graph, nodeId: best.edge.fromId, offsetM: haversineMeters(nodeById.get(best.edge.fromId)!.position, p) };
  if (best.lenM - best.alongM < SNAP_TO_NODE_M) return { graph, nodeId: best.edge.toId, offsetM: haversineMeters(nodeById.get(best.edge.toId)!.position, p) };

  const splitId = `split:${tag}`;
  const e = best.edge;
  return {
    nodeId: splitId,
    offsetM: best.offsetM,
    graph: {
      nodes: [...graph.nodes, { id: splitId, position: best.projected }],
      edges: [
        ...graph.edges.filter((x) => x.id !== e.id),
        { ...e, id: `${e.id}#a`, toId: splitId },
        { ...e, id: `${e.id}#b`, fromId: splitId },
      ],
    },
  };
}

export class DemoRoutingProvider implements RoutingProvider {
  constructor(private graph: DemoRoadGraph) {}

  async route(request: RouteRequest): Promise<Route> {
    const waypoints = request.waypoints ?? [];
    const unsupported = requestedPreferenceKeys(request.preferences);
    if (waypoints.length === 0) {
      const route = await this.routeBetween(this.graph, request.origin, request.destination, "o", "d");
      return unsupported.length > 0 ? { ...route, appliedPreferences: [], unsupportedPreferences: unsupported } : route;
    }

    // Multi-leg: origin -> wp1 -> ... -> destination. Each waypoint is
    // attached to the graph at its nearest edge; the short access spur from
    // the road to the waypoint itself is driven there and back, so the
    // route genuinely passes through the stop.
    const legs: Route[] = [];
    const points = [request.origin, ...waypoints, request.destination];
    for (let i = 0; i < points.length - 1; i++) {
      const leg = await this.routeBetween(this.graph, points[i]!, points[i + 1]!, `p${i}`, `p${i + 1}`, i > 0, i + 1 < points.length - 1);
      legs.push(leg);
    }
    // Every intermediate leg ends at a stop, so its "arrive" is kept.
    return concatenateLegs(legs, `demo-route-multi-${legs.map((l) => l.id).join("+")}`, true, {
      waypointCount: waypoints.length,
      appliedPreferences: [],
      unsupportedPreferences: unsupported,
    });
  }

  private async routeBetween(
    baseGraph: DemoRoadGraph, from: LatLon, to: LatLon, fromTag: string, toTag: string,
    fromIsStop = false, toIsStop = false,
  ): Promise<Route> {
    let graph = baseGraph;
    const origin = attachPoint(graph, from, fromTag);
    graph = origin.graph;
    const dest = attachPoint(graph, to, toTag);
    graph = dest.graph;
    if (origin.nodeId === dest.nodeId) {
      throw new Error(`DemoRoutingProvider: origin and destination snap to the same point (${origin.nodeId})`);
    }
    const path = shortestPath(graph, origin.nodeId, dest.nodeId);
    if (!path || path.length === 0) {
      throw new Error(`DemoRoutingProvider: no route found between ${origin.nodeId} and ${dest.nodeId}`);
    }
    const route = edgesToRoute(graph, path, `demo-route-${origin.nodeId}-${dest.nodeId}`);
    // Out-and-back access spurs for stops that sit off the road network.
    const spur = (p: LatLon, offsetM: number): Route | null =>
      offsetM > SNAP_TO_NODE_M ? accessSpur(p, offsetM) : null;
    const pre = fromIsStop ? spur(from, origin.offsetM) : null;
    const post = toIsStop ? spur(to, dest.offsetM) : null;
    if (!pre && !post) return route;
    const parts: Route[] = [];
    if (pre) parts.push(reverseSpur(pre, route.geometry[0]!));
    parts.push(route);
    if (post) parts.push(forwardSpur(post, route.geometry[route.geometry.length - 1]!));
    // The road route's own zero-length "arrive" at the spur junction is not a real arrival.
    return concatenateLegs(parts, route.id, false, {});
  }

  async searchAlternatives(request: RouteRequest): Promise<Route[]> {
    const primary = await this.route(request);
    // Like Valhalla, alternatives are only offered for plain A->B requests.
    if ((request.waypoints?.length ?? 0) > 0) return [primary];
    // Attach origin/destination exactly as route() does, so the alternative
    // starts where the car is (not at the previous graph node behind it).
    let graph = this.graph;
    const o = attachPoint(graph, request.origin, "o");
    graph = o.graph;
    const d = attachPoint(graph, request.destination, "d");
    graph = d.graph;
    const path = shortestPath(graph, o.nodeId, d.nodeId);
    const firstEdgeId = path?.[0]?.id;
    // Real alternative-search strategy: exclude the first edge of the
    // shortest path and re-run Dijkstra; if the graph offers a genuinely
    // different way through, this finds it. If not, there is no honest
    // alternative to offer, so only the primary route is returned.
    const altPath = firstEdgeId ? shortestPath(graph, o.nodeId, d.nodeId, firstEdgeId) : null;
    if (!altPath || altPath.length === 0) return [primary];
    const alt = edgesToRoute(graph, altPath, `demo-route-alt-${o.nodeId}-${d.nodeId}`);
    if (alt.distanceM === primary.distanceM) return [primary];
    const unsupported = requestedPreferenceKeys(request.preferences);
    return [primary, unsupported.length > 0 ? { ...alt, appliedPreferences: [], unsupportedPreferences: unsupported } : alt];
  }

  async match(points: LatLon[]): Promise<MapMatchResult> {
    // Demo-quality nearest-node matching (not full polyline projection —
    // that's what map-matcher.ts's chooseRoad does for the live position
    // stream; this is only used for coarse trace matching in the demo).
    const matchedPoints: LatLon[] = [];
    const roadSegmentIds: (string | null)[] = [];
    for (const p of points) {
      const node = nearestNode(this.graph, p);
      matchedPoints.push(node.position);
      const edge = this.graph.edges.find((e) => e.fromId === node.id || e.toId === node.id);
      roadSegmentIds.push(edge?.id ?? null);
    }
    return { matchedPoints, roadSegmentIds };
  }
}

const ACCESS_ROAD_NAME = "під'їзд (demo)";

function accessSpur(stop: LatLon, offsetM: number): Route {
  return {
    id: "spur", steps: [], geometry: [stop], distanceM: offsetM,
    durationS: offsetM / 8.3, source: "demo",
  };
}

/** Road point -> stop (the car turns off the route and drives to the stop). */
function forwardSpur(spur: Route, roadPoint: LatLon): Route {
  const stop = spur.geometry[0]!;
  return {
    ...spur,
    geometry: [roadPoint, stop],
    steps: [
      { id: "spur-in", roadName: ACCESS_ROAD_NAME, maneuver: "right", distanceM: spur.distanceM, durationS: spur.durationS, location: roadPoint },
      { id: "spur-stop", roadName: ACCESS_ROAD_NAME, maneuver: "arrive", distanceM: 0, durationS: 0, location: stop },
    ],
  };
}

/** Stop -> road point (the car leaves the stop and rejoins the route). */
function reverseSpur(spur: Route, roadPoint: LatLon): Route {
  const stop = spur.geometry[0]!;
  return {
    ...spur,
    geometry: [stop, roadPoint],
    steps: [
      { id: "spur-out", roadName: ACCESS_ROAD_NAME, maneuver: "depart", distanceM: spur.distanceM, durationS: spur.durationS, location: stop },
    ],
  };
}

/** Join consecutive legs into one Route; intermediate zero-length "arrive" steps are dropped unless they mark stops. */
function concatenateLegs(legs: Route[], id: string, keepIntermediateArrivals: boolean, extra: Partial<Route>): Route {
  const geometry: LatLon[] = [];
  const steps: RouteStep[] = [];
  let distanceM = 0, durationS = 0;
  legs.forEach((leg, li) => {
    const isLast = li === legs.length - 1;
    for (const p of leg.geometry) {
      const prev = geometry[geometry.length - 1];
      if (!prev || prev.lat !== p.lat || prev.lon !== p.lon) geometry.push(p);
    }
    for (const step of leg.steps) {
      if (!isLast && !keepIntermediateArrivals && step.maneuver === "arrive" && step.distanceM === 0) continue;
      steps.push({ ...step, id: `step-${steps.length}` });
    }
    distanceM += leg.distanceM;
    durationS += leg.durationS;
  });
  return { id, steps, geometry, distanceM, durationS, source: "demo", ...extra };
}
