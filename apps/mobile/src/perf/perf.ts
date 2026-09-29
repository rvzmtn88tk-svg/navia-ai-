// Tiny stopwatch for UI timings (dev builds log them as `[perf] name 123 ms`):
// start(name) at the user's action, end(name) when the result is on screen.
const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
const open = new Map<string, number>();
export const perfLog: { name: string; ms: number }[] = [];

export function perfStart(name: string): void {
  open.set(name, now());
}

export function perfPending(name: string): boolean {
  return open.has(name);
}

export function perfEnd(name: string): number | null {
  const t0 = open.get(name);
  if (t0 == null) return null;
  open.delete(name);
  const ms = now() - t0;
  perfLog.push({ name, ms });
  if (perfLog.length > 200) perfLog.shift();
  if (__DEV__) console.log(`[perf] ${name} ${ms.toFixed(0)} ms`);
  return ms;
}

type FrameReport = { frames: number; ms: number; fps: number; maxGapMs: number; screenHz: number };
type Meter = { start(): void; stop(): Promise<FrameReport> };
const meter = (): Meter | null => {
  try { return (require("react-native") as typeof import("react-native")).NativeModules.NaviaFrameMeter as Meter | null; } catch { return null; }
};
export const fpsLog: ({ name: string } & FrameReport)[] = [];

/** UI-thread frame rate of an animation (native CADisplayLink meter, see AppDelegate.mm). */
export function fpsStart(): void {
  meter()?.start();
}

export async function fpsEnd(name: string): Promise<FrameReport | null> {
  const m = meter();
  if (!m) return null;
  const r = await m.stop();
  fpsLog.push({ name, ...r });
  if (fpsLog.length > 100) fpsLog.shift();
  if (__DEV__) console.log(`[fps] ${name}: ${r.fps.toFixed(1)} fps over ${r.ms.toFixed(0)} ms, ${r.frames} frames, longest frame ${r.maxGapMs.toFixed(1)} ms (screen ${r.screenHz} Hz)`);
  return r;
}

/**
 * JS-thread responsiveness: a 50 ms timer measures how late it fires. Late
 * timers = the JS thread was busy (taps, animations driven from JS and
 * gestures wait for it). Returns the share of time lost and the worst stall.
 */
export function jsLagStart(): () => { busyPct: number; maxStallMs: number; stallsOver100: number } {
  const tick = 50;
  let last = now();
  let lost = 0, max = 0, over100 = 0;
  const t0 = last;
  const id = setInterval(() => {
    const t = now();
    const late = Math.max(0, t - last - tick);
    lost += late; max = Math.max(max, late); if (late > 100) over100++;
    last = t;
  }, tick);
  return () => { clearInterval(id); const total = now() - t0; return { busyPct: total > 0 ? (lost / total) * 100 : 0, maxStallMs: max, stallsOver100: over100 }; };
}

/** React render timings of a screen (React.Profiler onRender), for the benchmark. */
export const renderLog: { id: string; ms: number }[] = [];
export function recordRender(id: string, _phase: string, actualDuration: number): void {
  renderLog.push({ id, ms: actualDuration });
  if (renderLog.length > 2000) renderLog.shift();
}
