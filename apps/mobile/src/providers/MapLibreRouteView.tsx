// Map rendering — spec section 13 ("MAP"), via @maplibre/maplibre-react-native
// (MapLibre Native), which is why this app needs an Expo Development Build
// rather than Expo Go. UNBUILT/UNTESTED: MapLibre Native requires a native
// build this sandbox cannot produce (no Android SDK/Xcode) — see BUILD.md.
// This component wires a route's geometry and the current fused position
// onto a MapLibre camera + line layer using a real vector style URL
// (config.mapStyleUrl / EXPO_PUBLIC_NAVIA_MAP_STYLE_URL — offline-bundled
// in production per DATA_PIPELINE.md, an online style for a first dev
// build). If no style URL is configured, this shows a clear error state
// instead of silently rendering a blank MapView — a blank map looks like a
// bug, not like "unconfigured".
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import MapLibreGL from "@maplibre/maplibre-react-native";
import type { LatLon } from "@navia/core";

export type MapLibreRouteViewProps = {
  styleUrl: string | null;
  routeGeometry: LatLon[];
  currentPosition: LatLon | null;
  headingDeg: number | null;
};

export function MapLibreRouteView({ styleUrl, routeGeometry, currentPosition, headingDeg }: MapLibreRouteViewProps): JSX.Element {
  if (!styleUrl) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>Карту не налаштовано</Text>
        <Text style={styles.errorBody}>
          EXPO_PUBLIC_NAVIA_MAP_STYLE_URL не заданий. Додайте URL MapLibre-стилю в .env
          (див. apps/mobile/.env.example) і перезапустіть збірку.
        </Text>
      </View>
    );
  }

  const routeGeoJSON = {
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: routeGeometry.map((p) => [p.lon, p.lat]) },
    properties: {},
  };

  return (
    <MapLibreGL.MapView style={{ flex: 1 }} styleURL={styleUrl} logoEnabled={false}>
      {currentPosition && (
        <MapLibreGL.Camera
          zoomLevel={16}
          heading={headingDeg ?? 0}
          centerCoordinate={[currentPosition.lon, currentPosition.lat]}
          animationMode="flyTo"
          animationDuration={500}
        />
      )}
      {routeGeometry.length > 1 && (
        <MapLibreGL.ShapeSource id="navia-route" shape={routeGeoJSON}>
          <MapLibreGL.LineLayer
            id="navia-route-line"
            style={{ lineColor: "#2dd4bf", lineWidth: 5, lineCap: "round", lineJoin: "round" }}
          />
        </MapLibreGL.ShapeSource>
      )}
      {currentPosition && (
        <MapLibreGL.PointAnnotation id="navia-you" coordinate={[currentPosition.lon, currentPosition.lat]} />
      )}
    </MapLibreGL.MapView>
  );
}

const styles = StyleSheet.create({
  errorContainer: { flex: 1, backgroundColor: "#1a0f0f", alignItems: "center", justifyContent: "center", padding: 24 },
  errorTitle: { color: "#f87171", fontSize: 16, fontWeight: "600", marginBottom: 8 },
  errorBody: { color: "#d4a5a5", fontSize: 13, textAlign: "center" },
});
