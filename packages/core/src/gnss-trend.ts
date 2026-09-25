// GNSS trend monitor: warns BEFORE the signal is lost. Instead of waiting for
// "no fix for N seconds", it watches how the stream behaves:
//  - accuracy getting worse (rising trend or already poor),
//  - fixes arriving more slowly than the receiver's own rhythm,
//  - the first expected fix not arriving (overdue).
// Loss itself is declared from the receiver's measured update interval
// (≈3 missed fixes), not from a fixed timeout, so it is reported seconds —
// not hundreds of metres — after the last fix.
// Satellite counts would help, but iOS does not expose them (CoreLocation).

export type GnssTrendReason = "accuracy_poor" | "accuracy_rising" | "fixes_slowing" | "fix_overdue" | "no_fix";

export type GnssTrend = {
  level: "stable" | "degrading" | "lost";
  reasons: GnssTrendReason[];
  /** The receiver's own update rhythm (median of recent intervals). */
  expectedIntervalMs: number;
  /** Time since the last fix arrived (receipt time), or null before the first. */
  sinceLastFixMs: number | null;
  accuracyM: number | null;
  /** Least-squares slope of accuracy over recent fixes (m per second, + = worse). */
  accuracySlopeMPerS: number | null;
};

type Fix = { receivedAt: number; accuracyM: number | null; stationary: boolean };

export type GnssTrendConfig = {
  window: number;
  defaultIntervalMs: number;
  poorAccuracyM: number;
  risingSlopeMPerS: number;
  risingMinAccuracyM: number;
  slowingRatio: number;
  overdueFactor: number;
  lostFactor: number;
  lostMinMs: number;
};

const DEFAULTS: GnssTrendConfig = {
  window: 12,
  defaultIntervalMs: 1000,
  poorAccuracyM: 30,
  risingSlopeMPerS: 2,
  risingMinAccuracyM: 15,
  slowingRatio: 2,
  overdueFactor: 2,
  lostFactor: 3,
  lostMinMs: 3000,
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class GnssTrendMonitor {
  private fixes: Fix[] = [];
  private cfg: GnssTrendConfig;

  constructor(config: Partial<GnssTrendConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** Every fix the receiver delivers (trusted or not), with its receipt time.
   * `stationary`: the device was standing still when this fix arrived — the
   * silence that follows it is iOS saving power, not a slowing receiver. */
  push(accuracyM: number | null, receivedAtMs: number, stationary = false): void {
    this.fixes.push({ receivedAt: receivedAtMs, accuracyM: accuracyM != null && Number.isFinite(accuracyM) ? accuracyM : null, stationary });
    if (this.fixes.length > this.cfg.window) this.fixes.shift();
  }

  reset(): void {
    this.fixes = [];
  }

  /** Interval after which the stream counts as lost (≈3 missed fixes, ≥3 s). */
  lostAfterMs(): number {
    return Math.max(this.cfg.lostMinMs, this.cfg.lostFactor * this.expectedIntervalMs());
  }

  expectedIntervalMs(): number {
    const intervals = this.intervals();
    if (intervals.length < 3) return this.cfg.defaultIntervalMs;
    // Long-run rhythm: median of all but the newest intervals.
    const base = intervals.length > 4 ? intervals.slice(0, -2) : intervals;
    return Math.min(5000, Math.max(500, median(base)));
  }

  /** Gaps between fixes while moving (gaps after a stationary fix are skipped). */
  private intervals(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.fixes.length; i++) {
      if (this.fixes[i - 1]!.stationary) continue;
      out.push(this.fixes[i]!.receivedAt - this.fixes[i - 1]!.receivedAt);
    }
    return out;
  }

  private accuracySlope(): number | null {
    const pts = this.fixes.slice(-6).filter((f) => f.accuracyM != null);
    if (pts.length < 4) return null;
    const t0 = pts[0]!.receivedAt;
    const xs = pts.map((p) => (p.receivedAt - t0) / 1000);
    const ys = pts.map((p) => p.accuracyM!);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
    return den > 0 ? num / den : null;
  }

  /**
   * `moving`: true/false when known (speed or motion sensor), null = unknown.
   * A phone standing still legitimately gets few fixes (iOS goes quiet), so
   * overdue/lost are only judged while not known to be still.
   */
  evaluate(nowMs: number, moving: boolean | null): GnssTrend {
    const expected = this.expectedIntervalMs();
    const last = this.fixes[this.fixes.length - 1];
    const sinceLastFixMs = last ? Math.max(0, nowMs - last.receivedAt) : null;
    const accuracyM = last?.accuracyM ?? null;
    const slope = this.accuracySlope();
    const reasons: GnssTrendReason[] = [];
    if (!last) return { level: "lost", reasons: ["no_fix"], expectedIntervalMs: expected, sinceLastFixMs, accuracyM, accuracySlopeMPerS: slope };

    const judgeGaps = moving !== false;
    if (judgeGaps && sinceLastFixMs! > this.lostAfterMs()) {
      return { level: "lost", reasons: ["no_fix"], expectedIntervalMs: expected, sinceLastFixMs, accuracyM, accuracySlopeMPerS: slope };
    }
    if (accuracyM != null && accuracyM > this.cfg.poorAccuracyM) reasons.push("accuracy_poor");
    if (slope != null && slope > this.cfg.risingSlopeMPerS && (accuracyM ?? 0) > this.cfg.risingMinAccuracyM) reasons.push("accuracy_rising");
    const iv = this.intervals();
    if (judgeGaps && iv.length >= 4) {
      const recent = median(iv.slice(-2));
      if (recent > this.cfg.slowingRatio * expected && recent > 1500) reasons.push("fixes_slowing");
    }
    if (judgeGaps && sinceLastFixMs! > this.cfg.overdueFactor * expected && sinceLastFixMs! > 1500) reasons.push("fix_overdue");
    return { level: reasons.length ? "degrading" : "stable", reasons, expectedIntervalMs: expected, sinceLastFixMs, accuracyM, accuracySlopeMPerS: slope };
  }
}
