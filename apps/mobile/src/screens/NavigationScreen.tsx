// Route overview → navigation → arrival. The screen only moves sensor samples
// into the engine, reads NavigationState back and renders it; route progress,
// off-route detection and GNSS health all live in @navia/core.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GNSSRawSample, IMUSample, RouteStep } from "@navia/core";
import type { RootStackParamList, RouteMode } from "../navigation/RootNavigator";
import { demoEngine, navigationEngine, useNaviaStore } from "../engine/naviaController";
import { ExpoLocationPositionProvider } from "../providers/ExpoLocationPositionProvider";
import { ExpoSensorsMotionProvider } from "../providers/ExpoSensorsMotionProvider";
import { useAppSettings } from "../settings/AppSettings";
import { NaviaMap, type CameraMode, type NaviaMapHandle } from "../map/NaviaMap";
import { useMapStyle } from "../map/mapStyles";
import { splitRoute } from "../map/routeSplit";
import { ManeuverIcon } from "../components/ManeuverIcon";
import { Icon } from "../components/Icon";
import { Button, IconButton, Segmented, StatusPill, Text, Touchable, useColors } from "../components/ui";
import { Appear, Crossfade } from "../components/Crossfade";
import { formatClock, formatDistance, formatDuration, useT, type Translate } from "../i18n";
import { GuidanceAnnouncer, instructionPhrase, type StepLike } from "../voice/guidance";
import { speak, stopSpeaking } from "../voice/VoiceGuide";
import { easing, elevation, iconSize, motion, radius, space, type ThemeColors } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Navigation">;
type Phase = "overview" | "navigating" | "arrived";

const TICK_MS = 1000;

export function NavigationScreen({ route: navRoute, navigation }: Props): JSX.Element {
  useKeepAwake();
  const { destinationLat, destinationLon, destinationLabel } = navRoute.params;
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { isDark, mapLayer, voiceGender } = useAppSettings();
  const style = useMapStyle(mapLayer, isDark);
  const state = useNaviaStore((s) => s.state);
  const route = useNaviaStore((s) => s.route);
  const isDemo = useNaviaStore((s) => s.isDemoMode);
  const refresh = useNaviaStore((s) => s.refresh);
  const setDemoMode = useNaviaStore((s) => s.setDemoMode);

  const [mode, setMode] = useState<RouteMode>(navRoute.params.mode ?? "car");
  const [phase, setPhase] = useState<Phase>("overview");
  const [cameraMode, setCameraMode] = useState<CameraMode>("free");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [retry, setRetry] = useState(0);
  const map = useRef<NaviaMapHandle>(null);
  const announcer = useRef(new GuidanceAnnouncer()).current;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const destination = useMemo(() => ({ lat: destinationLat, lon: destinationLon }), [destinationLat, destinationLon]);
  const transition = useRef(new Animated.Value(0)).current; // 0 = overview, 1 = navigating

  // ——— Engine wiring ———
  useEffect(() => {
    const demo = isDemo;
    let cancelled = false;
    let positionSub: { remove: () => void } | null = null;
    let motionSub: { remove: () => void } | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    let routeRequested = false;
    let rerouting = false;
    let lastRerouteAt = 0;
    setRouteError(null);
    if (demo) demoEngine.reset(); else navigationEngine.clearRoute();
    refresh();

    async function requestRoute(origin: { lat: number; lon: number }) {
      try {
        await navigationEngine.requestRoute(origin, destination, modeRef.current);
        if (!cancelled) { setRouteError(null); refresh(); }
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
      }
    }

    async function startReal() {
      const location = new ExpoLocationPositionProvider();
      const granted = await location.requestPermission().catch(() => false);
      if (cancelled) return;
      if (!granted) { setPermissionDenied(true); return; }
      motionSub = new ExpoSensorsMotionProvider().subscribe((sample: IMUSample) => navigationEngine.pushImuSample(sample));
      try {
        positionSub = await location.subscribe((sample: GNSSRawSample) => {
          if (cancelled) return;
          navigationEngine.pushGnssSample(sample, Date.now());
          navigationEngine.tick(Date.now());
          const s = navigationEngine.getState();
          const origin = s.gnss === "NORMAL" ? s.trustedPosition?.position : null;
          if (!routeRequested && origin) { routeRequested = true; void requestRoute(origin); }
        }, true);
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
        return;
      }
      if (cancelled) { positionSub.remove(); motionSub?.remove(); return; }
      tick = setInterval(() => {
        navigationEngine.tick(Date.now());
        refresh();
        const s = navigationEngine.getState();
        const here = s.gnss === "NORMAL" ? s.trustedPosition?.position : null;
        if (here && s.offRoute && !rerouting && Date.now() - lastRerouteAt > 30_000 && phaseRef.current === "navigating") {
          rerouting = true;
          lastRerouteAt = Date.now();
          navigationEngine.requestRoute(here, destination, modeRef.current)
            .then(() => { if (!cancelled) { setRouteError(null); refresh(); } })
            .catch((err: Error) => { if (!cancelled) setRouteError(err.message); })
            .finally(() => { rerouting = false; });
        }
      }, TICK_MS);
    }

    async function startDemo() {
      try {
        await demoEngine.start();
        if (cancelled) { demoEngine.reset(); return; }
        refresh();
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
        return;
      }
      tick = setInterval(() => {
        if (phaseRef.current === "navigating") demoEngine.tick(1);
        refresh();
      }, TICK_MS);
    }

    if (demo) void startDemo(); else void startReal();
    return () => {
      cancelled = true;
      positionSub?.remove();
      motionSub?.remove();
      if (tick) clearInterval(tick);
      stopSpeaking();
      if (demo) demoEngine.reset(); else { navigationEngine.clearRoute(); navigationEngine.tick(Date.now()); }
      refresh();
    };
    // Re-run when the travel mode or a retry changes the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, retry]);

  // ——— Derived state ———
  const position = state.position?.position ?? null;
  const user = useMemo(() => position ? { lat: position.lat, lon: position.lon, headingDeg: state.headingDeg, accuracyM: position.accuracyM ?? null } : null,
    [position?.lat, position?.lon, state.headingDeg, position?.accuracyM]); // eslint-disable-line react-hooks/exhaustive-deps
  const progressBucket = Math.round(state.routeProgressM / 5);
  const split = useMemo(() => route ? splitRoute(route.geometry, phase === "navigating" ? state.routeProgressM : 0) : { traveled: [], remaining: [] },
    [route, phase, progressBucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextStep = state.nextStep;
  const followingStep = useMemo(() => {
    if (!route || !nextStep) return null;
    const i = route.steps.findIndex((s) => s.id === nextStep.id);
    return i >= 0 ? route.steps[i + 1] ?? null : null;
  }, [route, nextStep]);
  const positionReliable = state.gnss !== "LOST" && state.confidenceBand !== "UNKNOWN";
  const arrived = phase === "navigating" && (state.mode === "ARRIVED" || (!!route && state.routeRemainingM < 30));

  // Fit the whole route once it arrives in overview.
  useEffect(() => {
    if (route && phase === "overview") {
      const pts = user ? [user, ...route.geometry] : route.geometry;
      const timer = setTimeout(() => map.current?.fitPoints(pts, 260 + insets.bottom), 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [route?.id, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (arrived) setPhase("arrived"); }, [arrived]);

  // ——— Voice guidance ———
  const speakText = useCallback((text: string) => { void speak(text, { lang, gender: voiceGender }); }, [lang, voiceGender]);
  useEffect(() => {
    if (phase !== "navigating" || !nextStep || !positionReliable) return;
    const text = announcer.next(nextStep as StepLike, state.nextStepDistanceM ?? null, mode, lang);
    if (text) speakText(text);
  }, [phase, nextStep?.id, state.nextStepDistanceM, positionReliable, mode, lang, speakText]); // eslint-disable-line react-hooks/exhaustive-deps
  const offRouteSpoken = useRef(false);
  useEffect(() => {
    if (phase !== "navigating") return;
    if (state.offRoute && !offRouteSpoken.current) { offRouteSpoken.current = true; speakText(lang === "uk" ? "Ви відхилилися від маршруту. Перераховую." : "You left the route. Recalculating."); }
    if (!state.offRoute) offRouteSpoken.current = false;
  }, [state.offRoute, phase, lang, speakText]);
  useEffect(() => { if (phase === "arrived") speakText(instructionPhrase({ id: "arrive", maneuver: "arrive", roadName: "" }, 0, lang)); }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ——— Actions ———
  function start() {
    announcer.reset();
    setPhase("navigating");
    setCameraMode("navigate");
    Animated.timing(transition, { toValue: 1, duration: motion.normal, easing: easing.standard, useNativeDriver: true }).start();
    if (nextStep) {
      const first = instructionPhrase(nextStep as StepLike, state.nextStepDistanceM ?? nextStep.distanceM, lang);
      speakText(first);
    }
  }

  function end() {
    stopSpeaking();
    setDemoMode(false);
    navigation.goBack();
  }

  const overviewOpacity = transition.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const overviewDrop = transition.interpolate({ inputRange: [0, 1], outputRange: [0, 24] });
  const overviewLift = transition.interpolate({ inputRange: [0, 1], outputRange: [0, -24] });

  const topInset = insets.top + space.xs + (isDemo ? space.lg : 0);
  const padding = useMemo(() => ({ top: topInset + 150, bottom: 150 + insets.bottom }), [topInset, insets.bottom]);

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      {style.status === "ready" && (
        <NaviaMap
          ref={map}
          mapStyle={style.style}
          user={user}
          quality={state.gnss === "NORMAL" ? "good" : state.gnss === "DEGRADED" ? "degraded" : "lost"}
          cameraMode={cameraMode}
          onUserGesture={() => setCameraMode("free")}
          routeGeometry={phase === "navigating" ? split.remaining : route?.geometry ?? []}
          traveledGeometry={phase === "navigating" ? split.traveled : []}
          destination={destination}
          padding={padding}
        />
      )}

      {isDemo && (
        <View style={[styles.demo, { paddingTop: insets.top, backgroundColor: c.brandOrange }]}>
          <Text variant="caption" color={{ custom: c.onAccent }}>{t("route.demoBanner")}</Text>
        </View>
      )}

      {phase === "overview" && (
        <>
          <Animated.View style={[styles.topBar, { top: topInset, opacity: overviewOpacity, transform: [{ translateY: overviewLift }] }]}>
            <IconButton icon="back" label={t("common.back")} onPress={() => navigation.goBack()} />
            <View style={[styles.destCard, { backgroundColor: c.surfaceElevated }, elevation(2, c)]}>
              <Icon name="pin" size={iconSize.md} color={c.critical} />
              <Text variant="bodyStrong" numberOfLines={1} style={styles.flex}>{destinationLabel}</Text>
            </View>
          </Animated.View>
          <Animated.View style={[styles.bottomPanel, { paddingBottom: insets.bottom + space.md, backgroundColor: c.surface, opacity: overviewOpacity, transform: [{ translateY: overviewDrop }] }, elevation(3, c)]}>
            {!isDemo && <Segmented<RouteMode> value={mode} onChange={setMode} options={[{ value: "car", label: t("route.car") }, { value: "walk", label: t("route.walk") }]} />}
            {permissionDenied ? (
              <StateBlock title={t("route.permissionDenied")} action={t("gps.openSettings")} onAction={() => void Linking.openSettings()} />
            ) : routeError ? (
              <StateBlock title={t("route.failed")} body={t("route.failedHint")} debug={__DEV__ ? routeError : undefined} action={t("common.retry")} onAction={() => setRetry((n) => n + 1)} />
            ) : route ? (
              <>
                <View style={styles.summaryRow}>
                  <Text variant="title" color="success">{formatDuration(route.durationS, lang)}</Text>
                  <Text variant="headline" color="secondary">{formatDistance(route.distanceM, lang)}</Text>
                  <Text variant="subhead" color="muted" style={styles.flexEnd}>{t("route.arrival")} {formatClock(Date.now() + route.durationS * 1000, lang)}</Text>
                </View>
                <Button label={t("route.start")} icon="locateFilled" onPress={start} />
              </>
            ) : (
              <View style={styles.loading}>
                <Text variant="headline">{t("route.preparing")}</Text>
                <Text variant="subhead" color="secondary">{state.gnss === "NORMAL" || isDemo ? destinationLabel : t("route.waitingGps")}</Text>
              </View>
            )}
          </Animated.View>
        </>
      )}

      {phase === "navigating" && (
        <>
          <Appear from={-24} style={[styles.maneuverWrap, { top: topInset }]}>
            <ManeuverCard step={nextStep} distanceM={state.nextStepDistanceM ?? null} following={followingStep} reliable={positionReliable} offRoute={state.offRoute} t={t} lang={lang} c={c} />
          </Appear>
          {cameraMode === "free" && (
            <View style={[styles.recenter, { bottom: insets.bottom + 120 }]}>
              <Button label={t("route.recenter")} icon="locateFilled" variant="secondary" onPress={() => setCameraMode("navigate")} />
            </View>
          )}
          <Appear from={24} style={[styles.tripBar, { paddingBottom: insets.bottom + space.sm, backgroundColor: c.surface }, elevation(3, c)]}>
            <View style={styles.flex}>
              <Text variant="numeric" color="success">{state.etaSeconds != null ? formatDuration(state.etaSeconds, lang) : "—"}</Text>
              <Text variant="subhead" color="secondary">
                {formatDistance(state.routeRemainingM, lang)} · {state.etaSeconds != null ? formatClock(Date.now() + state.etaSeconds * 1000, lang) : "—"}
              </Text>
            </View>
            <GpsPill gnss={state.gnss} t={t} />
            <Button label={t("route.end")} variant="critical" onPress={end} style={styles.endButton} />
          </Appear>
        </>
      )}

      {phase === "arrived" && (
        <Appear from={24} style={[styles.bottomPanel, { paddingBottom: insets.bottom + space.md, backgroundColor: c.surface }, elevation(3, c)]}>
          <View style={styles.arrivedHead}>
            <ManeuverIcon maneuver="arrive" size={48} color={c.success} faint={c.border} />
            <View style={styles.flex}>
              <Text variant="title">{t("route.arrived")}</Text>
              <Text variant="callout" color="secondary" numberOfLines={2}>{destinationLabel}</Text>
            </View>
          </View>
          <Button label={t("route.end")} onPress={end} />
        </Appear>
      )}
    </View>
  );
}

function ManeuverCard({ step, distanceM, following, reliable, offRoute, t, lang, c }: {
  step: RouteStep | null; distanceM: number | null; following: RouteStep | null; reliable: boolean; offRoute: boolean; t: Translate; lang: "uk" | "en"; c: ThemeColors;
}): JSX.Element | null {
  if (!step) return null;
  const maneuverLabel = step.maneuver === "roundabout" && step.roundaboutExit ? t("maneuver.roundaboutExit", { exit: step.roundaboutExit }) : t(`maneuver.${step.maneuver}` as Parameters<Translate>[0]);
  const fg = c.onManeuver;
  return (
    <View style={[styles.maneuverCard, { backgroundColor: c.maneuverCard }, elevation(3, c)]}>
      <Crossfade contentKey={`${step.id}-${offRoute}`}>
        <View style={styles.maneuverMain}>
          <ManeuverIcon maneuver={step.maneuver} exit={step.roundaboutExit} size={64} color={fg} faint={c.onManeuverFaint} />
          <View style={styles.flex}>
            {offRoute ? (
              <Text variant="maneuverStreet" color={{ custom: fg }}>{t("route.offRoute")}</Text>
            ) : <>
              <Text variant="maneuverDistance" color={{ custom: fg }}>{reliable && distanceM != null ? formatDistance(distanceM, lang) : maneuverLabel}</Text>
              <Text variant="maneuverStreet" color={{ custom: c.onManeuverSecondary }} numberOfLines={2}>{step.roadName || maneuverLabel}</Text>
              {!reliable && <Text variant="subhead" color={{ custom: c.onManeuverSecondary }}>{t("gps.explainLost")}</Text>}
            </>}
          </View>
        </View>
      </Crossfade>
      {following && !offRoute && (
        <View style={[styles.thenRow, { backgroundColor: c.maneuverCardDeep }]}>
          <ManeuverIcon maneuver={following.maneuver} exit={following.roundaboutExit} size={24} color={fg} faint={c.onManeuverFaint} />
          <Text variant="subhead" color={{ custom: fg }} numberOfLines={1}>{t("route.then", { maneuver: t(`maneuver.${following.maneuver}` as Parameters<Translate>[0]) })}</Text>
        </View>
      )}
    </View>
  );
}

function GpsPill({ gnss, t }: { gnss: string; t: Translate }): JSX.Element {
  return gnss === "NORMAL" ? <StatusPill tone="success" icon="satellite" label="GPS" />
    : gnss === "DEGRADED" ? <StatusPill tone="warning" icon="satellite" label={t("gps.unstable")} />
      : <StatusPill tone="critical" icon="satellite" label={t("gps.lost")} />;
}

function StateBlock({ title, body, debug, action, onAction }: { title: string; body?: string; debug?: string; action: string; onAction: () => void }): JSX.Element {
  return (
    <View style={styles.loading}>
      <Text variant="headline" color="critical">{title}</Text>
      {body ? <Text variant="callout" color="secondary">{body}</Text> : null}
      {debug ? <Text variant="caption" color="muted" numberOfLines={3}>{debug}</Text> : null}
      <Touchable accessibilityRole="button" onPress={onAction}><Text variant="bodyStrong" color="accent">{action}</Text></Touchable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  flexEnd: { marginLeft: "auto" },
  demo: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingBottom: space.xxs },
  topBar: { position: "absolute", left: space.md, right: space.md, flexDirection: "row", gap: space.xs, alignItems: "center" },
  destCard: { flex: 1, minHeight: 44, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.md, gap: space.md },
  summaryRow: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  loading: { gap: space.xs, paddingVertical: space.xs },
  maneuverWrap: { position: "absolute", left: space.sm, right: space.sm },
  maneuverCard: { borderRadius: radius.xl, overflow: "hidden" },
  maneuverMain: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  thenRow: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xs },
  recenter: { position: "absolute", alignSelf: "center" },
  tripBar: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.md, paddingTop: space.md, flexDirection: "row", alignItems: "center", gap: space.sm },
  endButton: { minHeight: 44, paddingHorizontal: space.md },
  arrivedHead: { flexDirection: "row", alignItems: "center", gap: space.md },
});
