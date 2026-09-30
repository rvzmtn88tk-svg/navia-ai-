// Barometer and pedometer for guidance without GPS (expo-sensors). Both are
// optional: a phone without them (or without motion permission) simply gives
// no extra evidence.
import { Barometer, Pedometer } from "expo-sensors";

/** Relative altitude in metres (iOS reports it; else derived from pressure) about once a second. */
export async function startBarometer(onAltitude: (altM: number, atMs: number) => void): Promise<{ remove: () => void } | null> {
  try {
    if (!(await Barometer.isAvailableAsync())) return null;
    Barometer.setUpdateInterval(1000);
    let p0: number | null = null;
    const sub = Barometer.addListener(({ pressure, relativeAltitude }) => {
      if (relativeAltitude != null && Number.isFinite(relativeAltitude)) { onAltitude(relativeAltitude, Date.now()); return; }
      if (!Number.isFinite(pressure) || pressure <= 0) return;
      p0 ??= pressure;
      onAltitude(44_330 * (1 - Math.pow(pressure / p0, 1 / 5.255)), Date.now());
    });
    return { remove: () => sub.remove() };
  } catch { return null; }
}

/** Cumulative steps since the start (walking guidance without GPS). */
export async function startPedometer(onSteps: (steps: number, atMs: number) => void): Promise<{ remove: () => void } | null> {
  try {
    if (!(await Pedometer.isAvailableAsync())) return null;
    const sub = Pedometer.watchStepCount(({ steps }) => onSteps(steps, Date.now()));
    return { remove: () => sub.remove() };
  } catch { return null; }
}
