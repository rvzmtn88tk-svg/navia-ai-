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

export class DemoRoutingProvider implements RoutingProvider {
  constructor(private graph: DemoRoadGraph) {}

  async route(request: RouteRequest): Promise<Route> {
    const fromNode = nearestNode(this.graph, request.origin);
    const toNode = nearestNode(this.graph, request.destination);
    const path = shortestPath(this.graph, fromNode.id, toNode.id);
    if (!path || path.length === 0) {
      throw new Error(`DemoRoutingProvider: no route found between ${fromNode.id} and ${toNode.id}`);
    }
    return edgesToRoute(this.graph, path, `demo-route-${fromNode.id}-${toNode.id}`);
  }

  async searchAlternatives(request: RouteRequest): Promise<Route[]> {
    const primary = await this.route(request);
    const fromNode = nearestNode(this.graph, request.origin);
    const toNode = nearestNode(this.graph, request.destination);
    const firstEdgeId = primary.steps[0]?.roadSegmentId ?? undefined;
    // Real alternative-search strategy: exclude the first edge of the
    // shortest path and re-run Dijkstra; if the graph offers a genuinely
    // different way through, this finds it. If not, there is no honest
    // alternative to offer, so only the primary route is returned.
    const altPath = firstEdgeId ? shortestPath(this.graph, fromNode.id, toNode.id, firstEdgeId) : null;
    if (!altPath || altPath.length === 0) return [primary];
    const alt = edgesToRoute(this.graph, altPath, `demo-route-alt-${fromNode.id}-${toNode.id}`);
    if (alt.distanceM === primary.distanceM) return [primary];
    return [primary, alt];
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
