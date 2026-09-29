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
  /** NAVIA language proxy (Cloudflare Worker, server/navia-proxy): no sign-in needed. */
  aiProxyUrl: readEnv("EXPO_PUBLIC_NAVIA_AI_PROXY_URL"),
  /** Identifies the app to the proxy (not a provider key; abuse is also rate-limited per device). */
  aiAppToken: readEnv("EXPO_PUBLIC_NAVIA_AI_APP_TOKEN"),
  mapStyleUrl: readEnv("EXPO_PUBLIC_NAVIA_MAP_STYLE_URL") ?? lightMapStyleUrl,
  mapStyleDarkUrl: readEnv("EXPO_PUBLIC_NAVIA_MAP_STYLE_DARK_URL") ?? darkMapStyleUrl,
  autocompleteUrl: readEnv("EXPO_PUBLIC_NAVIA_AUTOCOMPLETE_URL") ?? "https://photon.komoot.io/api",
  geocoderUrl: readEnv("EXPO_PUBLIC_NAVIA_GEOCODER_URL") ?? "https://nominatim.openstreetmap.org",
  airAlertApiUrl: readEnv("EXPO_PUBLIC_NAVIA_AIR_ALERT_API_URL"),
  /** MapTiler key for satellite/terrain layers; null means those layers are unavailable. */
  mapTilerKey: readEnv("EXPO_PUBLIC_NAVIA_MAPTILER_KEY"),
  /** Firebase Web API key (a public project identifier, not a secret). */
  firebaseApiKey: readEnv("EXPO_PUBLIC_FIREBASE_API_KEY"),
  /** Google OAuth iOS client ID from the Firebase project. */
  googleIosClientId: readEnv("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"),
  /** Sign in with Apple needs a paid Apple Developer team; the build adds the entitlement only when this is "1". */
  appleSignInEnabled: readEnv("EXPO_PUBLIC_NAVIA_APPLE_SIGNIN") === "1",
} as const;
