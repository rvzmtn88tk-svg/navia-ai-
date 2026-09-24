# NAVIA feature and data status

Updated 24 September 2026.

## Available in this build

- Ukrainian and English interface, with light, dark, and automatic system themes.
- One-time welcome and animated NAVIA mark.
- Foreground GPS status on Home and during an active route. The route screen reports accuracy and GNSS health and requests a route from the current phone position.
- Real navigation validates each fix, keeps a trusted position, filters jumps, uses hysteresis for degraded/lost/recovery states, and reacquires after a long outage. Live navigation does not yet integrate IMU movement into dead reckoning: it holds the last trusted point briefly, labels GNSS lost, and then removes the stale marker. Dead reckoning in Demo Mode is simulation only.
- Online address search, route calculation, off-route recalculation, turn guidance and text-to-speech.
- Current location-based alert status: Kyiv city uses the Kyiv Digital current-state feed; other administrative areas use NEPTUN's regional alert snapshot. The app rejects old regional snapshots as unknown.
- Nearby map results for shelters, Kyiv resilience points (when the city GIS API responds), fuel, shops, pharmacies and medical locations. Community data comes from OpenStreetMap.
- A NAVIA co-pilot that can answer locally from the current GPS fix, route, alert and nearby places.
- Updated iOS and Android launcher icon assets.

## Limits to know before relying on the app

- NAVIA currently uses public online map, geocoding, routing, OpenStreetMap and alert services. It needs internet for these services. Public endpoints can throttle or stop responding.
- Routing gives turn-by-turn route geometry and recalculates after an off-route detection, but there is no live traffic, crash report, road-closure or police-speed-camera feed. This is not feature-equivalent to Waze or Google Maps.
- Safety-place completeness is not guaranteed. Kyiv's municipal open data is city-specific and its public portal says datasets update more than once per day. The Kyiv GIS endpoint may be unavailable; OpenStreetMap is then a community fallback. Outside Kyiv, points are community map entries and can be missing or outdated. Confirm that a location is open and accessible on arrival.
- NEPTUN is an information aggregator, not an emergency-warning system. Its own terms warn of possible delays and inaccuracies. The app shows informational status only; keep official phone alerts enabled and follow emergency-service instructions.
- NAVIA does not plot individual NEPTUN air-target tracks or issue background/push warnings. The map shows only attributed regional report summaries because these coordinates are approximate aggregator data, not an official radar position. No screen should present that data as a precise target location.
- The assistant is a contextual on-device helper with predefined route-aware answers. A cloud LLM is not connected. Do not enter API secrets in the mobile app; a secure backend is needed for generative AI.
- Route recording, background location sharing, push alerts, offline maps and offline routing are not implemented.
- Features have not been validated during a live drive on the user's iPhone in this work session. A successful Xcode build/install alone does not prove runtime behavior or source-service availability.

## Device installation

From `apps/mobile`, rebuild and install the current native app on the connected iPhone:

```bash
npx expo run:ios --device --configuration Release --no-bundler
```

The app can use the embedded JavaScript bundle without Metro once the Release install completes. Device validation is still needed for location permission, map visibility, routing endpoints, and the alert feed.
