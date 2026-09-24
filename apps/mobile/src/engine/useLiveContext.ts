// Live context for the map-first home screen: device position fed through the
// shared NavigationEngine (so GPS health uses the same validated pipeline as
// navigation), the local air-alert status, the regional summary and nearby
// places. Network calls are throttled; screens only read the result.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { useNavigationState } from "@react-navigation/native";
import type { GNSSRawSample } from "@navia/core";
import { navigationEngine, useNaviaStore } from "./naviaController";
import { GeolocatedAirAlertProvider } from "../providers/GeolocatedAirAlertProvider";
import { AirThreatSummaryProvider } from "../providers/AirThreatSummaryProvider";
import type { FetchCategory } from "../providers/NearbyPlacesProvider";
import { useNearbyStore } from "../store/nearbyStore";

export type GpsStatus = "checking" | "permission" | "searching" | "ready" | "error";
export type GnssHealth = "stable" | "unstable" | "lost";
export type LoadState = "idle" | "loading" | "ready" | "error";

const alertProvider = new GeolocatedAirAlertProvider();
const threatProvider = new AirThreatSummaryProvider();

const ALERT_EVERY_MS = 30_000;

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
  const [refreshing, setRefreshing] = useState(false);
  const byCategory = useNearbyStore((s) => s.byCategory);
  const shelterRequested = useRef(false);
  const sub = useRef<Location.LocationSubscription | null>(null);
  const lastAlertAt = useRef(0);
  const probing = useRef(false);
  const lastProbeAt = useRef(0);

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

  /** Loads one category on demand (chips, nearest shelter). */
  const loadCategory = useCallback(async (category: FetchCategory, force = false) => {
    await useNearbyStore.getState().load(category, force);
  }, []);

  const onLocation = useCallback((loc: Location.LocationObject) => {
    const sample = toSample(loc);
    if (!sample) return;
    const accepted = navigationEngine.pushGnssSample(sample, Date.now());
    const state = navigationEngine.tick(Date.now());
    // Keep the shared store current so the co-pilot and other screens see
    // the same GNSS health as the home status.
    if (!useNaviaStore.getState().isDemoMode) useNaviaStore.getState().refresh();
    setHealth(healthFrom(state.gnss));
    setGpsStatus("ready");
    if (!accepted || state.trustedPosition?.position.timestamp !== sample.timestamp) return;
    setCurrentFix(sample);
    void loadAlert(sample);
    // Shelters are always kept ready for the "Nearest shelter" action.
    if (!shelterRequested.current) { shelterRequested.current = true; setTimeout(() => void loadCategory("shelter"), 1500); }
  }, [loadAlert, loadCategory, setCurrentFix]);

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

  // Keep listening while Home is covered by Search, Settings or the co-pilot
  // (those read the same live state). Pause only during turn-by-turn
  // navigation, which runs its own high-accuracy subscription.
  const navigating = useNavigationState((s) => s?.routes[s.index]?.name === "Navigation");
  useEffect(() => {
    if (navigating) return undefined;
    void start(false);
    // Staleness is decided by the engine clock; tick it so health can drop to
    // "lost" when fixes stop arriving.
    const tick = setInterval(() => {
      // iOS goes quiet while the phone stands still. After some silence ask
      // for a fresh fix: an answer means GPS is fine, no answer means trouble.
      // While the signal is not confirmed stable, ask more often so a real
      // recovery shows within ~15 s instead of a minute.
      const last = useNaviaStore.getState().currentFix;
      const stable = navigationEngine.getState().gnss === "NORMAL";
      const quietFor = stable ? 10_000 : 4_000;
      const probeEvery = stable ? 15_000 : 5_000;
      if (last && Date.now() - last.timestamp > quietFor && !probing.current && Date.now() - lastProbeAt.current > probeEvery) {
        probing.current = true;
        lastProbeAt.current = Date.now();
        void Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
        ]).then((loc) => { if (loc) onLocation(loc); }).catch(() => {}).finally(() => { probing.current = false; });
      }
      setHealth(healthFrom(navigationEngine.tick(Date.now()).gnss));
      if (!useNaviaStore.getState().isDemoMode) useNaviaStore.getState().refresh();
    }, 2_000);
    return () => { clearInterval(tick); sub.current?.remove(); sub.current = null; };
  }, [navigating, start, onLocation]);

  // During navigation the GPS subscription is paused here, but the alert must
  // stay current: re-check it every minute from the latest known position.
  useEffect(() => {
    if (!navigating) return undefined;
    const every = setInterval(() => {
      const fix = useNaviaStore.getState().state.position?.position ?? useNaviaStore.getState().currentFix;
      if (fix) void loadAlert({ lat: fix.lat, lon: fix.lon, timestamp: Date.now(), accuracyM: null, speedMps: null, headingDeg: null }, true);
    }, 60_000);
    return () => clearInterval(every);
  }, [navigating, loadAlert]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await start(true);
      const fix = useNaviaStore.getState().currentFix;
      if (fix) {
        const loaded = Object.keys(useNearbyStore.getState().byCategory) as FetchCategory[];
        await Promise.all([loadAlert(fix, true), ...loaded.map((c) => loadCategory(c, true))]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadAlert, loadCategory, start]);

  return { gpsStatus, health, alertState, byCategory, loadCategory, refreshing, refresh, requestPermission: () => start(true) };
}
