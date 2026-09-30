// Central config module — reads Expo's inlined EXPO_PUBLIC_* env vars (see
// .env.example for why that prefix matters) once, so every screen/provider
// imports from here instead of touching process.env directly. Optional
// services stay null when unconfigured; the public MapLibre style keeps the
// map visible when a deployment has not supplied a custom style URL.

// Every variable is read as a literal `process.env.EXPO_PUBLIC_…`: Expo
// inlines only that exact form into a release bundle — a dynamic
// process.env[key] works in development and is empty on the phone.
function readEnv(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

// OpenFreeMap serves OpenStreetMap-derived vector tiles for MapLibre without
// an API key. The demo tiles are useful for examples, but do not provide a
// dependable streets-and-POI basemap for NAVIA.
const lightMapStyleUrl = "https://tiles.openfreemap.org/styles/liberty";
const darkMapStyleUrl = "https://tiles.openfreemap.org/styles/dark";
const publicValhallaDemoUrl = "https://valhalla1.openstreetmap.de";

export const config = {
  valhallaUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_VALHALLA_URL) ?? publicValhallaDemoUrl,
  aiBackendUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_AI_BACKEND_URL),
  /** NAVIA language proxy (Cloudflare Worker, server/navia-proxy): no sign-in needed. */
  aiProxyUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_AI_PROXY_URL),
  /** Identifies the app to the proxy (not a provider key; abuse is also rate-limited per device). */
  aiAppToken: readEnv(process.env.EXPO_PUBLIC_NAVIA_AI_APP_TOKEN),
  mapStyleUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_MAP_STYLE_URL) ?? lightMapStyleUrl,
  mapStyleDarkUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_MAP_STYLE_DARK_URL) ?? darkMapStyleUrl,
  autocompleteUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_AUTOCOMPLETE_URL) ?? "https://photon.komoot.io/api",
  geocoderUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_GEOCODER_URL) ?? "https://nominatim.openstreetmap.org",
  airAlertApiUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_AIR_ALERT_API_URL),
  /** MapTiler key for satellite/terrain layers; null means those layers are unavailable. */
  mapTilerKey: readEnv(process.env.EXPO_PUBLIC_NAVIA_MAPTILER_KEY),
  /** Firebase Web API key (a public project identifier, not a secret). */
  firebaseApiKey: readEnv(process.env.EXPO_PUBLIC_FIREBASE_API_KEY),
  /** Google OAuth iOS client ID from the Firebase project. */
  googleIosClientId: readEnv(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID),
  /** Sign in with Apple needs a paid Apple Developer team; the build adds the entitlement only when this is "1". */
  appleSignInEnabled: readEnv(process.env.EXPO_PUBLIC_NAVIA_APPLE_SIGNIN) === "1",
  /** Token for the co-pilot endpoint (/v1/copilot/complete); the NAVIA proxy takes the same app token. Not a secret. */
  aiClientToken: readEnv(process.env.EXPO_PUBLIC_NAVIA_AI_CLIENT_TOKEN) ?? readEnv(process.env.EXPO_PUBLIC_NAVIA_AI_APP_TOKEN),
  /** Overpass API endpoint for live OSM place search (co-pilot "find fuel on the way"). Unset = no online place search. */
  overpassUrl: readEnv(process.env.EXPO_PUBLIC_NAVIA_OVERPASS_URL),
} as const;
