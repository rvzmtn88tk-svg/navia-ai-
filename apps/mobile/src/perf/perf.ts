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
