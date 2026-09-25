// The phone's compass (iOS CoreLocation heading: true north, delivered on
// every 1° of rotation). One shared subscription; the map marker listens
// directly so a 30 Hz compass never re-renders whole screens.
// Also measures the real pipeline latency: compass event → marker committed.
import * as Location from "expo-location";

export type HeadingReading = { deg: number; accuracyDeg: number | null; at: number; synthetic?: boolean };
type Listener = (r: HeadingReading) => void;

const listeners = new Set<Listener>();
let sub: Location.LocationSubscription | null = null;
let starting = false;
let available: boolean | null = null;
let last: HeadingReading | null = null;

export function lastHeading(): HeadingReading | null {
  return last;
}

/** null = not yet known; false = no compass (e.g. the iOS simulator). */
export function compassAvailable(): boolean | null {
  return available;
}

function emit(r: HeadingReading): void {
  last = r;
  for (const l of listeners) l(r);
}

async function ensureStarted(): Promise<void> {
  if (sub || starting) return;
  starting = true;
  try {
    sub = await Location.watchHeadingAsync((h) => {
      const deg = h.trueHeading != null && h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      if (!Number.isFinite(deg)) return;
      emit({ deg, accuracyDeg: h.accuracy != null && h.accuracy >= 0 ? h.accuracy : null, at: Date.now() });
    });
    available = true;
  } catch {
    available = false; // no compass hardware (simulator) or not permitted
  } finally {
    starting = false;
  }
}

export function subscribeHeading(listener: Listener): () => void {
  listeners.add(listener);
  void ensureStarted();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sub) { sub.remove(); sub = null; }
  };
}

// ——— Latency measurement (event → marker committed) ———

const samples: number[] = [];
export function recordHeadingLatency(ms: number): void {
  samples.push(ms);
  if (samples.length > 300) samples.shift();
}
export function headingLatencySummary(): { n: number; p50: number | null; p95: number | null; max: number | null } {
  if (samples.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
}
export function resetHeadingLatency(): void {
  samples.length = 0;
}

/** Dev: feed synthetic compass events (30 Hz rotation) through the same path. */
export function runSyntheticSpin(durationMs = 3000, hz = 30): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let deg = last?.deg ?? 0;
    const timer = setInterval(() => {
      deg = (deg + 12) % 360;
      emit({ deg, accuracyDeg: 5, at: Date.now(), synthetic: true });
      if (Date.now() - start >= durationMs) { clearInterval(timer); resolve(); }
    }, Math.round(1000 / hz));
  });
}
