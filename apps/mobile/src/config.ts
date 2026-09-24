// Central config module — reads Expo's inlined EXPO_PUBLIC_* env vars (see
// .env.example for why that prefix matters) once, so every screen/provider
// imports from here instead of touching process.env directly. Optional
// services stay null when unconfigured; the public MapLibre style keeps the
// map visible when a deployment has not supplied a custom style URL.

function readEnv(key: string): string | null {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

// OpenFreeMap serves OpenStreetMap-derived vector tiles for MapLibre without
// an API key. The demo tiles are useful for examples, but do not provide a
// dependable streets-and-POI basemap for NAVIA.
const lightMapStyleUrl = "https://tiles.openfreemap.org/styles/liberty";
const darkMapStyleUrl = "https://tiles.openfreemap.org/styles/dark";
const publicValhallaDemoUrl = "https://valhalla1.openstreetmap.de";

export const config = {
  valhallaUrl: readEnv("EXPO_PUBLIC_NAVIA_VALHALLA_URL") ?? publicValhallaDemoUrl,
  aiBackendUrl: readEnv("EXPO_PUBLIC_NAVIA_AI_BACKEND_URL"),
  mapStyleUrl: readEnv("EXPO_PUBLIC_NAVIA_MAP_STYLE_URL") ?? lightMapStyleUrl,
  mapStyleDarkUrl: readEnv("EXPO_PUBLIC_NAVIA_MAP_STYLE_DARK_URL") ?? darkMapStyleUrl,
  autocompleteUrl: readEnv("EXPO_PUBLIC_NAVIA_AUTOCOMPLETE_URL") ?? "https://photon.komoot.io/api",
  geocoderUrl: readEnv("EXPO_PUBLIC_NAVIA_GEOCODER_URL") ?? "https://nominatim.openstreetmap.org",
  airAlertApiUrl: readEnv("EXPO_PUBLIC_NAVIA_AIR_ALERT_API_URL"),
  /** MapTiler key for satellite/terrain layers; null means those layers are unavailable. */
  mapTilerKey: readEnv("EXPO_PUBLIC_NAVIA_MAPTILER_KEY"),
} as const;
