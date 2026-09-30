// Background navigation: while a route is active, iOS keeps delivering fixes
// (and NAVIA keeps running and speaking) with the screen locked or another
// app in front. Uses expo-location's background updates (UIBackgroundModes
// "location"; the spoken prompts need "audio"). Needs "Always" location
// permission — without it navigation still works on screen, and the app says
// so instead of going silent unexpectedly.
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

export const BACKGROUND_LOCATION_TASK = "navia-background-location";

type Listener = (loc: Location.LocationObject) => void;
const listeners = new Set<Listener>();

// Must be defined at module scope, before the app registers (see index.ts).
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations?: Location.LocationObject[] };
  for (const loc of locations ?? []) for (const l of listeners) l(loc);
});

/** Fixes delivered by the background task (also while the app is in front). */
export function onBackgroundLocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type BackgroundState = "on" | "needs-always" | "unavailable";

/** Starts background fixes for a trip. Asks for "Always" once (iOS shows its own prompt). */
export async function startBackgroundLocation(ask: boolean): Promise<BackgroundState> {
  try {
    let perm = await Location.getBackgroundPermissionsAsync();
    if (perm.status !== "granted" && ask && perm.canAskAgain) perm = await Location.requestBackgroundPermissionsAsync();
    if (perm.status !== "granted") return "needs-always";
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false)) return "on";
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: 0,
      activityType: Location.ActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
    return "on";
  } catch {
    return "unavailable";
  }
}

export async function stopBackgroundLocation(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch { /* not running */ }
}
