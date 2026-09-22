// Central config module — reads Expo's inlined EXPO_PUBLIC_* env vars (see
// .env.example for why that prefix matters) once, so every screen/provider
// imports from here instead of touching process.env directly. Every field
// is `string | null`, never a fake default value, so "not configured" is
// always distinguishable from "configured to an empty string".

function readEnv(key: string): string | null {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

export const config = {
  valhallaUrl: readEnv("EXPO_PUBLIC_NAVIA_VALHALLA_URL"),
  aiBackendUrl: readEnv("EXPO_PUBLIC_NAVIA_AI_BACKEND_URL"),
  mapStyleUrl: readEnv("EXPO_PUBLIC_NAVIA_MAP_STYLE_URL"),
  geocoderUrl: readEnv("EXPO_PUBLIC_NAVIA_GEOCODER_URL") ?? "https://nominatim.openstreetmap.org",
  airAlertApiUrl: readEnv("EXPO_PUBLIC_NAVIA_AIR_ALERT_API_URL"),
} as const;
