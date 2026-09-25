// Live heading for "me on the map": the phone's compass (iOS CoreLocation
// true heading, per-degree updates) fused with the gyroscope (DeviceMotion,
// 60 Hz) in HeadingFusion. One shared subscription; the map marker listens
// directly, so a 60 Hz stream never re-renders whole screens. GPS course is
// fed in by the marker and used only as a fallback when no compass exists.
// Also measures the real pipeline latency: sensor event → marker committed.
import * as Location from "expo-location";
import { DeviceMotion } from "expo-sensors";
import { HeadingFusion, yawRateFromMotion, type HeadingSource } from "./headingFusion";

export type HeadingReading = { deg: number | null; source: HeadingSource | null; at: number; synthetic?: boolean };
type Listener = (r: HeadingReading) => void;

const EMIT_EVERY_MS = 33; // ≈30 Hz to the marker (gyro arrives at 60 Hz)

const fusion = new HeadingFusion();
const listeners = new Set<Listener>();
let compassSub: Location.LocationSubscription | null = null;
let motionSub: { remove: () => void } | null = null;
let starting = false;
let compassOk: boolean | null = null;
let gyroOk: boolean | null = null;
let last: HeadingReading | null = null;
let lastEmitAt = 0;
let synthetic = false;
let syntheticDeg = 0;

export function lastHeading(): HeadingReading | null {
  return last;
}

/** "ok" = readings arrive; "silent" = subscribed but no reading yet (e.g. the
 * iOS simulator); "unavailable" = no compass / not permitted; null = unknown. */
export function compassAvailable(): "ok" | "silent" | "unavailable" | null {
  if (compassOk === false) return "unavailable";
  if (compassOk === true) return compassReadings > 0 ? "ok" : "silent";
  return null;
}
let compassReadings = 0;
export function gyroAvailable(): boolean | null {
  return gyroOk;
}

function emit(force: boolean, inputAt: number): void {
  const now = Date.now();
  if (!force && now - lastEmitAt < EMIT_EVERY_MS) return;
  lastEmitAt = now;
  const out = fusion.current(now);
  last = { deg: out.deg, source: out.source, at: inputAt, ...(synthetic ? { synthetic: true } : {}) };
  for (const l of listeners) l(last);
}

async function ensureStarted(): Promise<void> {
  if (compassSub || motionSub || starting) return;
  starting = true;
  try {
    compassSub = await Location.watchHeadingAsync((h) => {
      if (synthetic) return;
      const deg = h.trueHeading != null && h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      const at = Date.now();
      fusion.onCompass(deg, h.accuracy != null && h.accuracy >= 0 ? h.accuracy : null, at);
      compassReadings += 1;
      emit(true, at);
    });
    compassOk = true;
  } catch {
    compassOk = false; // no compass hardware (simulator) or not permitted
  }
  try {
    if (await DeviceMotion.isAvailableAsync()) {
      DeviceMotion.setUpdateInterval(16);
      motionSub = DeviceMotion.addListener((m) => {
        if (synthetic || !m.rotationRate || !m.accelerationIncludingGravity || !m.acceleration) return;
        // expo-sensors: rotationRate alpha=z, beta=y, gamma=x (deg/s).
        const rate = { x: m.rotationRate.gamma, y: m.rotationRate.beta, z: m.rotationRate.alpha };
        const g = m.accelerationIncludingGravity, a = m.acceleration;
        const at = Date.now();
        fusion.onGyro(yawRateFromMotion(rate, { x: g.x - a.x, y: g.y - a.y, z: g.z - a.z }), at);
        emit(false, at);
      });
      gyroOk = true;
    } else {
      gyroOk = false;
    }
  } catch {
    gyroOk = false;
  } finally {
    starting = false;
  }
}

export function subscribeHeading(listener: Listener): () => void {
  listeners.add(listener);
  void ensureStarted();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      compassSub?.remove(); compassSub = null;
      motionSub?.remove(); motionSub = null;
    }
  };
}

/** GPS course over ground (the marker's fallback when there is no compass). */
export function feedCourse(deg: number | null, speedMps: number | null): void {
  fusion.onCourse(deg, speedMps, Date.now());
  if (last?.source !== "COMPASS") emit(true, Date.now());
}

// ——— Latency measurement (sensor event → marker committed) ———

const samples: number[] = [];
const applied: { input: number; shown: number | null }[] = [];
export function recordHeadingLatency(ms: number, shownDeg: number | null): void {
  samples.push(ms);
  if (samples.length > 400) samples.shift();
  if (synthetic) applied.push({ input: syntheticDeg, shown: shownDeg });
}
export function headingLatencySummary(): { n: number; p50: number | null; p95: number | null; max: number | null; maxErrorDeg: number | null } {
  if (samples.length === 0) return { n: 0, p50: null, p95: null, max: null, maxErrorDeg: null };
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  const errs = applied.filter((x) => x.shown != null).map((x) => Math.abs(((x.shown! - x.input + 540) % 360) - 180));
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, maxErrorDeg: errs.length ? Math.max(...errs) : null };
}
export function resetHeadingLatency(): void {
  samples.length = 0;
  applied.length = 0;
}

/**
 * Test: rotate "in place" — synthetic compass (20 Hz) and gyro (60 Hz)
 * samples go through the same fusion and marker path; GPS is untouched.
 * The real sensors are ignored meanwhile.
 */
export function runSyntheticSpin(durationMs = 3000, degPerS = 60): Promise<void> {
  return new Promise((resolve) => {
    synthetic = true;
    fusion.reset();
    const start = Date.now();
    let lastCompass = 0;
    syntheticDeg = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      syntheticDeg = ((now - start) / 1000 * degPerS) % 360;
      fusion.onGyro(degPerS, now);
      if (now - lastCompass >= 50) { fusion.onCompass(syntheticDeg, 5, now); lastCompass = now; }
      emit(false, now);
      if (now - start >= durationMs) {
        clearInterval(timer);
        synthetic = false;
        fusion.reset();
        emit(true, Date.now()); // clear the synthetic heading from the marker
        resolve();
      }
    }, 16);
  });
}
