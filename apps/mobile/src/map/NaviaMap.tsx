// NAVIA map: MapLibre with the branded position puck, route, places and a
// camera that can follow the user heading-up in 3D during navigation.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import MapLibreGL from "@maplibre/maplibre-react-native";
import type { LatLon } from "@navia/core";
import type { NearbyPlace } from "../providers/NearbyPlacesProvider";
import { CATEGORY_META } from "../places/categories";
import { Icon } from "../components/Icon";
import { Touchable, useColors } from "../components/ui";
import { elevation, motion } from "../theme/tokens";
import { UserPuck, type PuckQuality } from "./UserPuck";

export type CameraMode = "free" | "follow" | "navigate";

export type UserPosition = LatLon & { headingDeg: number | null; accuracyM: number | null };

export type NaviaMapHandle = {
  recenter: () => void;
  zoomBy: (delta: number) => void;
  flyTo: (point: LatLon, zoom?: number, bottomPadding?: number) => void;
  fitPoints: (points: LatLon[], bottomPadding?: number) => void;
  resetNorth: () => void;
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
  /** Screen area covered by overlays; keeps the camera target in the visible part. */
  padding?: { top: number; bottom: number; left?: number; right?: number };
  onMapError?: () => void;
  onMapReady?: () => void;
};

const KYIV: LatLon = { lat: 50.4501, lon: 30.5234 };
const FOLLOW_ZOOM = 15.5;
const NAV_ZOOM = 17.2;
const NAV_PITCH = 55;

export const NaviaMap = React.memo(forwardRef<NaviaMapHandle, Props>(function NaviaMap(props, ref) {
  const {
    mapStyle, user, quality, cameraMode, onUserGesture, onBearingChange, routeGeometry = [], traveledGeometry = [],
    destination, places = [], selectedPlaceId, onPlacePress, padding = { top: 0, bottom: 0 }, onMapError, onMapReady,
  } = props;
  const c = useColors();
  const camera = useRef<MapLibreGL.CameraRef | null>(null);
  const zoom = useRef(user ? FOLLOW_ZOOM : 12);
  const bearing = useRef(0);
  const lastUser = useRef<UserPosition | null>(user);
  lastUser.current = user;
  const [initialCenter] = useState<LatLon>(user ?? KYIV);

  const cameraPadding = useMemo(() => ({
    paddingTop: padding.top, paddingBottom: padding.bottom, paddingLeft: padding.left ?? 0, paddingRight: padding.right ?? 0,
  }), [padding.top, padding.bottom, padding.left, padding.right]);

  const moveToUser = useCallback((duration: number, mode: CameraMode) => {
    const u = lastUser.current;
    if (!u || mode === "free") return;
    const heading = mode === "navigate" ? (u.headingDeg ?? bearing.current) : bearing.current;
    camera.current?.setCamera({
      centerCoordinate: [u.lon, u.lat],
      zoomLevel: mode === "navigate" ? NAV_ZOOM : Math.max(zoom.current, 14),
      heading,
      pitch: mode === "navigate" ? NAV_PITCH : 0,
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

  // Mode switches (e.g. overview → navigation) get the long cinematic move.
  const previousMode = useRef(cameraMode);
  useEffect(() => {
    if (previousMode.current !== cameraMode && cameraMode !== "free") moveToUser(motion.camera, cameraMode);
    previousMode.current = cameraMode;
  }, [cameraMode, moveToUser]);

  useImperativeHandle(ref, () => ({
    recenter: () => moveToUser(motion.slow + motion.fast, cameraMode === "free" ? "follow" : cameraMode),
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
  }), [cameraMode, cameraPadding, moveToUser, padding.bottom, padding.top]);

  const routeShape = useMemo(() => lineFeature(routeGeometry), [routeGeometry]);
  const traveledShape = useMemo(() => lineFeature(traveledGeometry), [traveledGeometry]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapLibreGL.MapView
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        pitchEnabled
        rotateEnabled
        onRegionWillChange={(feature) => { if (feature.properties.isUserInteraction) onUserGesture?.(); }}
        onRegionDidChange={(feature) => {
          zoom.current = feature.properties.zoomLevel;
          const h = feature.properties.heading ?? 0;
          if (Math.abs(h - bearing.current) > 0.5) { bearing.current = h; onBearingChange?.(h); }
        }}
        onDidFinishLoadingMap={onMapReady}
        onDidFailLoadingMap={onMapError}
      >
        <MapLibreGL.Camera ref={camera} defaultSettings={{ centerCoordinate: [initialCenter.lon, initialCenter.lat], zoomLevel: user ? FOLLOW_ZOOM : 12 }} />

        {routeGeometry.length > 1 && (
          <MapLibreGL.ShapeSource id="navia-route" shape={routeShape}>
            <MapLibreGL.LineLayer id="navia-route-casing" style={{ lineColor: c.routeCasing, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 6, 18, 18], lineCap: "round", lineJoin: "round" }} />
            <MapLibreGL.LineLayer id="navia-route-line" style={{ lineColor: c.routeLine, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 4, 18, 13], lineCap: "round", lineJoin: "round" }} />
          </MapLibreGL.ShapeSource>
        )}
        {traveledGeometry.length > 1 && (
          <MapLibreGL.ShapeSource id="navia-traveled" shape={traveledShape}>
            <MapLibreGL.LineLayer id="navia-traveled-line" aboveLayerID="navia-route-line" style={{ lineColor: c.routeTraveled, lineWidth: ["interpolate", ["exponential", 1.5], ["zoom"], 10, 5, 18, 15], lineCap: "round", lineJoin: "round", lineOpacity: 0.9 }} />
          </MapLibreGL.ShapeSource>
        )}

        {places.slice(0, 60).map((place) => (
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

        {user && <UserPuck position={user} quality={quality} />}
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
      <Icon name={meta.icon} size={selected ? 22 : 16} color="#FFFFFF" />
    </Touchable>
  );
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
