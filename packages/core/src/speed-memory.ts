// How fast this driver really goes on each ~200 m stretch of road, by time of
// day and direction — learned from trusted GNSS while driving, used when GNSS
// is gone and the last measured speed has gone stale (a free, personal
// substitute for a traffic feed). Stored on the phone; no coordinates leave it.
import type { LatLon } from "./types";

type Cell = { mps: number; n: number; at: number };

const LAT_STEP = 1 / 500;   // ≈ 222 m
const LON_STEP = 1 / 330;   // ≈ 217 m at 50°N
const MAX_CELLS = 20_000;
const ALPHA = 0.2;

function hourBucket(ms: number): number {
  const h = new Date(ms).getHours();
  return h < 6 ? 0 : h < 10 ? 1 : h < 16 ? 2 : h < 20 ? 3 : 4;
}
function sector(headingDeg: number | null): number | "x" {
  return headingDeg == null || !Number.isFinite(headingDeg) ? "x" : Math.floor((((headingDeg % 360) + 360) % 360 + 45) / 90) % 4;
}
function cellKey(p: LatLon): string {
  return `${Math.round(p.lat / LAT_STEP)}:${Math.round(p.lon / LON_STEP)}`;
}

export class SpeedMemory {
  private cells = new Map<string, Cell>();

  constructor(data?: Record<string, Cell>) {
    if (data) for (const [k, v] of Object.entries(data)) if (v && Number.isFinite(v.mps) && v.n > 0) this.cells.set(k, v);
  }

  /** A trusted fix while driving (moving speeds only: stops are handled by the motion sensor). */
  learn(p: LatLon, speedMps: number | null, headingDeg: number | null, tMs: number): void {
    if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 2 || speedMps > 60) return;
    for (const key of [`${cellKey(p)}|${hourBucket(tMs)}|${sector(headingDeg)}`, `${cellKey(p)}|*|${sector(headingDeg)}`]) {
      const c = this.cells.get(key);
      this.cells.set(key, c ? { mps: c.mps + ALPHA * (speedMps - c.mps), n: c.n + 1, at: tMs } : { mps: speedMps, n: 1, at: tMs });
    }
    if (this.cells.size > MAX_CELLS) {
      const oldest = [...this.cells.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.cells.size - MAX_CELLS);
      for (const [k] of oldest) this.cells.delete(k);
    }
  }

  /** The learned speed here (same time of day if known, else any), when seen at least 3 times. */
  lookup(p: LatLon, headingDeg: number | null, tMs: number): { mps: number; n: number } | null {
    const base = cellKey(p);
    for (const key of [`${base}|${hourBucket(tMs)}|${sector(headingDeg)}`, `${base}|*|${sector(headingDeg)}`, `${base}|*|x`]) {
      const c = this.cells.get(key);
      if (c && c.n >= 3) return { mps: c.mps, n: c.n };
    }
    return null;
  }

  size(): number { return this.cells.size; }
  toJSON(): Record<string, Cell> { return Object.fromEntries(this.cells); }
}
