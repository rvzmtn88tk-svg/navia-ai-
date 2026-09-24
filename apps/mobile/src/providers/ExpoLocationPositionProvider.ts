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

/** expo-location fix → GNSSRawSample (invalid optional fields become null). */
export function locationToSample(loc: Location.LocationObject): GNSSRawSample {
  const accuracyM = loc.coords.accuracy;
  const speedMps = loc.coords.speed;
  const headingDeg = loc.coords.heading;
  return {
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    timestamp: loc.timestamp,
    accuracyM: accuracyM != null && Number.isFinite(accuracyM) && accuracyM >= 0 ? accuracyM : null,
    speedMps: speedMps != null && Number.isFinite(speedMps) && speedMps >= 0 ? speedMps : null,
    headingDeg: headingDeg != null && Number.isFinite(headingDeg) && headingDeg >= 0 && headingDeg < 360 ? headingDeg : null,
  };
}

/** One fresh fix on demand (null after `timeoutMs` or on error). */
export async function probePosition(timeoutMs = 6_000): Promise<GNSSRawSample | null> {
  try {
    const loc = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return loc ? locationToSample(loc) : null;
  } catch {
    return null;
  }
}

export class ExpoLocationPositionProvider {
  /** Requests foreground location permission. Must be called before subscribe(). */
  async requestPermission(): Promise<boolean> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === "granted";
  }

  async subscribe(onSample: (sample: GNSSRawSample) => void, permissionAlreadyGranted = false): Promise<PositionSubscription> {
    const granted = permissionAlreadyGranted || await this.requestPermission();
    if (!granted) {
      throw new Error("ExpoLocationPositionProvider: location permission not granted");
    }
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (loc) => onSample(locationToSample(loc)),
    );
    return { remove: () => sub.remove() };
  }
}
