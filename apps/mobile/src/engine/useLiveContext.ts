// Live context for the map-first home screen: device position fed through the
// shared NavigationEngine (so GPS health uses the same validated pipeline as
// navigation), the local air-alert status, the regional summary and nearby
// places. Network calls are throttled; screens only read the result.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { useFocusEffect } from "@react-navigation/native";
import type { GNSSRawSample } from "@navia/core";
import { navigationEngine, useNaviaStore } from "./naviaController";
import { GeolocatedAirAlertProvider } from "../providers/GeolocatedAirAlertProvider";
import { AirThreatSummaryProvider } from "../providers/AirThreatSummaryProvider";
import { NearbyPlacesProvider, type NearbyPlace } from "../providers/NearbyPlacesProvider";

export type GpsStatus = "checking" | "permission" | "searching" | "ready" | "error";
export type GnssHealth = "stable" | "unstable" | "lost";
export type LoadState = "idle" | "loading" | "ready" | "error";

const alertProvider = new GeolocatedAirAlertProvider();
const threatProvider = new AirThreatSummaryProvider();
const placesProvider = new NearbyPlacesProvider();

const ALERT_EVERY_MS = 30_000;
const PLACES_EVERY_MS = 45_000;

function toSample(loc: Location.LocationObject): GNSSRawSample | null {
  const { latitude, longitude, accuracy, speed, heading } = loc.coords;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  if (Date.now() - loc.timestamp > 15_000 || loc.timestamp > Date.now() + 1_500) return null;
  return {
    lat: latitude,
    lon: longitude,
    timestamp: loc.timestamp,
    accuracyM: accuracy != null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    speedMps: speed != null && Number.isFinite(speed) && speed >= 0 ? speed : null,
    headingDeg: heading != null && Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null,
  };
}

function healthFrom(gnss: string): GnssHealth {
  return gnss === "NORMAL" ? "stable" : gnss === "DEGRADED" ? "unstable" : "lost";
}

export function useLiveContext() {
  const setCurrentFix = useNaviaStore((s) => s.setCurrentFix);
  const setAlert = useNaviaStore((s) => s.setAlert);
  const setThreat = useNaviaStore((s) => s.setAirThreatSummary);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("checking");
  const [health, setHealth] = useState<GnssHealth>("lost");
  const [alertState, setAlertState] = useState<LoadState>("idle");
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [placesState, setPlacesState] = useState<LoadState>("idle");
  const [refreshing, setRefreshing] = useState(false);
  const sub = useRef<Location.LocationSubscription | null>(null);
  const lastAlertAt = useRef(0);
  const lastPlacesAt = useRef(0);

  const loadPlaces = useCallback(async (point: GNSSRawSample, force = false) => {
    if (!force && Date.now() - lastPlacesAt.current < PLACES_EVERY_MS) return;
    lastPlacesAt.current = Date.now();
    setPlacesState((s) => (s === "ready" ? s : "loading"));
    try {
      const region = useNaviaStore.getState().alert?.region;
      setPlaces(await placesProvider.fetchNearby({ lat: point.lat, lon: point.lon }, { includeKyivOfficialData: region === "м. Київ", force }));
      setPlacesState("ready");
    } catch {
      setPlacesState((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  const loadAlert = useCallback(async (point: GNSSRawSample, force = false) => {
    if (!force && Date.now() - lastAlertAt.current < ALERT_EVERY_MS) return;
    lastAlertAt.current = Date.now();
    setAlertState((s) => (s === "ready" ? s : "loading"));
    try {
      const status = await alertProvider.fetchAt({ lat: point.lat, lon: point.lon });
      setAlert(status);
      setAlertState("ready");
      threatProvider.fetchForRegion(status.region, status.district ?? "").then(setThreat).catch(() => setThreat(null));
    } catch {
      setAlertState("error");
    }
  }, [setAlert, setThreat]);

  const onLocation = useCallback((loc: Location.LocationObject) => {
    const sample = toSample(loc);
    if (!sample) return;
    const accepted = navigationEngine.pushGnssSample(sample, Date.now());
    const state = navigationEngine.tick(Date.now());
    setHealth(healthFrom(state.gnss));
    setGpsStatus("ready");
    if (!accepted || state.trustedPosition?.position.timestamp !== sample.timestamp) return;
    setCurrentFix(sample);
    void loadAlert(sample);
    void loadPlaces(sample);
  }, [loadAlert, loadPlaces, setCurrentFix]);

  const start = useCallback(async (ask: boolean) => {
    let permission = await Location.getForegroundPermissionsAsync().catch(() => ({ status: "denied" as const, canAskAgain: false }));
    if (permission.status !== "granted" && ask) permission = await Location.requestForegroundPermissionsAsync().catch(() => ({ status: "denied" as const, canAskAgain: false }));
    if (permission.status !== "granted") { setGpsStatus("permission"); return; }
    setGpsStatus((s) => (s === "ready" ? s : "searching"));
    try {
      if (!sub.current) {
        // No distance filter: with one, iOS sends nothing while the phone stands
        // still, the fix goes stale and GPS would read as lost.
        sub.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, onLocation);
      }
      onLocation(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    } catch {
      setGpsStatus((s) => (s === "ready" ? s : "error"));
    }
  }, [onLocation]);

  useFocusEffect(useCallback(() => {
    void start(false);
    // Staleness is decided by the engine clock; tick it so health can drop to
    // "lost" when fixes stop arriving.
    const tick = setInterval(() => setHealth(healthFrom(navigationEngine.tick(Date.now()).gnss)), 2_000);
    return () => { clearInterval(tick); sub.current?.remove(); sub.current = null; };
  }, [start]));

  useEffect(() => () => { sub.current?.remove(); }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await start(true);
      const fix = useNaviaStore.getState().currentFix;
      if (fix) await Promise.all([loadAlert(fix, true), loadPlaces(fix, true)]);
    } finally {
      setRefreshing(false);
    }
  }, [loadAlert, loadPlaces, start]);

  return { gpsStatus, health, alertState, places, placesState, refreshing, refresh, requestPermission: () => start(true) };
}
