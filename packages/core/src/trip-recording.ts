// Real-trip recordings: the phone writes raw GNSS fixes, IMU samples (10 Hz)
// and the active route to JSON lines while driving; `replayTrip` later feeds
// a recording through NavigationEngine with GNSS cut or spoofed, and measures
// the engine against the fixes it did not see. This turns the synthetic
// Monte Carlo numbers into numbers from real phones, mounts and roads.
//
// Format (one JSON object per line):
//   {"kind":"navia-trip","version":1,"startedAt":…,"device":…}   header, first line
//   {"k":"gnss","t":…,"s":GNSSRawSample}
//   {"k":"imu","t":…,"s":IMUSample}
//   {"k":"route","t":…,"route":Route}                            on start and every reroute

import type { GNSSRawSample } from "./gnss-monitor";
import type { IMUSample } from "./types";
import type { Route, RoutingProvider } from "./route-engine";
import { NavigationEngine } from "./navigation-engine";
import { destinationPoint, haversineMeters } from "./geodesy";

export const TRIP_RECORDING_VERSION = 1;

export type TripRecordingHeader = {
  kind: "navia-trip";
  version: number;
  startedAt: number;
  device?: string;
  app?: string;
  note?: string;
};

export type TripEvent =
  | { k: "gnss"; t: number; s: GNSSRawSample }
  | { k: "imu"; t: number; s: IMUSample }
  | { k: "route"; t: number; route: Route };

export type TripRecording = { header: TripRecordingHeader; events: TripEvent[] };

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Collects a trip as JSON lines; the app flushes `takeChunk()` to a file every few seconds. */
export class TripRecorder {
  readonly header: TripRecordingHeader;
  private lines: string[] = [];
  private lastImuT = -Infinity;
  private readonly imuPeriodMs: number;
  private counts = { gnss: 0, imu: 0, route: 0 };

  constructor(opts: { startedAt?: number; device?: string; app?: string; imuHz?: number } = {}) {
    this.header = { kind: "navia-trip", version: TRIP_RECORDING_VERSION, startedAt: opts.startedAt ?? Date.now(), device: opts.device, app: opts.app };
    // A little under the period, so a 10 Hz sensor stream is not halved by jitter.
    this.imuPeriodMs = 1000 / (opts.imuHz ?? 10) * 0.9;
  }

  headerLine(): string {
    return JSON.stringify(this.header);
  }

  gnss(s: GNSSRawSample, t = s.timestamp): void {
    this.counts.gnss++;
    this.lines.push(JSON.stringify({ k: "gnss", t, s: { ...s, lat: round(s.lat, 7), lon: round(s.lon, 7) } }));
  }

  imu(s: IMUSample, t = s.timestamp): void {
    if (t - this.lastImuT < this.imuPeriodMs) return;
    this.lastImuT = t;
    this.counts.imu++;
    const r = (v: number | undefined) => (v == null ? undefined : round(v, 4));
    this.lines.push(JSON.stringify({ k: "imu", t, s: { timestamp: s.timestamp, accelX: r(s.accelX), accelY: r(s.accelY), accelZ: r(s.accelZ), gyroX: r(s.gyroX), gyroY: r(s.gyroY), gyroZ: r(s.gyroZ), magneticX: r(s.magneticX), magneticY: r(s.magneticY), magneticZ: r(s.magneticZ) } }));
  }

  route(route: Route, t = Date.now()): void {
    this.counts.route++;
    this.lines.push(JSON.stringify({ k: "route", t, route }));
  }

  /** Lines recorded since the last call (newline-terminated), or "" if none. */
  takeChunk(): string {
    if (this.lines.length === 0) return "";
    const out = this.lines.join("\n") + "\n";
    this.lines = [];
    return out;
  }

  stats(): { gnss: number; imu: number; route: number } {
    return { ...this.counts };
  }
}

/** Parses a recording; bad lines are skipped (a trip cut short by a crash still replays). */
export function parseTripRecording(text: string): TripRecording {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = JSON.parse(rows[0] ?? "{}") as TripRecordingHeader;
  if (header.kind !== "navia-trip") throw new Error("not a NAVIA trip recording");
  const events: TripEvent[] = [];
  for (const row of rows.slice(1)) {
    try {
      const e = JSON.parse(row) as TripEvent;
      if ((e.k === "gnss" || e.k === "imu" || e.k === "route") && Number.isFinite(e.t)) events.push(e);
    } catch { /* truncated last line */ }
  }
  events.sort((a, b) => a.t - b.t);
  return { header, events };
}

// ——— replay ———

export type ReplayWindow = { fromS: number; toS: number };

export type ReplayOptions = {
  /**
   * When GNSS is withheld from the engine, in seconds from the first route.
   * "full": everything after the first `warmupS` (default 60 s);
   * "periodic": 120 s outages every 300 s after the warm-up.
   */
  outages?: ReplayWindow[] | "full" | "periodic";
  /** Instead of withholding GNSS, feed it shifted by this many metres (spoofing). */
  spoofOffsetM?: number;
  warmupS?: number;
  /** An error above this while the engine claims HIGH/MEDIUM confidence is a "confident error". */
  confidentErrorM?: number;
  /** Fixes worse than this are not used as ground truth. */
  truthMaxAccuracyM?: number;
};

export type ReplayResult = {
  durationS: number;
  outageS: number;
  truthPoints: number;
  errorM: { p50: number | null; p90: number | null; max: number | null };
  /** Error at each maneuver the driver passed during an outage. */
  maneuvers: { stepId: string; maneuver: string; errorM: number }[];
  maneuverErrorP50M: number | null;
  /** Share of outage time with an error above `confidentErrorM` while confidence was HIGH/MEDIUM. */
  confidentErrorShare: number | null;
  /** Share of outage time the engine produced any position at all. */
  coverage: number | null;
  arrivedLikeTruth: boolean | null;
};

const noRouting: RoutingProvider = {
  route: () => Promise.reject(new Error("replay: no routing")),
  match: () => Promise.reject(new Error("replay: no routing")),
  searchAlternatives: () => Promise.reject(new Error("replay: no routing")),
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Feeds a recording through the app's NavigationEngine with GNSS cut or spoofed and scores it. */
export function replayTrip(rec: TripRecording, opts: ReplayOptions = {}): ReplayResult {
  const warmupS = opts.warmupS ?? 60;
  const confidentErrorM = opts.confidentErrorM ?? 50;
  const truthMaxAcc = opts.truthMaxAccuracyM ?? 25;
  const firstRoute = rec.events.find((e) => e.k === "route");
  const t0 = firstRoute?.t ?? rec.events[0]?.t ?? 0;
  const tEnd = rec.events[rec.events.length - 1]?.t ?? t0;
  const durationS = (tEnd - t0) / 1000;
  const windows: ReplayWindow[] =
    Array.isArray(opts.outages) ? opts.outages
    : opts.outages === "periodic" ? Array.from({ length: Math.max(0, Math.ceil((durationS - warmupS) / 300)) }, (_, i) => ({ fromS: warmupS + i * 300, toS: Math.min(durationS, warmupS + i * 300 + 120) }))
    : [{ fromS: warmupS, toS: durationS }];
  const inOutage = (t: number) => { const s = (t - t0) / 1000; return windows.some((w) => s >= w.fromS && s < w.toS); };

  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  const errors: number[] = [];
  let confident = 0;
  let covered = 0;
  let scored = 0;
  let lastTick = -Infinity;
  let route: Route | null = null;
  // Nearest truth fix to each maneuver during an outage, with the engine's error there.
  const nearest = new Map<string, { d: number; errorM: number; maneuver: string }>();

  for (const e of rec.events) {
    if (e.k === "route") { route = e.route; engine.applyRoute(e.route); continue; }
    if (e.k === "imu") { engine.pushImuSample(e.s); }
    if (e.k === "gnss") {
      const out = inOutage(e.t);
      if (!out) engine.pushGnssSample(e.s, e.t);
      else if (opts.spoofOffsetM) {
        const p = destinationPoint({ lat: e.s.lat, lon: e.s.lon }, 90, opts.spoofOffsetM);
        engine.pushGnssSample({ ...e.s, lat: p.lat, lon: p.lon }, e.t);
      }
      if (out && e.s.accuracyM != null && e.s.accuracyM <= truthMaxAcc && route) {
        const st = engine.tick(e.t);
        lastTick = e.t;
        scored++;
        const pos = st.position?.position;
        if (!pos) continue;
        covered++;
        const err = haversineMeters(pos, { lat: e.s.lat, lon: e.s.lon });
        errors.push(err);
        if (err > confidentErrorM && (st.confidenceBand === "HIGH" || st.confidenceBand === "MEDIUM")) confident++;
        for (const step of route.steps) {
          if (step.maneuver === "depart") continue;
          const d = haversineMeters(step.location, { lat: e.s.lat, lon: e.s.lon });
          const prev = nearest.get(step.id);
          if (d < 60 && (!prev || d < prev.d)) nearest.set(step.id, { d, errorM: err, maneuver: step.maneuver });
        }
      }
    }
    if (e.t - lastTick >= 1000) { engine.tick(e.t); lastTick = e.t; }
  }

  errors.sort((a, b) => a - b);
  const maneuvers = [...nearest.entries()].map(([stepId, v]) => ({ stepId, maneuver: v.maneuver, errorM: Math.round(v.errorM) }));
  const mErr = maneuvers.map((m) => m.errorM).sort((a, b) => a - b);
  const finalState = engine.tick(tEnd);
  const lastTruth = [...rec.events].reverse().find((e) => e.k === "gnss") as Extract<TripEvent, { k: "gnss" }> | undefined;
  const dest = route?.steps[route.steps.length - 1]?.location;
  const truthArrived = !!(dest && lastTruth && haversineMeters(dest, { lat: lastTruth.s.lat, lon: lastTruth.s.lon }) < 80);
  return {
    durationS: Math.round(durationS),
    outageS: Math.round(windows.reduce((s, w) => s + Math.max(0, w.toS - w.fromS), 0)),
    truthPoints: scored,
    errorM: { p50: round1(percentile(errors, 0.5)), p90: round1(percentile(errors, 0.9)), max: round1(errors[errors.length - 1] ?? null) },
    maneuvers,
    maneuverErrorP50M: percentile(mErr, 0.5),
    confidentErrorShare: scored ? round(confident / scored, 3) : null,
    coverage: scored ? round(covered / scored, 3) : null,
    arrivedLikeTruth: route ? (finalState.mode === "ARRIVED") === truthArrived : null,
  };
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}
