// Turns felt by the phone's gyroscope (yaw about the vertical axis, from
// MotionPreprocessor's per-second summaries), for guidance without GNSS: a
// felt turn that matches a route maneuver places the car at that junction; a
// felt turn where the route goes straight is probably a wrong turn.
import type { NavigatorMotion } from "./resilient/resilient-navigator";
import type { Route } from "./route-engine";
import { RouteGeometryIndex } from "./route-geometry";
import { initialBearing } from "./geodesy";

export type TurnEvent = {
  /** Heading change, degrees, clockwise (right) positive. */
  deltaDeg: number;
  /** When the heading settled again. */
  endMs: number;
  durationS: number;
  /** Whether the sign convention of this phone's mount has been learned (else only the size counts). */
  signReliable: boolean;
};

const START_DPS = 5;
const QUIET_DPS = 3;
const MIN_TURN_DEG = 40;

export class TurnDetector {
  private active = false;
  private sum = 0;
  private startMs = 0;
  private quiet = 0;

  /** One per-second motion summary; returns a turn when one has just finished. */
  push(m: NavigatorMotion, tMs: number, signReliable: boolean): TurnEvent | null {
    const r = m.yawRateDps;
    if (!Number.isFinite(r)) return null;
    if (!this.active) {
      if (Math.abs(r) >= START_DPS) { this.active = true; this.sum = r; this.startMs = tMs - 1000; this.quiet = 0; }
      return null;
    }
    this.sum += r;
    this.quiet = Math.abs(r) < QUIET_DPS ? this.quiet + 1 : 0;
    const durationS = (tMs - this.startMs) / 1000;
    if (this.quiet >= 2 || durationS > 30) {
      this.active = false;
      if (Math.abs(this.sum) >= MIN_TURN_DEG) return { deltaDeg: this.sum, endMs: tMs - this.quiet * 1000, durationS: durationS - this.quiet, signReliable };
    }
    return null;
  }

  reset(): void { this.active = false; this.sum = 0; this.quiet = 0; }
}

export type RouteTurn = { stepIndex: number; progressM: number; angleDeg: number };

const wrap = (d: number) => ((d + 540) % 360) - 180;

/** The route's real turns (≥ 30°) with where they are along it and their signed angle (right positive). */
export function routeTurns(route: Route, index = new RouteGeometryIndex(route.geometry)): RouteTurn[] {
  const out: RouteTurn[] = [];
  route.steps.forEach((step, i) => {
    if (step.maneuver === "depart" || step.maneuver === "arrive") return;
    const proj = index.project(step.location);
    if (!proj) return;
    const at = proj.alongM;
    const before = step.bearingBefore ?? initialBearing(index.pointAt(Math.max(0, at - 30)), index.pointAt(at));
    const after = step.bearingAfter ?? initialBearing(index.pointAt(at), index.pointAt(Math.min(index.lengthM, at + 30)));
    const angle = wrap(after - before);
    if (Math.abs(angle) >= 30) out.push({ stepIndex: i, progressM: at, angleDeg: angle });
  });
  return out;
}

/**
 * Which route turn a felt turn is, if any: the nearest one to where dead
 * reckoning expects the car, within the error bar, of a compatible size and
 * (when the mount's sign is known) direction.
 */
export function matchTurn(ev: TurnEvent, expectedProgressM: number, sigmaM: number, turns: RouteTurn[]): RouteTurn | null {
  const window = sigmaM + 250;
  let best: RouteTurn | null = null;
  for (const t of turns) {
    if (Math.abs(t.progressM - expectedProgressM) > window) continue;
    const sizeOk = Math.abs(Math.abs(t.angleDeg) - Math.abs(ev.deltaDeg)) <= 60;
    const signOk = !ev.signReliable || Math.sign(t.angleDeg) === Math.sign(ev.deltaDeg);
    if (!sizeOk || !signOk) continue;
    if (!best || Math.abs(t.progressM - expectedProgressM) < Math.abs(best.progressM - expectedProgressM)) best = t;
  }
  return best;
}

/**
 * The route's heading as a function of distance along it (unwrapped, so a
 * motorway loop is +270°, not −90°): a felt turn is compared with how much
 * the ROUTE turns over a stretch of the same length — curves, ramps and loops
 * included, not only the maneuver points.
 */
export class RouteHeadingProfile {
  private readonly at: number[] = [];
  private readonly heading: number[] = [];

  constructor(readonly index: RouteGeometryIndex) {
    const g = index.geometry;
    let acc = 0;
    let prev: number | null = null;
    for (let i = 1; i < g.length; i++) {
      const seg = index.cumulativeM[i]! - index.cumulativeM[i - 1]!;
      if (seg < 0.5) continue;
      const b = initialBearing(g[i - 1]!, g[i]!);
      if (prev != null) acc += wrap(b - prev);
      prev = b;
      this.at.push(index.cumulativeM[i - 1]!);
      this.heading.push(acc);
    }
  }

  /** Unwrapped heading at `m` metres along the route. */
  headingAt(m: number): number {
    const a = this.at;
    if (a.length === 0) return 0;
    let lo = 0, hi = a.length - 1;
    if (m <= a[0]!) return this.heading[0]!;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid]! <= m) lo = mid; else hi = mid - 1; }
    return this.heading[lo]!;
  }

  /** How much the route turns between a and b (right positive). */
  change(a: number, b: number): number {
    return this.headingAt(b) - this.headingAt(a);
  }
}

/**
 * Where along the route a felt turn happened: the end point whose preceding
 * stretch (≈ the distance driven during the turn) turns the same amount.
 * null when nothing fits or two far-apart places fit equally (no guessing).
 */
export function matchTurnOnProfile(ev: TurnEvent, expectedEndM: number, sigmaM: number, turnLengthM: number, profile: RouteHeadingProfile): { endM: number; errorDeg: number } | null {
  // Proportional to the error bar: with a tight estimate a bend 250 m back is not "this" turn.
  const window = Math.max(100, 2 * sigmaM + 60);
  const lengths = [0.6, 1, 1.5].map((k) => Math.max(20, k * turnLengthM + 20));
  const fits: { endM: number; err: number }[] = [];
  const lo = Math.max(0, expectedEndM - window), hi = Math.min(profile.index.lengthM, expectedEndM + window);
  for (let m = lo; m <= hi; m += 10) {
    let best = Infinity;
    for (const L of lengths) {
      const c = profile.change(Math.max(0, m - L), m);
      const err = ev.signReliable ? Math.abs(c - ev.deltaDeg) : Math.abs(Math.abs(c) - Math.abs(ev.deltaDeg));
      best = Math.min(best, err);
    }
    fits.push({ endM: m, err: best });
  }
  const tol = Math.max(20, 0.25 * Math.abs(ev.deltaDeg));
  // Contiguous runs of fitting end points: after a bend the heading stays
  // flat, so every later end point "contains" the same bend — one run is one
  // bend. Two separate runs that fit about equally → ambiguous, no guess.
  const runs: { endM: number; err: number }[][] = [];
  for (const f of fits) {
    if (f.err > tol) continue;
    const last = runs[runs.length - 1];
    if (last && f.endM - last[last.length - 1]!.endM <= 20) last.push(f); else runs.push([f]);
  }
  // A run that starts right at the window's near edge is the tail of a bend that
  // ended before the window (outside the error bar): not this turn.
  const inside = runs.filter((r) => lo <= 0 || r[0]!.endM > lo + 10);
  if (inside.length === 0) return null;
  const scored = inside.map((r) => ({ r, err: Math.min(...r.map((f) => f.err)) })).sort((a, b) => a.err - b.err);
  const best = scored[0]!;
  if (scored[1] && scored[1].err <= best.err + 12) return null;
  // The bend ends where the run starts fitting well (the first near-best point).
  const endM = best.r.find((f) => f.err <= best.err + 5)!.endM;
  return { endM, errorDeg: best.err };
}
