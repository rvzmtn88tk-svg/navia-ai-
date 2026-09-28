// "No internet" test mode: every network request the app makes fails, and the
// map is told it is offline (MapLibre then renders only from stored packs).
// Lets the offline package be verified on the simulator without cutting the
// Mac's own network; on the phone, airplane mode does the same for real.
import MapLibreGL from "@maplibre/maplibre-react-native";
import { NativeModules } from "react-native";

let simulated = false;
let realFetch: typeof fetch | null = null;

export function isSimulatedOffline(): boolean {
  return simulated;
}

// Started offline by the native test switch (iOS): mirror it in JS too.
try {
  const native = NativeModules.NaviaMapNetwork as { isOffline?: () => boolean } | undefined;
  if (native?.isOffline?.()) setTimeout(() => setSimulatedOffline(true), 0);
} catch { /* not built in */ }

export function setSimulatedOffline(offline: boolean): void {
  if (offline === simulated) return;
  simulated = offline;
  if (offline) {
    realFetch = globalThis.fetch;
    const passthrough = realFetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Keep the local dev server reachable; everything else is "no network".
      if (/^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.)/.test(url)) return passthrough(input as RequestInfo, init);
      return Promise.reject(new TypeError("Network request failed (offline test mode)"));
    }) as typeof fetch;
  } else if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = null;
  }
  // Android: MapLibre's own switch. iOS: NAVIA's native gate (AppDelegate.mm)
  // makes every map request fail as in airplane mode.
  try { MapLibreGL.setConnected?.(!offline); } catch { /* not on iOS */ }
  try { (NativeModules.NaviaMapNetwork as { setOffline?: (v: boolean) => void } | undefined)?.setOffline?.(offline); } catch { /* not built in */ }
}
