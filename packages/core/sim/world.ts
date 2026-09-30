// Synthetic road networks for the GNSS-denied navigation Monte Carlo.
// Three kinds, all generated from a seed:
//   urban    — jittered street grid with missing links and diagonals (many junctions, short blocks)
//   suburban — sparse grid whose roads bend (degree-2 shape nodes), longer blocks
//   highway  — a long curving road with side roads branching off every 1–3 km
// These are synthetic — they exercise the navigator's logic on realistic
// junction densities and road shapes, not on a real city's map.

import type { DemoRoadGraph, DemoRoadEdge, DemoRoadNode } from "../src/demo-routing-provider";
import type { LatLon } from "../src/types";
import { Rng } from "../src/resilient/resilient-navigator";

export type WorldKind = "urban" | "suburban" | "highway";

export type SimWorld = {
  kind: WorldKind;
  graph: DemoRoadGraph;
  origin: string;
  destination: string;
  /** Typical cruise speed range for this world, m/s. */
  cruise: [number, number];
  /** Probability of stopping (traffic light) at a junction. */
  stopProb: number;
};

const M = 111_320;

function toLatLon(base: LatLon, x: number, y: number): LatLon {
  return { lat: base.lat + y / M, lon: base.lon + x / (M * Math.cos((base.lat * Math.PI) / 180)) };
}

function connected(nodes: DemoRoadNode[], edges: DemoRoadEdge[]): boolean {
  if (nodes.length === 0) return true;
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) { adj.get(e.fromId)!.push(e.toId); adj.get(e.toId)!.push(e.fromId); }
  const seen = new Set([nodes[0]!.id]);
  const stack = [nodes[0]!.id];
  while (stack.length) for (const m of adj.get(stack.pop()!)!) if (!seen.has(m)) { seen.add(m); stack.push(m); }
  return seen.size === nodes.length;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) { return Math.hypot(a.x - b.x, a.y - b.y); }

function gridWorld(rng: Rng, base: LatLon, kind: "urban" | "suburban"): SimWorld {
  const R = kind === "urban" ? 7 + Math.floor(rng.next() * 6) : 5 + Math.floor(rng.next() * 3);
  const C = kind === "urban" ? 7 + Math.floor(rng.next() * 6) : 5 + Math.floor(rng.next() * 3);
  const sx = kind === "urban" ? rng.uniform(110, 280) : rng.uniform(300, 600);
  const sy = kind === "urban" ? rng.uniform(110, 280) : rng.uniform(300, 600);
  const pts: { x: number; y: number }[][] = [];
  const nodes: DemoRoadNode[] = [];
  for (let r = 0; r < R; r++) {
    pts.push([]);
    for (let c = 0; c < C; c++) {
      const x = c * sx + rng.normal() * sx * 0.08, y = r * sy + rng.normal() * sy * 0.08;
      pts[r]!.push({ x, y });
      nodes.push({ id: `n${r}_${c}`, position: toLatLon(base, x, y) });
    }
  }
  let edges: DemoRoadEdge[] = [];
  const shapeNodes: DemoRoadNode[] = [];
  let sid = 0;
  const addRoad = (a: string, b: string, pa: { x: number; y: number }, pb: { x: number; y: number }, name: string) => {
    if (kind === "suburban") {
      // Bend the road through 1–3 shape nodes.
      const k = 1 + Math.floor(rng.next() * 3);
      const len = dist(pa, pb);
      const nx = -(pb.y - pa.y) / len, ny = (pb.x - pa.x) / len;
      let prev = a;
      for (let j = 1; j <= k; j++) {
        const t = j / (k + 1);
        const bend = rng.normal() * len * 0.08;
        const id = `s${sid++}`;
        shapeNodes.push({ id, position: toLatLon(base, pa.x + (pb.x - pa.x) * t + nx * bend, pa.y + (pb.y - pa.y) * t + ny * bend) });
        edges.push({ id: `e${edges.length}`, fromId: prev, toId: id, roadName: name });
        prev = id;
      }
      edges.push({ id: `e${edges.length}`, fromId: prev, toId: b, roadName: name });
    } else {
      edges.push({ id: `e${edges.length}`, fromId: a, toId: b, roadName: name });
    }
  };
  // Candidate links, some dropped.
  const links: [number, number, number, number, string][] = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (c + 1 < C) links.push([r, c, r, c + 1, `вул. Поперечна ${r + 1}`]);
    if (r + 1 < R) links.push([r, c, r + 1, c, `вул. Поздовжня ${c + 1}`]);
    if (r + 1 < R && c + 1 < C && rng.next() < 0.04) links.push([r, c, r + 1, c + 1, `просп. Діагональний ${r + 1}`]);
  }
  const kept = links.filter(() => rng.next() > 0.12);
  const build = (ls: typeof links) => {
    edges = [];
    shapeNodes.length = 0;
    sid = 0;
    for (const [r1, c1, r2, c2, name] of ls) addRoad(`n${r1}_${c1}`, `n${r2}_${c2}`, pts[r1]![c1]!, pts[r2]![c2]!, name);
  };
  build(kept);
  if (!connected([...nodes, ...shapeNodes], edges)) build(links);
  const all = [...nodes, ...shapeNodes];
  // Origin/destination: grid nodes at least ~1.2 km apart.
  let o = "", d = "";
  for (let tries = 0; tries < 200; tries++) {
    const a = nodes[Math.floor(rng.next() * nodes.length)]!, b = nodes[Math.floor(rng.next() * nodes.length)]!;
    const [ra, ca] = a.id.slice(1).split("_").map(Number), [rb, cb] = b.id.slice(1).split("_").map(Number);
    if (dist(pts[ra!]![ca!]!, pts[rb!]![cb!]!) > (kind === "urban" ? 1200 : 1800)) { o = a.id; d = b.id; break; }
  }
  if (!o) { o = nodes[0]!.id; d = nodes[nodes.length - 1]!.id; }
  return {
    kind, graph: { nodes: all, edges }, origin: o, destination: d,
    cruise: kind === "urban" ? [8, 14] : [12, 20],
    stopProb: kind === "urban" ? 0.3 : 0.12,
  };
}

function highwayWorld(rng: Rng, base: LatLon): SimWorld {
  const nodes: DemoRoadNode[] = [];
  const edges: DemoRoadEdge[] = [];
  const totalM = rng.uniform(8_000, 20_000);
  let x = 0, y = 0, heading = rng.uniform(0, 360), along = 0, i = 0;
  const main: string[] = [];
  let nextJunction = rng.uniform(1_000, 2_500);
  let jid = 0;
  nodes.push({ id: "h0", position: toLatLon(base, x, y) });
  main.push("h0");
  while (along < totalM) {
    const seg = rng.uniform(250, 600);
    heading += rng.normal() * 9;
    x += seg * Math.sin((heading * Math.PI) / 180);
    y += seg * Math.cos((heading * Math.PI) / 180);
    along += seg;
    i++;
    const id = `h${i}`;
    nodes.push({ id, position: toLatLon(base, x, y) });
    edges.push({ id: `e${edges.length}`, fromId: main[main.length - 1]!, toId: id, roadName: "Траса М-03" });
    main.push(id);
    if (along >= nextJunction) {
      // A side road: 2–4 segments, turning off to either side.
      const side = rng.next() < 0.5 ? -1 : 1;
      let sxp = x, syp = y, sh = heading + side * rng.uniform(60, 110), prev = id;
      const k = 2 + Math.floor(rng.next() * 3);
      for (let j = 0; j < k; j++) {
        const len = rng.uniform(200, 500);
        sh += rng.normal() * 15;
        sxp += len * Math.sin((sh * Math.PI) / 180);
        syp += len * Math.cos((sh * Math.PI) / 180);
        const sidn = `j${jid}_${j}`;
        nodes.push({ id: sidn, position: toLatLon(base, sxp, syp) });
        edges.push({ id: `e${edges.length}`, fromId: prev, toId: sidn, roadName: `вул. Бічна ${jid + 1}` });
        prev = sidn;
      }
      jid++;
      nextJunction = along + rng.uniform(1_000, 3_000);
    }
  }
  // Destination: the end of the highway, or the end of a side road in the second half.
  const sideEnds = nodes.filter((n) => n.id.startsWith("j") && edges.every((e) => e.fromId !== n.id));
  const farSide = sideEnds.filter((n) => Number(n.id.slice(1).split("_")[0]) >= Math.floor(jid / 2));
  const d = farSide.length > 0 && rng.next() < 0.6 ? farSide[Math.floor(rng.next() * farSide.length)]!.id : main[main.length - 1]!;
  return { kind: "highway", graph: { nodes, edges }, origin: "h0", destination: d, cruise: [20, 30], stopProb: 0.03 };
}

export function generateWorld(rng: Rng, kind: WorldKind): SimWorld {
  const base = { lat: 50.2 + rng.uniform(0, 0.5), lon: 30.2 + rng.uniform(0, 0.7) }; // Kyiv region
  return kind === "highway" ? highwayWorld(rng, base) : gridWorld(rng, base, kind);
}
