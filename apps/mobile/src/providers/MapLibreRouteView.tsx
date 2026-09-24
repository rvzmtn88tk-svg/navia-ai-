import React, { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { AppText as Text } from "../components/AppText";
import MapLibreGL from "@maplibre/maplibre-react-native";
import type { LatLon } from "@navia/core";
import type { NearbyPlace } from "./NearbyPlacesProvider";

const KYIV_PREVIEW_CENTER: LatLon = { lat: 50.4501, lon: 30.5234 };

export type MapLibreRouteViewProps = {
  styleUrl: string | null;
  routeGeometry: LatLon[];
  currentPosition: LatLon | null;
  headingDeg: number | null;
  nearbyPlaces?: NearbyPlace[];
  initialCenter?: LatLon | null;
  isDark?: boolean;
  isEnglish?: boolean;
  positionQuality?: "good" | "degraded" | "lost";
  controlsTopOffset?: number;
};

/** MapLibre Native map with a real OpenStreetMap basemap, route, live fix and POI pins. */
function MapLibreRouteViewBase({
  styleUrl,
  routeGeometry,
  currentPosition,
  headingDeg,
  nearbyPlaces = [],
  initialCenter,
  isDark = false,
  isEnglish = false,
  positionQuality = "good",
  controlsTopOffset = 12,
}: MapLibreRouteViewProps): JSX.Element {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(currentPosition ? 15.5 : 12);
  const camera = useRef<MapLibreGL.CameraRef | null>(null);
  const following = useRef(true);
  const [northUp, setNorthUp] = useState(false);
  const zoomRef = useRef(zoomLevel);
  const lastFollowed = useRef<{ lat: number; lon: number; heading: number | null } | null>(null);
  const center = currentPosition ?? routeGeometry[0] ?? initialCenter ?? KYIV_PREVIEW_CENTER;
  const routeShape = useMemo(() => ({
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: routeGeometry.map((point) => [point.lon, point.lat]) },
    properties: {},
  }), [routeGeometry]);

  useEffect(() => {
    setLoadState("loading");
    const timer = setTimeout(() => setLoadState((current) => current === "loading" ? "error" : current), 15_000);
    return () => clearTimeout(timer);
  }, [attempt, styleUrl]);

  useEffect(() => {
    if (!currentPosition || !following.current) return;
    const previous = lastFollowed.current;
    const movedM = previous ? Math.hypot(
      (currentPosition.lat - previous.lat) * 111_320,
      (currentPosition.lon - previous.lon) * 111_320 * Math.cos(currentPosition.lat * Math.PI / 180),
    ) : Infinity;
    const turned = !northUp && headingDeg != null && previous?.heading != null
      && Math.abs(((headingDeg - previous.heading + 540) % 360) - 180) >= 8;
    if (movedM >= 3 || turned || !previous) {
      camera.current?.setCamera({
        centerCoordinate: [currentPosition.lon, currentPosition.lat],
        zoomLevel: zoomRef.current,
        heading: northUp ? 0 : headingDeg ?? 0,
        animationDuration: previous ? 350 : 0,
        animationMode: "easeTo",
      });
      lastFollowed.current = { ...currentPosition, heading: headingDeg };
    }
  }, [currentPosition?.lat, currentPosition?.lon, headingDeg, northUp]);

  function setZoom(next: number) {
    const bounded = Math.max(3, Math.min(19.5, next));
    zoomRef.current = bounded;
    setZoomLevel(bounded);
    camera.current?.zoomTo(bounded, 180);
  }

  function recenter() {
    if (!currentPosition) return;
    following.current = true;
    setNorthUp(false);
    lastFollowed.current = null;
    camera.current?.setCamera({
      centerCoordinate: [currentPosition.lon, currentPosition.lat],
      zoomLevel: Math.max(zoomRef.current, 15),
      heading: headingDeg ?? 0,
      animationDuration: 500,
      animationMode: "flyTo",
    });
    setZoom(Math.max(zoomRef.current, 15));
  }

  function resetCompass() {
    setNorthUp(true);
    camera.current?.setCamera({ heading: 0, animationDuration: 300, animationMode: "easeTo" });
  }

  const background = isDark ? "#101d2a" : "#e8eff2";
  const text = isDark ? "#f4f8fb" : "#10212d";
  const muted = isDark ? "#b5c5d2" : "#526775";
  const pinColor = isDark ? "#f3fbfa" : "#ffffff";

  if (!styleUrl) {
    return <View style={[styles.map, styles.stateBackground, { backgroundColor: background }]}>
      <Text style={[styles.stateTitle, { color: text }]}>{isEnglish ? "Map style is missing" : "Не задано стиль мапи"}</Text>
      <Text style={[styles.stateText, { color: muted }]}>{isEnglish ? "Add a MapLibre style URL in the NAVIA environment settings." : "Додайте адресу стилю MapLibre у налаштування NAVIA."}</Text>
    </View>;
  }

  return (
    <View style={[styles.map, { backgroundColor: background }]}>
      <MapLibreGL.MapView
        key={`${styleUrl}:${attempt}`}
        style={StyleSheet.absoluteFill}
        mapStyle={styleUrl}
        logoEnabled={false}
        attributionEnabled={false}
        scrollEnabled
        zoomEnabled
        rotateEnabled
        pitchEnabled={false}
        onRegionWillChange={(feature) => {
          if (feature.properties.isUserInteraction) following.current = false;
        }}
        onRegionDidChange={(feature) => {
          if (feature.properties.isUserInteraction) {
            zoomRef.current = feature.properties.zoomLevel;
            setZoomLevel(feature.properties.zoomLevel);
          }
        }}
        onDidFinishLoadingMap={() => {
          setLoadState("ready");
          if (currentPosition && following.current) {
            camera.current?.setCamera({
              centerCoordinate: [currentPosition.lon, currentPosition.lat],
              zoomLevel: zoomRef.current,
              heading: northUp ? 0 : headingDeg ?? 0,
              animationDuration: 0,
            });
            lastFollowed.current = { ...currentPosition, heading: headingDeg };
          }
        }}
        onDidFailLoadingMap={() => setLoadState("error")}
      >
        <MapLibreGL.Camera
          ref={camera}
          defaultSettings={{
            centerCoordinate: [center.lon, center.lat],
            zoomLevel: currentPosition ? 15.5 : routeGeometry.length > 1 ? 12.5 : 12,
            heading: currentPosition ? headingDeg ?? 0 : 0,
          }}
        />
        {routeGeometry.length > 1 && (
          <MapLibreGL.ShapeSource id="navia-route" shape={routeShape}>
            <MapLibreGL.LineLayer id="navia-route-casing" style={{ lineColor: isDark ? "#062d31" : "#ffffff", lineWidth: 11, lineCap: "round", lineJoin: "round", lineOpacity: 0.9 }} />
            <MapLibreGL.LineLayer id="navia-route-line" style={{ lineColor: isDark ? "#62e2d3" : "#087f78", lineWidth: 6, lineCap: "round", lineJoin: "round" }} />
          </MapLibreGL.ShapeSource>
        )}
        {currentPosition && (
          <MapLibreGL.PointAnnotation id="navia-you" coordinate={[currentPosition.lon, currentPosition.lat]}>
            <View style={[styles.currentPositionMarker, { borderColor: pinColor, backgroundColor: positionColor(positionQuality) }]}>
              <Text style={[styles.currentDirection, { transform: [{ rotate: `${northUp ? headingDeg ?? 0 : 0}deg` }] }]}>▲</Text>
              <View style={styles.currentPositionCore} />
            </View>
          </MapLibreGL.PointAnnotation>
        )}
        {routeGeometry.length > 1 && (
          <MapLibreGL.PointAnnotation
            id="navia-destination"
            coordinate={[routeGeometry[routeGeometry.length - 1]!.lon, routeGeometry[routeGeometry.length - 1]!.lat]}
            title={isEnglish ? "Destination" : "Місце призначення"}
          >
            <View style={[styles.destinationMarker, { backgroundColor: isDark ? "#e46b7b" : "#c83f56", borderColor: pinColor }]}>
              <Text style={styles.destinationMarkerText}>◎</Text>
            </View>
          </MapLibreGL.PointAnnotation>
        )}
        {nearbyPlaces.slice(0, 45).map((place) => (
          <MapLibreGL.PointAnnotation key={place.id} id={place.id} coordinate={[place.location.lon, place.location.lat]}>
            <View style={[styles.placeMarker, { backgroundColor: markerColor(place), borderColor: pinColor }]}>
              <Text style={styles.placeMarkerText}>{markerGlyph(place)}</Text>
            </View>
          </MapLibreGL.PointAnnotation>
        ))}
      </MapLibreGL.MapView>

      {loadState !== "ready" && (
        <View pointerEvents="box-none" style={styles.loadOverlay}>
          <View style={[styles.loadCard, { backgroundColor: isDark ? "#101d2aee" : "#ffffffed", borderColor: isDark ? "#26394c" : "#d7e1e6" }]}>
            <Text style={[styles.stateTitle, { color: text }]}>{loadState === "loading" ? (isEnglish ? "Loading the map…" : "Завантажуємо мапу…") : (isEnglish ? "Map tiles could not load" : "Не вдалося завантажити мапу")}</Text>
            <Text style={[styles.stateText, { color: muted }]}>{loadState === "loading" ? (isEnglish ? "OpenStreetMap · live streets and places" : "OpenStreetMap · актуальні вулиці та місця") : (isEnglish ? "Check the internet connection and retry." : "Перевірте інтернет-з’єднання та спробуйте ще раз.")}</Text>
            {loadState === "error" && <Pressable onPress={() => setAttempt((value) => value + 1)} style={styles.retryButton}><Text style={styles.retryText}>{isEnglish ? "Retry" : "Спробувати ще"}</Text></Pressable>}
          </View>
        </View>
      )}

      <View pointerEvents="box-none" style={[styles.mapControls, { top: controlsTopOffset }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={isEnglish ? "Increase map zoom" : "Збільшити масштаб мапи"} onPress={() => setZoom(zoomRef.current + 1)} style={[styles.mapControl, { backgroundColor: isDark ? "#101d2aee" : "#ffffffed" }]}><Text style={[styles.mapControlText, { color: text }]}>+</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={isEnglish ? "Decrease map zoom" : "Зменшити масштаб мапи"} onPress={() => setZoom(zoomRef.current - 1)} style={[styles.mapControl, { backgroundColor: isDark ? "#101d2aee" : "#ffffffed" }]}><Text style={[styles.mapControlText, { color: text }]}>−</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={isEnglish ? "Center map on my location" : "Повернутися до мого місця"} disabled={!currentPosition} onPress={recenter} style={[styles.mapControl, { backgroundColor: isDark ? "#101d2aee" : "#ffffffed", opacity: currentPosition ? 1 : 0.55 }]}><Text style={[styles.mapControlText, { color: text }]}>⌖</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={isEnglish ? "Point map north" : "Повернути мапу на північ"} onPress={resetCompass} style={[styles.mapControl, { backgroundColor: isDark ? "#101d2aee" : "#ffffffed" }]}><Text style={[styles.compassText, { color: text }]}>N</Text><Text style={[styles.compassArrow, { color: isDark ? "#ff6978" : "#c73448" }]}>▲</Text></Pressable>
      </View>

      <Pressable style={[styles.attribution, { backgroundColor: isDark ? "#08111ddd" : "#ffffffdd" }]} onPress={() => void Linking.openURL("https://openfreemap.org/")} accessibilityLabel={isEnglish ? "Map data attribution" : "Джерела даних мапи"}>
        <Text style={[styles.attributionText, { color: isDark ? "#d7e4e8" : "#344650" }]}>© OpenStreetMap · OpenFreeMap</Text>
      </Pressable>
    </View>
  );
}

export const MapLibreRouteView = React.memo(MapLibreRouteViewBase, (previous, next) => {
  if (previous.styleUrl !== next.styleUrl || previous.isDark !== next.isDark || previous.isEnglish !== next.isEnglish
    || previous.positionQuality !== next.positionQuality || previous.controlsTopOffset !== next.controlsTopOffset
    || !sameRouteGeometry(previous.routeGeometry, next.routeGeometry) || !sameLatLon(previous.initialCenter, next.initialCenter)) return false;
  if (!sameLatLon(previous.currentPosition, next.currentPosition) || !sameHeading(previous.headingDeg, next.headingDeg)) return false;
  const previousPlaces = previous.nearbyPlaces ?? [];
  const nextPlaces = next.nearbyPlaces ?? [];
  if (previousPlaces.length !== nextPlaces.length) return false;
  for (let i = 0; i < previousPlaces.length; i++) {
    const before = previousPlaces[i];
    const after = nextPlaces[i];
    if (before?.id !== after?.id || before?.category !== after?.category || before?.name !== after?.name
      || !sameLatLon(before?.location ?? null, after?.location ?? null)) return false;
  }
  return true;
});

function sameLatLon(left: LatLon | null | undefined, right: LatLon | null | undefined): boolean {
  if (!left || !right) return left === right;
  const latScale = 111_320;
  const lonScale = latScale * Math.cos(((left.lat + right.lat) / 2) * Math.PI / 180);
  return Math.hypot((left.lat - right.lat) * latScale, (left.lon - right.lon) * lonScale) < 3;
}

function sameRouteGeometry(left: LatLon[], right: LatLon[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i]?.lat !== right[i]?.lat || left[i]?.lon !== right[i]?.lon) return false;
  }
  return true;
}

function sameHeading(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(((left - right + 540) % 360) - 180) < 8;
}

const styles = StyleSheet.create({
  map: { flex: 1, minHeight: 190, overflow: "hidden", backgroundColor: "#e8eff2" },
  stateBackground: { alignItems: "center", justifyContent: "center", padding: 24 },
  stateTitle: { fontSize: 14, lineHeight: 19, fontWeight: "800", textAlign: "center" },
  stateText: { fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 5 },
  loadOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 18 },
  loadCard: { maxWidth: 300, borderRadius: 17, borderWidth: 1, paddingHorizontal: 17, paddingVertical: 13, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, elevation: 4 },
  retryButton: { marginTop: 10, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 11, backgroundColor: "#087f78" },
  retryText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  attribution: { position: "absolute", right: 8, bottom: 7, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7 },
  attributionText: { fontSize: 8, fontWeight: "600" },
  mapControls: { position: "absolute", right: 10, zIndex: 6, gap: 7, alignItems: "center", flexDirection: "row" },
  mapControl: { width: 43, height: 43, borderRadius: 14, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 8, elevation: 4 },
  mapControlText: { fontSize: 25, lineHeight: 29, fontWeight: "700" },
  compassText: { fontSize: 10, fontWeight: "900", lineHeight: 11 },
  compassArrow: { fontSize: 14, lineHeight: 16, marginTop: -1 },
  currentPositionMarker: { width: 31, height: 31, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 2, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 6, elevation: 5 },
  currentDirection: { color: "#fff", fontSize: 15, lineHeight: 17, fontWeight: "900", position: "absolute", top: 1 },
  currentPositionCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff", borderWidth: 1, borderColor: "#fff", marginTop: 7 },
  destinationMarker: { width: 33, height: 33, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 2, shadowColor: "#000", shadowOpacity: 0.27, shadowRadius: 5, elevation: 5 },
  destinationMarkerText: { color: "#fff", fontSize: 21, lineHeight: 25, fontWeight: "900" },
  placeMarker: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderWidth: 2, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, elevation: 4 },
  placeMarkerText: { color: "#fff", fontSize: 10, fontWeight: "900" },
});

function markerGlyph(place: NearbyPlace): string {
  switch (place.category) {
    case "shelter": return "S";
    case "resilience": return "⚡";
    case "fuel": return "F";
    case "pharmacy": return "+";
    case "hospital": return "H";
    case "transport": return "M";
    case "police": return "P";
    case "fire": return "F";
    case "atm": return "₴";
    case "parking": return "P";
    case "charger": return "⚡";
    case "toilets": return "WC";
    case "water": return "W";
    default: return "•";
  }
}

function markerColor(place: NearbyPlace): string {
  switch (place.category) {
    case "shelter": return "#cf3f57";
    case "resilience": return "#d58d19";
    case "fuel": return "#346bda";
    case "pharmacy": case "hospital": return "#158772";
    case "transport": return "#654fbd";
    case "police": case "fire": return "#c24136";
    case "atm": return "#168090";
    case "parking": return "#5b7180";
    case "charger": return "#12806c";
    case "toilets": case "water": return "#367da0";
    default: return "#4c7b8f";
  }
}

function positionColor(quality: "good" | "degraded" | "lost"): string {
  if (quality === "lost") return "#9b3445";
  if (quality === "degraded") return "#b97816";
  return "#087f78";
}
