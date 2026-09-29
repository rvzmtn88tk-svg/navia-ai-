// Active-navigation screen — spec section 24 ("NAVIGATION UI") + the user's
// Stage 2 driving-UI requirements. UNBUILT/UNTESTED (see App.tsx). This
// screen ONLY: pushes real sensor samples into the shared NavigationEngine
// (via naviaController), reads NavigationState back out, renders it, and
// forwards user actions (reroute-on-offroute is triggered here, but the
// off-route DETECTION itself is entirely OffRouteDetector's, inside the
// engine) — no navigation math lives in this file, per the user's explicit
// "screens must not duplicate navigation logic" instruction, which applies
// identically to Demo Mode (naviaController's DemoEngine) and real mode
// (NavigationEngine).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useKeepAwake } from "expo-keep-awake";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GNSSRawSample, IMUSample, NavigationState } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { DEMO_DESTINATION, VoiceGuidance, PositionSmoother, haversineMeters, type Route } from "@navia/core";
import { navigationEngine, demoEngine, useNaviaStore, tripPlanner, demoTripPlanner, demoCopilot, activePlanner, activeCopilot, activeTripCache, preferenceStore } from "../engine/naviaController";
import { ConnectivityMonitor } from "../providers/ConnectivityMonitor";
import { ExpoLocationPositionProvider } from "../providers/ExpoLocationPositionProvider";
import { ExpoSensorsMotionProvider } from "../providers/ExpoSensorsMotionProvider";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";
import { MapLibreRouteView } from "../providers/MapLibreRouteView";
import { VoicePanel } from "../components/VoicePanel";
import { config } from "../config";

type Props = NativeStackScreenProps<RootStackParamList, "Navigation">;

const TICK_INTERVAL_MS = 1000;
const DEMO_TICK_SECONDS = 1; // 1x simulated time per real second

function maneuverPhrase(m: string): string {
  switch (m) {
    case "left": return "ліворуч";
    case "right": return "праворуч";
    case "uturn": return "розворот";
    case "roundabout": return "круговий рух";
    case "arrive": return "прибуття";
    case "depart": return "рушайте";
    default: return "прямо";
  }
}

function gnssStatusText(state: NavigationState): string {
  const p = state.positioning;
  if (p) {
    const err = `±${Math.max(10, Math.round(p.uncertaintyM / 10) * 10)} м`;
    switch (p.locationState) {
      case "SPOOFED": return `GPS підмінено — ігнорую, веду за датчиками (${err})`;
      case "LOST": return p.guidance === "none" ? "Позиція тимчасово невідома — чекаю на GPS" : `Без GPS: карта + ${p.imuAvailable ? "гіроскоп" : "швидкість"} (${err})`;
      case "STALE": return "GPS на мить зник — продовжую";
      case "UNSTABLE": return `GPS нестабільний (${err})`;
      case "REDUCED_ACCURACY": return `GPS неточний (${err})`;
      case "RECOVERED": return "GPS відновлено, звіряю позицію";
      default: return "GPS: норма";
    }
  }
  if (state.gnss === "NORMAL") return "GNSS: норма";
  if (state.gnss === "DEGRADED") return "GNSS нестабільний";
  return "GNSS втрачено — оцінюю положення";
}

const REROUTE_RETRY_MS = 20_000;

export function NavigationScreen({ route: navRoute }: Props): JSX.Element {
  const { destinationLat, destinationLon, destinationLabel } = navRoute.params;
  const { state, route, isDemoMode, refresh } = useNaviaStore();
  // Like any turn-by-turn navigator: the screen stays on during navigation, so
  // iOS doesn't suspend the app (and its GPS/IMU stream) when the phone locks.
  useKeepAwake();
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const voice = useRef(new ExpoSpeechVoiceProvider()).current;
  const guidance = useRef(new VoiceGuidance()).current;
  const smoother = useRef(new PositionSmoother()).current;
  const rerouting = useRef(false);
  const lastRerouteFailAt = useRef(0);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let positionSub: { remove: () => void } | null = null;
    let motionSub: { remove: () => void } | null = null;
    let tickHandle: ReturnType<typeof setInterval> | null = null;
    let savedRoute: Route | null = null;
    const connectivity = new ConnectivityMonitor((online) => {
      navigationEngine.setNetworkAvailable(online);
      if (online) setOfflineNotice(null);
      refresh();
    });
    guidance.reset();
    smoother.reset();

    const destination = { lat: destinationLat, lon: destinationLon };
    // The trip plan owns destination + stops + road preferences, so every
    // (re)route — first route, off-route recovery, co-pilot actions — keeps them.
    const planned = tripPlanner.getPlan().destination;
    if (!isDemoMode && (!planned || planned.location.lat !== destinationLat || planned.location.lon !== destinationLon)) {
      tripPlanner.setDestination({ label: destinationLabel, location: destination });
      activeCopilot().resetConversation();
      // Road preferences the driver saved as lasting ("never toll roads") apply to every new trip.
      const saved: Record<string, boolean> = {};
      for (const [pref, key] of [["avoid_tolls", "avoidTolls"], ["avoid_highways", "avoidHighways"], ["avoid_unpaved", "avoidUnpaved"]] as const) {
        const v = preferenceStore.get(pref);
        if (typeof v === "boolean") saved[key] = v;
      }
      if (Object.keys(saved).length) tripPlanner.setPreferences(saved);
    }

    async function startReal() {
      const locationProvider = new ExpoLocationPositionProvider();
      let granted: boolean;
      try {
        granted = await locationProvider.requestPermission();
      } catch {
        granted = false;
      }
      if (!granted) {
        if (!cancelled) setPermissionDenied(true);
        return;
      }

      const motionProvider = new ExpoSensorsMotionProvider();
      motionSub = motionProvider.subscribe((sample: IMUSample) => navigationEngine.pushImuSample(sample));

      positionSub = await locationProvider.subscribe(async (sample: GNSSRawSample) => {
        if (cancelled) return;
        navigationEngine.pushGnssSample(sample);
        navigationEngine.tick(sample.timestamp);
        refresh();

        // First fix with no route yet -> request one now that we know origin.
        if (!navigationEngine.getRoute() && !routeError) {
          try {
            navigationEngine.applyRoute(await tripPlanner.route({ lat: sample.lat, lon: sample.lon }));
            refresh();
          } catch (err) {
            // No internet? The trip saved on the phone still has a full route to this destination.
            const cached = await activeTripCache.load();
            const same = cached?.plan.destination && haversineMeters(cached.plan.destination.location, destination) < 50;
            if (cached && same) {
              tripPlanner.restore(cached.plan);
              navigationEngine.applyRoute(cached.route);
              if (!cancelled) setOfflineNotice("Немає зв'язку — веду за збереженим маршрутом.");
              refresh();
            } else if (!cancelled) {
              setRouteError((err as Error).message);
            }
          }
        }
      });
      connectivity.start();

      tickHandle = setInterval(() => {
        navigationEngine.tick(Date.now());
        markStopsVisited();
        refresh();
        // Keep the active trip saved on the phone whenever the route changes (any source: reroute, co-pilot).
        const r = navigationEngine.getRoute();
        if (r && r !== savedRoute) { savedRoute = r; void activeTripCache.save(tripPlanner.getPlan(), r).catch(() => {}); }
        // Off-route without GPS: reroute from the junction ahead of the car on the road it is on.
        const from = navigationEngine.getRerouteOrigin();
        if (from) void maybeReroute(from);
      }, TICK_INTERVAL_MS);
    }

    async function startDemo() {
      // A fresh demo drive starts with a fresh trip plan and conversation.
      demoTripPlanner.setDestination({ label: "Бориспіль (demo)", location: DEMO_DESTINATION });
      demoCopilot.resetConversation();
      try {
        await demoEngine.start();
        refresh();
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
        return;
      }
      tickHandle = setInterval(() => {
        demoEngine.tick(DEMO_TICK_SECONDS);
        markStopsVisited();
        refresh();
      }, TICK_INTERVAL_MS);
    }

    /** Drop co-pilot stops the vehicle has reached, so later reroutes don't send it back. */
    function markStopsVisited() {
      const pos = (isDemoMode ? demoEngine : navigationEngine).getState().position?.position;
      if (!pos) return;
      for (const stop of activePlanner().markVisitedNear(pos)) {
        void voice.speak(`Зупинка: ${stop.label}.`).catch(() => {});
      }
    }

    async function maybeReroute(current: { lat: number; lon: number }) {
      if (rerouting.current) return;
      if (!navigationEngine.getState().offRoute) return;
      if (Date.now() - lastRerouteFailAt.current < REROUTE_RETRY_MS) return;
      rerouting.current = true;
      try {
        navigationEngine.applyRoute(await tripPlanner.route(current));
        if (!cancelled) setOfflineNotice(null);
        refresh();
      } catch {
        // Never tear down navigation because a reroute failed (typically no
        // internet): keep the current route and say so; retry in a while.
        lastRerouteFailAt.current = Date.now();
        if (!cancelled) setOfflineNotice("Перебудувати маршрут зараз не вдалося (немає зв'язку). Продовжую за поточним маршрутом.");
        void connectivity.probe();
      } finally {
        rerouting.current = false;
      }
    }

    if (isDemoMode) void startDemo();
    else void startReal();

    return () => {
      cancelled = true;
      positionSub?.remove();
      motionSub?.remove();
      connectivity.stop();
      if (tickHandle) clearInterval(tickHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDemoMode, destinationLat, destinationLon]);

  // Voice guidance (packages/core VoiceGuidance): turn announcements with
  // exact / approximate / withheld distances according to position quality,
  // and one notice per GPS-lost / spoofed / restored episode.
  useEffect(() => {
    const cues = guidance.update(state);
    if (cues.length > 0) void voice.speak(cues.map((c) => c.text).join(" ")).catch(() => {});
  }, [state, guidance, voice]);

  // The marker glides over a GPS-recovery correction instead of jumping.
  const shownPosition = useMemo(() => {
    const p = state.position?.position;
    if (!p) return null;
    const shown = smoother.update(p, state.updatedAt, state.speedMps ?? 0);
    return { ...p, lat: shown.lat, lon: shown.lon };
  }, [state.position, state.updatedAt, state.speedMps, smoother]);

  if (permissionDenied) {
    return (
      <View style={styles.centerMessage}>
        <Text style={styles.errorText}>Доступ до геолокації не надано.</Text>
        <Text style={styles.errorSub}>NAVIA не може навігувати без GPS. Надайте дозвіл у налаштуваннях і поверніться сюди.</Text>
      </View>
    );
  }

  if (routeError) {
    return (
      <View style={styles.centerMessage}>
        <Text style={styles.errorText}>Не вдалося побудувати маршрут</Text>
        <Text style={styles.errorSub}>{routeError}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isDemoMode && (
        <View style={styles.demoBanner}>
          <Text style={styles.demoBannerText}>DEMO MODE — не реальний GPS</Text>
        </View>
      )}
      <MapLibreRouteView
        styleUrl={config.mapStyleUrl}
        routeGeometry={route?.geometry ?? []}
        currentPosition={shownPosition}
        headingDeg={state.headingDeg}
      />

      {state.nextStep && (
        <View style={styles.hudTop}>
          {state.positioning?.guidance === "none" ? (
            <Text style={styles.hudTopDistance}>Відстань зараз невідома — орієнтуйтеся на знаки</Text>
          ) : state.nextManeuverDistanceM != null ? (
            <Text style={styles.hudTopDistance}>
              {state.confidenceBand === "LOW" || state.confidenceBand === "UNKNOWN" ? "≈ " : ""}Через {Math.round(state.nextManeuverDistanceM / 10) * 10} м
              {state.positioning && state.positioning.maneuverUncertaintyM != null && state.positioning.maneuverUncertaintyM > 25
                ? ` (±${Math.round(state.positioning.maneuverUncertaintyM / 10) * 10} м)` : ""}
            </Text>
          ) : null}
          <Text style={styles.hudTopManeuver}>{maneuverPhrase(state.nextStep.maneuver)}</Text>
          {state.nextStep.roadName ? <Text style={styles.hudTopRoad}>{state.nextStep.roadName}</Text> : null}
        </View>
      )}

      <View style={styles.hudBottom}>
        <View style={styles.hudBottomRow}>
          <Text style={styles.hudBottomBig}>{(state.routeRemainingM / 1000).toFixed(1)} км</Text>
          <Text style={styles.hudBottomBig}>
            {state.speedMps && state.speedMps > 0.5 ? `ETA ${new Date(Date.now() + (state.routeRemainingM / state.speedMps) * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}` : "ETA —"}
          </Text>
        </View>
        <View style={styles.hudBottomRow}>
          <Text style={[styles.hudBottomStatus, state.gnss !== "NORMAL" && styles.hudBottomWarn]}>{gnssStatusText(state)}</Text>
          <Text style={styles.hudBottomStatus}>Позиція: {state.confidenceBand}</Text>
        </View>
        {state.offRoute && <Text style={styles.hudOffRoute}>Ви відхилилися від маршруту. Перераховую…</Text>}
        {!isDemoMode && !state.networkAvailable && (
          <Text style={styles.hudBottomWarnLine}>Немає інтернету: навігація триває за збереженим маршрутом; пошук місць і розумний штурман недоступні.</Text>
        )}
        {offlineNotice && <Text style={styles.hudBottomWarnLine}>{offlineNotice}</Text>}
        {!state.nextStep && <Text style={styles.hudBottomStatus}>Маршрут до: {destinationLabel}</Text>}
      </View>

      {/* The co-pilot reads the live engine/trip plan itself (activeCopilot);
          places come from OSM online in real mode, the labelled demo fixture in Demo Mode. */}
      <VoicePanel isDemoMode={isDemoMode} onRouteChanged={refresh} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220" },
  centerMessage: { flex: 1, backgroundColor: "#0b1220", alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: "#f87171", fontSize: 17, fontWeight: "600", marginBottom: 8, textAlign: "center" },
  errorSub: { color: "#8892a6", fontSize: 13, textAlign: "center" },
  demoBanner: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: "#7c3aed", paddingVertical: 6, zIndex: 10, alignItems: "center" },
  demoBannerText: { color: "#fff", fontWeight: "700", fontSize: 12, letterSpacing: 1 },
  hudTop: { position: "absolute", top: 48, left: 16, right: 16, backgroundColor: "rgba(11,18,32,0.9)", borderRadius: 14, padding: 16 },
  hudTopDistance: { color: "#8892a6", fontSize: 13 },
  hudTopManeuver: { color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 2 },
  hudTopRoad: { color: "#8892a6", fontSize: 14, marginTop: 4 },
  hudBottom: { position: "absolute", bottom: 24, left: 16, right: 16, backgroundColor: "rgba(11,18,32,0.9)", borderRadius: 14, padding: 16 },
  hudBottomRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  hudBottomBig: { color: "#fff", fontSize: 18, fontWeight: "700" },
  hudBottomStatus: { color: "#2dd4bf", fontSize: 13 },
  hudBottomWarn: { color: "#fbbf24" },
  hudBottomWarnLine: { color: "#fbbf24", fontSize: 12, marginTop: 6 },
  hudOffRoute: { color: "#f87171", fontSize: 13, marginTop: 8, fontWeight: "600" },
});
