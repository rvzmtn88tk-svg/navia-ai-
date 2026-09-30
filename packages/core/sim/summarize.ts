// Aggregation of Monte Carlo results into the report's tables.
import type { ScenarioResult, EngineResult } from "./closed-loop";

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const pct = (x: number) => Math.round(x * 1000) / 10;

function engineStats(rs: EngineResult[], optimal: number[]) {
  const n = rs.length;
  const ok = rs.filter((r) => r.success).length;
  const [lo, hi] = wilson(ok, n);
  const dis = rs.reduce((a, r) => a + r.disruptionS, 0);
  const cw = rs.reduce((a, r) => a + r.confidentlyWrongS, 0);
  return {
    scenarios: n,
    reached_destination_pct: pct(ok / Math.max(1, n)),
    ci95_pct: [pct(lo), pct(hi)],
    // Extra distance driven vs. the shortest path, over the trips that arrived.
    median_extra_distance_pct: median(rs.flatMap((r, i) => (r.success ? [Math.round((100 * (r.distanceDrivenM - optimal[i]!)) / Math.max(1, optimal[i]!))] : []))),
    mean_wrong_turns: Math.round((100 * rs.reduce((a, r) => a + r.wrongTurns, 0)) / Math.max(1, n)) / 100,
    median_position_error_p95_m: median(rs.map((r) => r.errP95 ?? 0).filter((x) => x >= 0)),
    confidently_wrong_pct_of_disrupted_seconds: pct(cw / Math.max(1, dis)),
  };
}

export function summarize(rows: ScenarioResult[], meta: Record<string, unknown>) {
  const group = (key: (r: ScenarioResult) => string) => {
    const m = new Map<string, ScenarioResult[]>();
    for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
    return Object.fromEntries([...m.entries()].sort().map(([k, rs]) => [k, {
      baseline: engineStats(rs.map((r) => r.baseline), rs.map((r) => r.optimalM)),
      resilient: engineStats(rs.map((r) => r.resilient), rs.map((r) => r.optimalM)),
    }]));
  };
  return {
    meta: { ...meta, generated: new Date().toISOString() },
    overall: {
      baseline: engineStats(rows.map((r) => r.baseline), rows.map((r) => r.optimalM)),
      resilient: engineStats(rows.map((r) => r.resilient), rows.map((r) => r.optimalM)),
    },
    by_disruption: group((r) => r.scenario.disruption),
    by_world: group((r) => r.scenario.kind),
    by_imu: group((r) => (r.scenario.imu ? "imu" : "no_imu")),
    by_air_alert: group((r) => (r.scenario.airAlert ? "alert" : "no_alert")),
    by_sign_reading: group((r) => (r.scenario.signReading > 0 ? "reads_signs" : "no_signs")),
    by_driver_error: group((r) => (r.scenario.driverError ? "driver_mistake" : "no_mistake")),
  };
}
