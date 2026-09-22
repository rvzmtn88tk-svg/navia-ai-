// Adapts expo-location's real GPS stream into @navia/core's GNSSRawSample
// shape, so GNSSMonitor/SensorFusionEngine/NavigationStateMachine (all
// tested in packages/core) run on real device fixes unmodified. UNBUILT/
// UNTESTED — no physical device or Android/iOS runtime is available in this
// sandbox to exercise expo-location's actual permission flow or GPS stream;
// see LIMITATIONS.md. The shape mapping itself follows expo-location's
// documented LocationObject fields.
import * as Location from "expo-location";
import type { GNSSRawSample } from "@navia/core";

export type PositionSubscription = { remove: () => void };

export class ExpoLocationPositionProvider {
  /** Requests foreground location permission. Must be called before subscribe(). */
  async requestPermission(): Promise<boolean> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === "granted";
  }

  async subscribe(onSample: (sample: GNSSRawSample) => void): Promise<PositionSubscription> {
    const granted = await this.requestPermission();
    if (!granted) {
      throw new Error("ExpoLocationPositionProvider: location permission not granted");
    }
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (loc) => {
        onSample({
          lat: loc.coords.latitude,
          lon: loc.coords.longitude,
          timestamp: loc.timestamp,
          accuracyM: loc.coords.accuracy ?? null,
          speedMps: loc.coords.speed ?? null,
          headingDeg: loc.coords.heading ?? null,
        });
      }
    );
    return { remove: () => sub.remove() };
  }
}
