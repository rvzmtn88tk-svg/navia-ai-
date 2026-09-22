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
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { DEMO_POIS, type GNSSRawSample, type IMUSample } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { navigationEngine, demoEngine, useNaviaStore } from "../engine/naviaController";
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

function gnssStatusText(gnss: string): string {
  if (gnss === "NORMAL") return "GNSS: норма";
  if (gnss === "DEGRADED") return "GNSS нестабільний";
  return "GNSS втрачено — оцінюю положення";
}

export function NavigationScreen({ route: navRoute }: Props): JSX.Element {
  const { destinationLat, destinationLon, destinationLabel } = navRoute.params;
  const { state, route, isDemoMode, refresh } = useNaviaStore();
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const voice = useRef(new ExpoSpeechVoiceProvider()).current;
  const lastAnnouncedStepId = useRef<string | null>(null);
  const rerouting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let positionSub: { remove: () => void } | null = null;
    let motionSub: { remove: () => void } | null = null;
    let tickHandle: ReturnType<typeof setInterval> | null = null;

    const destination = { lat: destinationLat, lon: destinationLon };

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
            await navigationEngine.requestRoute({ lat: sample.lat, lon: sample.lon }, destination);
            refresh();
          } catch (err) {
            if (!cancelled) setRouteError((err as Error).message);
          }
        }
      });

      tickHandle = setInterval(() => {
        navigationEngine.tick(Date.now());
        refresh();
        maybeReroute({ lat: navigationEngine.getState().position?.position.lat ?? destinationLat, lon: navigationEngine.getState().position?.position.lon ?? destinationLon }, destination);
      }, TICK_INTERVAL_MS);
    }

    async function startDemo() {
      try {
        await demoEngine.start();
        refresh();
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
        return;
      }
      tickHandle = setInterval(() => {
        demoEngine.tick(DEMO_TICK_SECONDS);
        refresh();
      }, TICK_INTERVAL_MS);
    }

    async function maybeReroute(current: { lat: number; lon: number }, dest: { lat: number; lon: number }) {
      if (rerouting.current) return;
      if (!navigationEngine.getState().offRoute) return;
      rerouting.current = true;
      try {
        await navigationEngine.requestRoute(current, dest);
        refresh();
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
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
      if (tickHandle) clearInterval(tickHandle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDemoMode, destinationLat, destinationLon]);

  // Speak the next maneuver once, the first time it becomes the current one.
  useEffect(() => {
    const step = state.nextStep;
    if (step && step.id !== lastAnnouncedStepId.current) {
      lastAnnouncedStepId.current = step.id;
      const text = `Через ${Math.round(step.distanceM)} метрів, ${maneuverPhrase(step.maneuver)}${step.roadName ? `, на ${step.roadName}` : ""}.`;
      void voice.speak(text).catch(() => {});
    }
  }, [state.nextStep, voice]);

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
        currentPosition={state.position?.position ?? null}
        headingDeg={state.headingDeg}
      />

      {state.nextStep && (
        <View style={styles.hudTop}>
          <Text style={styles.hudTopDistance}>Через {Math.round(state.nextStep.distanceM)} м</Text>
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
          <Text style={[styles.hudBottomStatus, state.gnss !== "NORMAL" && styles.hudBottomWarn]}>{gnssStatusText(state.gnss)}</Text>
          <Text style={styles.hudBottomStatus}>Позиція: {state.confidenceBand}</Text>
        </View>
        {state.offRoute && <Text style={styles.hudOffRoute}>Ви відхилилися від маршруту. Перераховую…</Text>}
        {!state.nextStep && <Text style={styles.hudBottomStatus}>Маршрут до: {destinationLabel}</Text>}
      </View>

      <VoicePanel
        isDemoMode={isDemoMode}
        context={{
          state,
          route,
          nearbyLandmarks: state.nearbyLandmarks,
          // No real POI database is wired into this pass (see LIMITATIONS.md,
          // scripts/data's POI index isn't built/imported); Demo Mode uses
          // the shipped demo fixture so landmark-query voice intents have
          // something real to answer against, real mode honestly has none yet.
          nearbyPOI: isDemoMode ? DEMO_POIS : [],
          recentEvents: [...(isDemoMode ? demoEngine : navigationEngine).getTelemetry().getEvents()],
        }}
      />
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
  hudOffRoute: { color: "#f87171", fontSize: 13, marginTop: 8, fontWeight: "600" },
});
