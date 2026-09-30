// Bridges, overpasses and underpasses felt on the barometer: the phone's
// relative altitude rises and falls by several metres within tens of seconds.
// Matched against the route's own bridges/tunnels (from the map), a hump or a
// dip places the car at the end of that structure — another anchor when GNSS
// is gone. Relative altitude only; absolute pressure drifts with the weather.

export type AltitudeEvent = { kind: "hump" | "dip"; endMs: number; sizeM: number };
export type RouteStructure = { kind: "bridge" | "tunnel"; fromM: number; toM: number };

const MIN_M = 3;
const MAX_SPAN_MS = 90_000;

export class AltitudeEventDetector {
  private samples: { t: number; alt: number }[] = [];
  private lastEventEnd = 0;

  /** Relative altitude (metres) at time t; returns a hump/dip that has just ended. */
  push(relAltM: number, tMs: number): AltitudeEvent | null {
    if (!Number.isFinite(relAltM)) return null;
    this.samples.push({ t: tMs, alt: relAltM });
    while (this.samples.length && tMs - this.samples[0]!.t > MAX_SPAN_MS) this.samples.shift();
    if (this.samples.length < 5) return null;
    // Smooth (median of 5) to reject pressure noise.
    const sm = this.samples.map((_, i, a) => { const w = a.slice(Math.max(0, i - 2), i + 3).map((x) => x.alt).sort((x, y) => x - y); return { t: a[i]!.t, alt: w[Math.floor(w.length / 2)]! }; });
    const now = sm[sm.length - 1]!;
    let hi = sm[0]!, lo = sm[0]!;
    for (const s of sm) { if (s.alt > hi.alt) hi = s; if (s.alt < lo.alt) lo = s; }
    const since = (s: { t: number }) => s.t > this.lastEventEnd;
    // Up then back down (a bridge/overpass) or down then back up (an underpass/tunnel).
    const start = sm.find(since) ?? sm[0]!;
    if (since(hi) && hi.alt - start.alt >= MIN_M && hi.alt - now.alt >= MIN_M && hi.t < now.t) {
      this.lastEventEnd = now.t; return { kind: "hump", endMs: now.t, sizeM: hi.alt - Math.min(start.alt, now.alt) };
    }
    if (since(lo) && start.alt - lo.alt >= MIN_M && now.alt - lo.alt >= MIN_M && lo.t < now.t) {
      this.lastEventEnd = now.t; return { kind: "dip", endMs: now.t, sizeM: Math.max(start.alt, now.alt) - lo.alt };
    }
    return null;
  }
}

/** The route structure an altitude event is, if any: nearest end within the error bar. */
export function matchStructure(ev: AltitudeEvent, expectedProgressM: number, sigmaM: number, structures: RouteStructure[]): RouteStructure | null {
  const want = ev.kind === "hump" ? "bridge" : "tunnel";
  let best: RouteStructure | null = null;
  for (const s of structures) {
    if (s.kind !== want) continue;
    const d = Math.abs(s.toM - expectedProgressM);
    if (d > sigmaM + 300) continue;
    if (!best || d < Math.abs(best.toM - expectedProgressM)) best = s;
  }
  return best;
}
