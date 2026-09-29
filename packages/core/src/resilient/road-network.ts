// RoadNetwork — the road graph the GNSS-denied navigator reasons over.
//
// Directed edges in a local metric frame (x east, y north, metres). Built
// either from a real road graph (the offline package / DemoRoadGraph) —
// which lets the navigator follow the car through junctions it takes off
// the route — or, when only a route polyline is known (e.g. a route from
// an online router with no local graph), from the route itself as a chain,
// which still constrains the car to the road it is expected to drive.

import type { LatLon } from "../types";
import type { Route } from "../route-engine";
import type { DemoRoadGraph } from "../demo-routing-provider";

export type NetworkNode = { x: number; y: number; id: string };

export type NetworkEdge = {
  index: number;
  from: number;
  to: number;
  length: number;
  /** Compass bearing of travel, degrees 0..360. */
  bearing: number;
  name: string;
  /** Index of the edge going the opposite way on the same road, or -1. */
  reverse: number;
};

const M_PER_DEG = 111_320;

export function wrapDeg(d: number): number {
  return ((d + 540) % 360) - 180;
}

export class RoadNetwork {
  readonly nodes: NetworkNode[] = [];
  readonly edges: NetworkEdge[] = [];
  /** Outgoing edge indices per node. */
  readonly out: number[][] = [];
  private cosLat: number;

  constructor(readonly origin: LatLon) {
    this.cosLat = Math.cos((origin.lat * Math.PI) / 180);
  }

  toLocal(p: LatLon): { x: number; y: number } {
    return { x: (p.lon - this.origin.lon) * M_PER_DEG * this.cosLat, y: (p.lat - this.origin.lat) * M_PER_DEG };
  }

  toLatLon(x: number, y: number): LatLon {
    return { lat: this.origin.lat + y / M_PER_DEG, lon: this.origin.lon + x / (M_PER_DEG * this.cosLat) };
  }

  addNode(p: LatLon, id: string): number {
    const { x, y } = this.toLocal(p);
    this.nodes.push({ x, y, id });
    this.out.push([]);
    return this.nodes.length - 1;
  }

  /** Add a road between two nodes (both directions unless oneWay). Returns the forward edge index. */
  addRoad(from: number, to: number, name: string, oneWay = false): number {
    const a = this.nodes[from]!, b = this.nodes[to]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const bearing = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
    const fwd: NetworkEdge = { index: this.edges.length, from, to, length, bearing, name, reverse: -1 };
    this.edges.push(fwd);
    this.out[from]!.push(fwd.index);
    if (!oneWay) {
      const rev: NetworkEdge = { index: this.edges.length, from: to, to: from, length, bearing: (bearing + 180) % 360, name, reverse: fwd.index };
      this.edges.push(rev);
      this.out[to]!.push(rev.index);
      fwd.reverse = rev.index;
    }
    return fwd.index;
  }

  pointOn(edge: number, offset: number): { x: number; y: number } {
    const e = this.edges[edge]!;
    const a = this.nodes[e.from]!, b = this.nodes[e.to]!;
    const t = e.length > 0 ? Math.max(0, Math.min(1, offset / e.length)) : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** Signed turn from edge `a` into edge `b`, degrees; + = right, − = left. */
  turn(a: number, b: number): number {
    return wrapDeg(this.edges[b]!.bearing - this.edges[a]!.bearing);
  }

  /** Nearest point on edge `e` to (x, y): offset along it and distance. */
  project(e: number, x: number, y: number): { offset: number; dist: number } {
    const edge = this.edges[e]!;
    const a = this.nodes[edge.from]!, b = this.nodes[edge.to]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    return { offset: t * edge.length, dist: Math.hypot(a.x + dx * t - x, a.y + dy * t - y) };
  }

  /** Edges within `radius` of (x, y), nearest first. */
  edgesNear(x: number, y: number, radius: number): { edge: number; offset: number; dist: number }[] {
    const out: { edge: number; offset: number; dist: number }[] = [];
    for (const e of this.edges) {
      const p = this.project(e.index, x, y);
      if (p.dist <= radius) out.push({ edge: e.index, offset: p.offset, dist: p.dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  static fromDemoGraph(graph: DemoRoadGraph): RoadNetwork {
    const net = new RoadNetwork(graph.nodes[0]?.position ?? { lat: 0, lon: 0 });
    const idx = new Map<string, number>();
    for (const n of graph.nodes) idx.set(n.id, net.addNode(n.position, n.id));
    for (const e of graph.edges) net.addRoad(idx.get(e.fromId)!, idx.get(e.toId)!, e.roadName, e.oneWay ?? false);
    return net;
  }

  /** A chain network along the route polyline only (no side roads). */
  static fromRoute(route: Route): RoadNetwork {
    const g = route.geometry;
    const net = new RoadNetwork(g[0] ?? { lat: 0, lon: 0 });
    let prev = -1;
    let cum = 0;
    let stepIdx = 0;
    let stepEnd = route.steps[0]?.distanceM ?? Infinity;
    for (let i = 0; i < g.length; i++) {
      const node = net.addNode(g[i]!, `r${i}`);
      if (prev >= 0) {
        const before = net.nodes[prev]!, cur = net.nodes[node]!;
        const segLen = Math.hypot(cur.x - before.x, cur.y - before.y);
        if (segLen < 0.5) { net.nodes.pop(); net.out.pop(); continue; }
        while (cum + segLen / 2 > stepEnd && stepIdx < route.steps.length - 1) { stepIdx++; stepEnd += route.steps[stepIdx]!.distanceM; }
        net.addRoad(prev, node, route.steps[stepIdx]?.roadName ?? "", true);
        cum += segLen;
      }
      prev = net.nodes.length - 1;
    }
    return net;
  }
}

/** One route segment mapped onto a network edge. */
export type RouteEdgeSpan = { edge: number; fromOffset: number; toOffset: number; alongStart: number };

/**
 * Map a route polyline onto network edges. Each route segment is matched to
 * the edge that contains it (both endpoints within `tol` metres of the edge,
 * same direction). Segments with no matching edge (e.g. an access spur to a
 * stop) are added to the network as new one-way edges so the chain stays
 * connected.
 */
export function mapRouteToNetwork(net: RoadNetwork, route: Route, tol = 3): RouteEdgeSpan[] {
  const spans: RouteEdgeSpan[] = [];
  const g = route.geometry.map((p) => net.toLocal(p));
  let along = 0;
  let lastNode = -1;
  const nodeAt = (x: number, y: number): number => {
    for (let i = 0; i < net.nodes.length; i++) if (Math.hypot(net.nodes[i]!.x - x, net.nodes[i]!.y - y) <= tol) return i;
    net.nodes.push({ x, y, id: `add${net.nodes.length}` });
    net.out.push([]);
    return net.nodes.length - 1;
  };
  for (let i = 0; i < g.length - 1; i++) {
    const p = g[i]!, q = g[i + 1]!;
    const segLen = Math.hypot(q.x - p.x, q.y - p.y);
    if (segLen < 0.5) continue;
    const segBearing = ((Math.atan2(q.x - p.x, q.y - p.y) * 180) / Math.PI + 360) % 360;
    let best: RouteEdgeSpan | null = null;
    for (const e of net.edges) {
      if (Math.abs(wrapDeg(e.bearing - segBearing)) > 10) continue;
      const pp = net.project(e.index, p.x, p.y), pq = net.project(e.index, q.x, q.y);
      if (pp.dist <= tol && pq.dist <= tol && pq.offset > pp.offset) {
        best = { edge: e.index, fromOffset: pp.offset, toOffset: pq.offset, alongStart: along };
        break;
      }
    }
    if (!best) {
      const a = lastNode >= 0 && Math.hypot(net.nodes[lastNode]!.x - p.x, net.nodes[lastNode]!.y - p.y) <= tol ? lastNode : nodeAt(p.x, p.y);
      const b = nodeAt(q.x, q.y);
      const e = net.addRoad(a, b, "", true);
      best = { edge: e, fromOffset: 0, toOffset: net.edges[e]!.length, alongStart: along };
    }
    // Merge consecutive segments on the same edge.
    const last = spans[spans.length - 1];
    if (last && last.edge === best.edge && Math.abs(last.toOffset - best.fromOffset) < tol) last.toOffset = best.toOffset;
    else spans.push(best);
    along += segLen;
    lastNode = net.edges[best.edge]!.to;
  }
  return spans;
}
