// Adapts expo-sensors' Accelerometer/Gyroscope/Magnetometer streams into
// @navia/core's IMUSample shape, feeding SensorFusionEngine's dead-
// reckoning path when GNSS degrades. UNBUILT/UNTESTED — see LIMITATIONS.md;
// no physical device is available here to read real accelerometer/gyro data.
import { Accelerometer, Gyroscope, Magnetometer } from "expo-sensors";
import type { IMUSample } from "@navia/core";

export type MotionSubscription = { remove: () => void };

const UPDATE_INTERVAL_MS = 100; // 10Hz — enough for dead reckoning, light on battery

export class ExpoSensorsMotionProvider {
  subscribe(onSample: (sample: IMUSample) => void): MotionSubscription {
    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);
    Gyroscope.setUpdateInterval(UPDATE_INTERVAL_MS);
    Magnetometer.setUpdateInterval(UPDATE_INTERVAL_MS);

    let latestAccel = { x: 0, y: 0, z: 0 };
    let latestGyro = { x: 0, y: 0, z: 0 };
    let latestMag: { x: number; y: number; z: number } | null = null;

    const emit = () => {
      const sample: IMUSample = {
        timestamp: Date.now(),
        accelX: latestAccel.x, accelY: latestAccel.y, accelZ: latestAccel.z,
        gyroX: latestGyro.x, gyroY: latestGyro.y, gyroZ: latestGyro.z,
        ...(latestMag ? { magneticX: latestMag.x, magneticY: latestMag.y, magneticZ: latestMag.z } : {}),
      };
      onSample(sample);
    };

    const accelSub = Accelerometer.addListener((data) => { latestAccel = data; emit(); });
    const gyroSub = Gyroscope.addListener((data) => { latestGyro = data; });
    const magSub = Magnetometer.addListener((data) => { latestMag = data; });

    return {
      remove: () => {
        accelSub.remove();
        gyroSub.remove();
        magSub.remove();
      },
    };
  }
}
