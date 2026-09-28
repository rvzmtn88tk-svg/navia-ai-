// NAVIA map: MapLibre with the branded position puck, route, places and a
// camera that can follow the user heading-up in 3D during navigation.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import MapLibreGL from "@maplibre/maplibre-react-native";
import { destinationPoint, type LatLon } from "@navia/core";
import type { NearbyPlace } from "../providers/NearbyPlacesProvider";
import { CATEGORY_META } from "../places/categories";
import { Icon } from "../components/Icon";
import { Touchable, useColors } from "../components/ui";
import { elevation, motion } from "../theme/tokens";
import { UserPuck, type PuckQuality } from "./UserPuck";
import { pickPoi, type BasemapPoi } from "./basemapPoi";
import { perfEnd, perfPending, perfStart } from "../perf/perf";

export type CameraMode = "free" | "follow" | "navigate";

export type UserPosition = LatLon & { headingDeg: number | null; accuracyM: number | null };

export type NaviaMapHandle = {
  recenter: () => void;
  zoomBy: (delta: number) => void;
  flyTo: (point: LatLon, zoom?: number, bottomPadding?: number) => void;
  fitPoints: (points: LatLon[], bottomPadding?: number) => void;
  resetNorth: () => void;
  /** Map centre (used for "I am here" placement). */
  getCenter: () => Promise<LatLon | null>;
};

type Props = {
  mapStyle: string;
  user: UserPosition | null;
  quality: PuckQuality;
  cameraMode: CameraMode;
  onUserGesture?: () => void;
  onBearingChange?: (bearing: number) => void;
  routeGeometry?: LatLon[];
  traveledGeometry?: LatLon[];
  destination?: LatLon | null;
  places?: NearbyPlace[];
  selectedPlaceId?: string | null;
  onPlacePress?: (place: NearbyPlace) => void;
  /** A tap on a point of interest drawn by the base map (shop, pharmacy, …). */
  onBasemapPoiPress?: (poi: BasemapPoi) => void;
  /** Screen area covered by overlays; keeps the camera target in the visible part. */
  padding?: { top: number; bottom: number; left?: number; right?: number };
  onMapError?: () => void;
  onMapReady?: () => void;
  /** Current speed, for the automatic navigation zoom. */
  speedMps?: number | null;
  /** Strict search circle drawn on the map (radius search). */
  searchCircle?: { center: LatLon; radiusM: number } | null;
  /** Navigation view: 3D tilt (buildings stand up) or flat 2D. */
  view3d?: boolean;
  /** How "me on the map" is turned: where the phone points, or the route course. */
  headingMode?: "device" | "course";
  /** Called after every rendered frame (dev FPS meter). */
  onFrame?: () => void;
};

const KYIV: LatLon = { lat: 50.4501, lon: 30.5234 };
const FOLLOW_ZOOM = 15.5;
// 55°, not 60°: at steeper tilts most of the frame is far away and drawn
// from low-zoom tiles, which is what looked blurry.
const NAV_PITCH_3D = 55;
const NAV_PITCH_2D = 0;

/** Navigation zoom by speed: close on foot, wider in town, widest on the highway. */
export function autoNavZoom(speedMps: number | null | undefined): number {
  const v = speedMps ?? 0;
  if (v < 2.5) return 16.8;
  if (v < 9) return 16.2;
  if (v < 17) return 15.6;
  if (v < 25) return 15;
  return 14.4;
}

export const NaviaMap = React.memo(forwardRef<NaviaMapHandle, Props>(function NaviaMap(props, ref) {
  const {
    mapStyle, user, quality, cameraMode, onUserGesture, onBearingChange, routeGeometry = [], traveledGeometry = [],
    destination, places = [], selectedPlaceId, onPlacePress, onBasemapPoiPress, padding = { top: 0, bottom: 0 }, onMapError, onMapReady, speedMps, searchCircle, view3d = false, onFrame, headingMode = "device",
  } = props;
  const view3dRef = useRef(view3d);
  view3dRef.current = view3d;
  const c = useColors();
  const camera = useRef<MapLibreGL.CameraRef | null>(null);
  const mapView = useRef<MapLibreGL.MapViewRef | null>(null);
  const zoom = useRef(user ? FOLLOW_ZOOM : 12);
  const bearing = useRef(0);
  // A pinch keeps following but remembers the chosen zoom; a drag takes the
  // camera over (free mode). Follow updates pause while touching.
  const userNavZoom = useRef<number | null>(null);
  const fingers = useRef(0);
  const gesture = useRef<{ x: number; y: number; zoom: number; moved: boolean } | null>(null);
  const liveZoom = useRef(user ? FOLLOW_ZOOM : 12);
  const speed = useRef<number | null | undefined>(speedMps);
  speed.current = speedMps;
  const lastUser = useRef<UserPosition | null>(user);
  lastUser.current = user;
  const [initialCenter] = useState<LatLon>(user ?? KYIV);

  const cameraPadding = useMemo(() => ({
    paddingTop: padding.top, paddingBottom: padding.bottom, paddingLeft: padding.left ?? 0, paddingRight: padding.right ?? 0,
  }), [padding.top, padding.bottom, padding.left, padding.right]);

  const moveToUser = useCallback((duration: number, mode: CameraMode) => {
    const u = lastUser.current;
    if (!u || mode === "free" || fingers.current > 0) return;
    const heading = mode === "navigate" ? (u.headingDeg ?? bearing.current) : bearing.current;
    camera.current?.setCamera({
      centerCoordinate: [u.lon, u.lat],
      zoomLevel: mode === "navigate" ? userNavZoom.current ?? autoNavZoom(speed.current) : Math.max(zoom.current, 14),
      heading,
      pitch: mode === "navigate" ? (view3dRef.current ? NAV_PITCH_3D : NAV_PITCH_2D) : 0,
      padding: cameraPadding,
      animationDuration: duration,
      animationMode: duration > 0 ? "easeTo" : "moveTo",
    });
  }, [cameraPadding]);

  // Follow the user on every new position. The duration matches the GPS
  // interval so camera and puck glide together instead of jumping.
  useEffect(() => {
    if (cameraMode !== "free") moveToUser(900, cameraMode);
  }, [user?.lat, user?.lon, user?.headingDeg, cameraMode, moveToUser]);

  // 2D ↔ 3D switch: tilt the camera now.
  useEffect(() => {
    if (cameraMode === "navigate") moveToUser(motion.normal, "navigate");
  }, [view3d]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mode switches (e.g. overview → navigation) get the long cinematic move.
  const previousMode = useRef(cameraMode);
  useEffect(() => {
    if (previousMode.current !== cameraMode && cameraMode !== "free") moveToUser(motion.camera, cameraMode);
    previousMode.current = cameraMode;
  }, [cameraMode, moveToUser]);

  useImperativeHandle(ref, () => ({
    recenter: () => { userNavZoom.current = null; moveToUser(motion.slow + motion.fast, cameraMode === "free" ? "follow" : cameraMode); },
    zoomBy: (delta) => {
      zoom.current = Math.max(3, Math.min(19.5, zoom.current + delta));
      camera.current?.zoomTo(zoom.current, motion.fast);
    },
    flyTo: (point, z = 16, bottomPadding) => {
      zoom.current = z;
      const pad = bottomPadding == null ? cameraPadding : { ...cameraPadding, paddingBottom: bottomPadding };
      camera.current?.setCamera({ centerCoordinate: [point.lon, point.lat], zoomLevel: z, pitch: 0, padding: pad, animationDuration: 800, animationMode: "flyTo" });
    },
    fitPoints: (points, bottomPadding) => {
      if (points.length < 2) return;
      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (const p of points) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); }
      camera.current?.fitBounds([maxLon, maxLat], [minLon, minLat], [padding.top + 32, 48, (bottomPadding ?? padding.bottom) + 32, 48], motion.camera);
    },
    resetNorth: () => camera.current?.setCamera({ heading: 0, pitch: 0, animationDuration: motion.normal, animationMode: "easeTo" }),
    getCenter: async () => {
      const center = await mapView.current?.getCenter().catch(() => null);
      return center ? { lon: center[0]!, lat: center[1]! } : null;
    },
  }), [cameraMode, cameraPadding, moveToUser, padding.bottom, padding.top]);

  // The base map's POI layers (OpenMapTiles "poi"), for taps on its icons.
  const poiLayerIds = useMemo(() => {
    if (!mapStyle.trim().startsWith("{")) return null;
    try { return (JSON.parse(mapStyle) as { layers?: { id: string; type: string }[] }).layers?.filter((l) => l.type === "symbol" && l.id.startsWith("poi")).map((l) => l.id) ?? null; } catch { return null; }
  }, [mapStyle]);
  const onMapPress = useCallback(async (feature: GeoJSON.Feature) => {
    if (!onBasemapPoiPress) return;
    const props = (feature.properties ?? {}) as { screenPointX?: number; screenPointY?: number };
    const coords = (feature.geometry as GeoJSON.Point | undefined)?.coordinates;
    if (props.screenPointX == null || props.screenPointY == null || !coords) return;
    const r = 18; // finger-sized hit box, in points
    const x = props.screenPointX, y = props.screenPointY;
    // Native order: [top, right, bottom, left] with top = the larger y.
    const hits = await mapView.current?.queryRenderedFeaturesInRect([y + r, x + r, y - r, x - r], undefined, poiLayerIds ?? []).catch(() => null);
    const candidates = (hits?.features ?? []).filter((f) => poiLayerIds ? true : isPoiLike(f.properties));
    const poi = pickPoi(candidates as Parameters<typeof pickPoi>[0], { lat: coords[1]!, lon: coords[0]! }, user ? { lat: user.lat, lon: user.lon } : null);
    if (poi) onBasemapPoiPress(poi);
  }, [onBasemapPoiPress, poiLayerIds, user?.lat, user?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // Timings: first map, style switch (day/night/satellite), 2D↔3D.
  useState(() => { perfStart("map: open → first map"); return null; });
  const firstStyle = useRef(true);
  useEffect(() => { if (firstStyle.current) { firstStyle.current = false; return; } perfStart("map: style switch"); }, [mapStyle]);
  const first3d = useRef(true);
  useEffect(() => { if (first3d.current) { first3d.current = false; return; } perfStart("map: 2D↔3D → frame"); }, [view3d]);
  const frame = useCallback(() => { if (perfPending("map: 2D↔3D → frame")) perfEnd("map: 2D↔3D → frame"); onFrame?.(); }, [onFrame]);

  const routeShape = useMemo(() => lineFeature(routeGeometry), [routeGeometry]);
  const traveledShape = useMemo(() => lineFeature(traveledGeometry), [traveledGeometry]);

  return (
    // A finger dragging on the map means the user took control of the camera.
    // (MapLibre's isUserInteraction flag is unreliable while a follow
    // animation is running, so the touch itself is the signal.)
    <View
      style={StyleSheet.absoluteFill}
      onTouchStart={(e) => {
        fingers.current = e.nativeEvent.touches.length;
        if (!gesture.current) gesture.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, zoom: liveZoom.current, moved: false };
      }}
      onTouchMove={(e) => {
        fingers.current = e.nativeEvent.touches.length;
        const g = gesture.current;
        if (g && Math.hypot(e.nativeEvent.pageX - g.x, e.nativeEvent.pageY - g.y) > 16) g.moved = true;
      }}
      onTouchEnd={(e) => {
        fingers.current = e.nativeEvent.touches.length;
        if (fingers.current > 0) return;
        const g = gesture.current;
        gesture.current = null;
        if (!g) return;
        // Decided when the fingers lift: a zoom change means pinch (keep
        // following, remember the zoom); a drag without zoom change is a pan
        // that takes the camera over. (The map may see two fingers where
        // React Native only sees one, so finger counts can't decide this.)
        if (Math.abs(liveZoom.current - g.zoom) > 0.08) {
          if (cameraMode === "navigate") userNavZoom.current = Math.max(12.5, Math.min(18.5, liveZoom.current));
        } else if (g.moved) {
          onUserGesture?.();
        }
      }}
      onTouchCancel={() => { fingers.current = 0; gesture.current = null; }}
    >
      <MapLibreGL.MapView
        ref={mapView}
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        pitchEnabled
        rotateEnabled
        // Gesture detection lives in the touch handlers above (pinch ≠ pan).
        onRegionIsChanging={(feature) => { liveZoom.current = feature.properties.zoomLevel; }}
        onRegionDidChange={(feature) => {
          zoom.current = feature.properties.zoomLevel;
          liveZoom.current = feature.properties.zoomLevel;
          const h = feature.properties.heading ?? 0;
          if (Math.abs(h - bearing.current) > 0.5) { bearing.current = h; onBearingChange?.(h); }
        }}
        onDidFinishLoadingMap={() => { perfEnd("map: open → first map"); perfEnd("map: style switch"); onMapReady?.(); }}
        onPress={(f) => { void onMapPress(f); }}
        // Every rendered frame is reported as either "fully" or "not fully" rendered.
        {...(onFrame || __DEV__ ? { onDidFinishRenderingFrame: frame, onDidFinishRenderingFrameFully: frame } : {})}
        onDidFailLoadingMap={onMapError}
      >
        <MapLibreGL.Camera ref={camera} defaultSettings={{ centerCoordinate: [initialCenter.lon, initialCenter.lat], zoomLevel: user ? FOLLOW_ZOOM : 12 }} />

        {routeGeometry.length > 1 && (
          // The route as an orbit trail: a soft glow, a dark casing and a
          // teal → orange gradient from here to the destination.
          <MapLibreGL.ShapeSource id="navia-route" shape={routeShape} lineMetrics>
            <MapLibreGL.LineLayer id="navia-route-glow" style={{ lineColor: c.routeLine, lineOpacity: 0.35, lineBlur: 8, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 12, 18, 34], lineCap: "round", lineJoin: "round" }} />
            <MapLibreGL.LineLayer id="navia-route-casing" style={{ lineColor: c.routeCasing, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 6, 18, 18], lineCap: "round", lineJoin: "round" }} />
            <MapLibreGL.LineLayer id="navia-route-line" style={{
              lineGradient: ["interpolate", ["linear"], ["line-progress"], 0, c.routeLine, 0.7, c.routeLine, 1, c.brandOrange],
              lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 4, 18, 13], lineCap: "round", lineJoin: "round",
            }} />
          </MapLibreGL.ShapeSource>
        )}
        {traveledGeometry.length > 1 && (
          <MapLibreGL.ShapeSource id="navia-traveled" shape={traveledShape}>
            <MapLibreGL.LineLayer id="navia-traveled-line" aboveLayerID="navia-route-line" style={{ lineColor: c.routeTraveled, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 5, 18, 15], lineCap: "round", lineJoin: "round", lineOpacity: 0.9 }} />
          </MapLibreGL.ShapeSource>
        )}

        {searchCircle && (
          <MapLibreGL.ShapeSource id="navia-search-circle" shape={circleFeature(searchCircle.center, searchCircle.radiusM)}>
            <MapLibreGL.FillLayer id="navia-search-circle-fill" style={{ fillColor: c.brandTeal, fillOpacity: 0.07 }} />
            <MapLibreGL.LineLayer id="navia-search-circle-line" style={{ lineColor: c.brandTeal, lineWidth: 2, lineDasharray: [2, 2], lineOpacity: 0.8 }} />
          </MapLibreGL.ShapeSource>
        )}

        {/* Every result: small dots for all, rich markers for the nearest 40. */}
        {places.length > 40 && (
          <MapLibreGL.ShapeSource id="navia-places-all" shape={pointsFeature(places.slice(40))}
            onPress={(e) => { const id = e.features?.[0]?.properties?.id; const hit = places.find((p) => p.id === id); if (hit) onPlacePress?.(hit); }}>
            <MapLibreGL.CircleLayer id="navia-places-dots" style={{ circleRadius: 5, circleColor: ["get", "color"], circleStrokeColor: c.surface, circleStrokeWidth: 1.5 }} />
          </MapLibreGL.ShapeSource>
        )}
        {places.slice(0, 40).map((place) => (
          <MapLibreGL.MarkerView key={place.id} id={`place-${place.id}`} coordinate={[place.location.lon, place.location.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <PlaceMarker place={place} selected={place.id === selectedPlaceId} onPress={onPlacePress} />
          </MapLibreGL.MarkerView>
        ))}

        {destination && (
          <MapLibreGL.MarkerView id="navia-destination" coordinate={[destination.lon, destination.lat]} anchor={{ x: 0.5, y: 1 }} allowOverlap>
            <View style={styles.destination} accessibilityLabel="destination">
              <Icon name="pin" size={40} color={c.critical} strokeWidth={2.4} />
            </View>
          </MapLibreGL.MarkerView>
        )}

        {user && <UserPuck position={user} quality={quality} billboard={view3d && cameraMode === "navigate"} speedMps={speedMps ?? null} headingMode={headingMode} />}
      </MapLibreGL.MapView>
    </View>
  );
}));

function PlaceMarker({ place, selected, onPress }: { place: NearbyPlace; selected: boolean; onPress?: (place: NearbyPlace) => void }): JSX.Element {
  const c = useColors();
  const meta = CATEGORY_META[place.category];
  const size = selected ? 40 : 30;
  return (
    <Touchable haptic accessibilityRole="button" accessibilityLabel={place.name} onPress={() => onPress?.(place)}
      style={[styles.placeMarker, { width: size, height: size, borderRadius: size / 2, backgroundColor: meta.color, borderColor: c.surface }, elevation(2, c)]}>
      <Icon name={meta.icon} size={selected ? 22 : 16} color={c.onMarker} />
    </Touchable>
  );
}

function circleFeature(center: LatLon, radiusM: number) {
  const ring = Array.from({ length: 73 }, (_, i) => destinationPoint(center, (i * 5) % 360, radiusM)).map((p) => [p.lon, p.lat]);
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [ring] } };
}

// Without the style's layer list: POI features have a class and are not
// settlement / street labels.
const PLACE_CLASSES = new Set(["country", "state", "province", "city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "isolated_dwelling", "island", "continent"]);
function isPoiLike(p: GeoJSON.GeoJsonProperties): boolean {
  return !!p && (typeof p.subclass === "string" || typeof p.class === "string") && !PLACE_CLASSES.has(String(p.class)) && p.rank != null;
}

function pointsFeature(places: NearbyPlace[]) {
  return {
    type: "FeatureCollection" as const,
    features: places.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id, color: CATEGORY_META[p.category].color },
      geometry: { type: "Point" as const, coordinates: [p.location.lon, p.location.lat] },
    })),
  };
}

function lineFeature(points: LatLon[]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: points.map((p) => [p.lon, p.lat]) },
  };
}

const styles = StyleSheet.create({
  placeMarker: { alignItems: "center", justifyContent: "center", borderWidth: 2 },
  destination: { alignItems: "center", justifyContent: "flex-end" },
});
