// On-device benchmark (dev aid): launched with `-NaviaBench YES`, the app
// measures real UI-thread frame rates (perf.ts / NaviaFrameMeter) for the
// category wheel and for the tilted 3D map (standard and satellite, with
// relief shading and 3D buildings), and saves them to the phone
// ("navia.bench.v1") so they can be read from the app container.
import { NativeModules, Platform, Dimensions } from "react-native";
import { fpsEnd, fpsLog, fpsStart } from "./perf";
import type { MapLayer } from "../settings/AppSettings";

export const benchHooks: {
  openWheel?: () => void;
  closeWheel?: () => void;
  orbit?: (ms: number, pitch: number, zoom: number) => void;
  setLayer?: (layer: MapLayer) => void;
} = {};

export function benchMode(): boolean {
  try { return !!(NativeModules.NaviaFrameMeter as { benchMode?: () => boolean } | undefined)?.benchMode?.(); } catch { return false; }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let running = false;
export async function runBench(layerBefore: MapLayer): Promise<void> {
  if (running) return;
  running = true;
  fpsLog.length = 0;
  fpsStart(); await wait(1500); await fpsEnd("idle: standard map, nothing moving");
  for (let k = 0; k < 3; k++) {
    benchHooks.openWheel?.(); await wait(1300);
    benchHooks.closeWheel?.(); await wait(900);
  }
  for (const layer of ["standard", "satellite", "terrain"] as MapLayer[]) {
    benchHooks.setLayer?.(layer); await wait(7000);
    // Warm the tiles of the tilted view, then measure the next turn.
    benchHooks.orbit?.(2500, 55, 16); await wait(4000);
    fpsStart(); benchHooks.orbit?.(3000, 55, 16); await wait(3100); await fpsEnd(`3D orbit (pitch 55°, z16): ${layer} + relief + 3D buildings`);
  }
  benchHooks.setLayer?.(layerBefore);
  const { width, height } = Dimensions.get("window");
  const report = { at: new Date().toISOString(), platform: Platform.OS, version: Platform.Version, model: (Platform.constants as { systemName?: string; interfaceIdiom?: string }).interfaceIdiom, window: `${width}x${height}`, results: [...fpsLog] };
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { setItemAsync(k: string, v: string): Promise<void> } }).default;
    await kv.setItemAsync("navia.bench.v1", JSON.stringify(report));
  } catch { /* storage unavailable */ }
  console.log("[bench]", JSON.stringify(report));
  running = false;
}
