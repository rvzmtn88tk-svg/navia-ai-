// Route overview → navigation → arrival. The screen only moves sensor samples
// into the engine, reads NavigationState back and renders it; route progress,
// off-route detection and GNSS health all live in @navia/core.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { haversineMeters, initialBearing, positionAtDistance, type GNSSRawSample, type IMUSample, type RouteStep } from "@navia/core";
import type { RootStackParamList, RouteMode } from "../navigation/RootNavigator";
import { demoEngine, navigationEngine, useNaviaStore } from "../engine/naviaController";
import { ExpoLocationPositionProvider, probePosition } from "../providers/ExpoLocationPositionProvider";
import { ExpoSensorsMotionProvider } from "../providers/ExpoSensorsMotionProvider";
import { useAppSettings } from "../settings/AppSettings";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { StatusBeacons } from "../components/StatusBeacons";
import { StatusDetails, type StatusKind } from "../components/StatusDetails";
import { healthFrom, type GpsStatus } from "../engine/liveStatus";
import { useRouteIntel } from "../store/routeIntelStore";
import { useTripStore } from "../store/tripStore";
import { gnssTrendReasons } from "../engine/gnssWords";
import { landmarkCue } from "../navigation/landmarks";
import { NaviaMap, type CameraMode, type NaviaMapHandle } from "../map/NaviaMap";
import { useMapStyle } from "../map/mapStyles";
import { splitRoute } from "../map/routeSplit";
import { ManeuverIcon } from "../components/ManeuverIcon";
import { Icon } from "../components/Icon";
import { Button, IconButton, Segmented, Text, Touchable, useColors } from "../components/ui";
import { Appear, Crossfade } from "../components/Crossfade";
import { formatClock, formatDistance, formatDuration, useT, type Translate } from "../i18n";
import { GuidanceAnnouncer, alertPhrase, cautiousPhrase, instructionPhrase, resiliencePhrase, type StepLike } from "../voice/guidance";
import { saveRouteOffline, type OfflineProgress } from "../map/offlineRoute";
import { config } from "../config";
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
  const { isDark, mapLayer, voiceGender, briefingEnabled, nav3d, setNav3d } = useAppSettings();
  // 3D: tilted camera, buildings stand up (fill-extrusion). 2D: flat, clean.
  // Relief shading is NOT added on top in 3D: measured on the simulator it
  // halves the frame rate (2D 45 fps, 3D 31 fps, 3D + hillshade 15 fps);
  // the "Рельєф" layer (shading baked into the tiles) gives relief for free.
  const style = useMapStyle(mapLayer, isDark, 0, !nav3d, false);
  const fps = useFrameCounter(__DEV__);
  const { height: screenH } = useWindowDimensions();
  const state = useNaviaStore((s) => s.state);
  const route = useNaviaStore((s) => s.route);
  const isDemo = useNaviaStore((s) => s.isDemoMode);
  const refresh = useNaviaStore((s) => s.refresh);
  const setDemoMode = useNaviaStore((s) => s.setDemoMode);

  const [mode, setMode] = useState<RouteMode>(navRoute.params.mode ?? "car");
  const [phase, setPhase] = useState<Phase>("overview");
  const [cameraMode, setCameraMode] = useState<CameraMode>("free");

  // Share the trip with the co-pilot.
  useEffect(() => {
    useTripStore.getState().set({ destination: destinationLabel, mode });
  }, [destinationLabel, mode]);
  useEffect(() => () => useTripStore.getState().clear(), []);

  // A new destination (e.g. "walk to the shelter" from the co-pilot during a
  // trip) goes back to the route overview for the new target.
  const firstDestination = useRef(true);
  useEffect(() => {
    if (firstDestination.current) { firstDestination.current = false; return; }
    setPhase("overview");
    setCameraMode("free");
    setMode(navRoute.params.mode ?? "car");
    transition.setValue(0);
  }, [destinationLat, destinationLon]); // eslint-disable-line react-hooks/exhaustive-deps
  const [routeError, setRouteError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [retry, setRetry] = useState(0);
  const [noFix, setNoFix] = useState(false);
  const [picking, setPicking] = useState(false);
  const [offline, setOffline] = useState<OfflineProgress>({ state: "idle", percent: 0 });
  const startFromRef = useRef<((p: { lat: number; lon: number }) => void) | null>(null);
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
    setNoFix(false);
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

    let lastSampleAt = 0;
    let probing = false;
    let lastProbeAt = 0;
    function onSample(sample: GNSSRawSample) {
      if (cancelled) return;
      lastSampleAt = Date.now();
      navigationEngine.pushGnssSample(sample, Date.now());
      navigationEngine.tick(Date.now());
      const s = navigationEngine.getState();
      const origin = s.gnss === "NORMAL" ? s.trustedPosition?.position : null;
      if (!routeRequested && origin) { routeRequested = true; void requestRoute(origin); }
    }

    async function startReal() {
      const location = new ExpoLocationPositionProvider();
      const granted = await location.requestPermission().catch(() => false);
      if (cancelled) return;
      if (!granted) { setPermissionDenied(true); return; }
      motionSub = new ExpoSensorsMotionProvider().subscribe((sample: IMUSample) => navigationEngine.pushImuSample(sample));
      try {
        positionSub = await location.subscribe(onSample, true);
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
        return;
      }
      if (cancelled) { positionSub.remove(); motionSub?.remove(); return; }
      // No trusted fix soon → offer to start from the last stable position or a point the user sets.
      const noFixTimer = setTimeout(() => { if (!cancelled && !routeRequested) setNoFix(true); }, 8_000);
      startFromRef.current = (p) => {
        if (routeRequested) return;
        routeRequested = true;
        clearTimeout(noFixTimer);
        setNoFix(false);
        navigationEngine.setManualPosition(p);
        void requestRoute(p);
      };
      tick = setInterval(() => {
        // iOS may go quiet while the phone stands still (red light, jam):
        // ask for a fresh fix instead of assuming the signal is gone.
        if (lastSampleAt > 0 && Date.now() - lastSampleAt > 4_000 && !probing && Date.now() - lastProbeAt > 5_000) {
          probing = true;
          lastProbeAt = Date.now();
          void probePosition().then((sample) => { if (sample) onSample(sample); }).finally(() => { probing = false; });
        }
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
  }, [mode, retry, destinationLat, destinationLon]);

  // ——— Derived state ———
  const position = state.position?.position ?? null;
  // While on the route, draw the puck on the line and point the camera along
  // the road ahead (not the compass), like a car navigator.
  const progressM = Math.round(state.routeProgressM);
  const snap = useMemo(() => {
    if (phase !== "navigating" || !route || state.offRoute || route.geometry.length < 2) return null;
    const here = positionAtDistance(route.geometry, progressM);
    const ahead = positionAtDistance(route.geometry, progressM + 30);
    return { here, bearing: haversineMeters(here, ahead) > 2 ? initialBearing(here, ahead) : null };
  }, [phase, route, state.offRoute, progressM]);
  const user = useMemo(() => {
    if (!position) return null;
    const at = snap?.here ?? position;
    return { lat: at.lat, lon: at.lon, headingDeg: snap?.bearing ?? state.headingDeg, accuracyM: position.accuracyM ?? null };
  }, [position?.lat, position?.lon, snap, state.headingDeg, position?.accuracyM]); // eslint-disable-line react-hooks/exhaustive-deps
  const progressBucket = Math.round(state.routeProgressM / 5);
  const split = useMemo(() => route ? splitRoute(route.geometry, phase === "navigating" ? state.routeProgressM : 0) : { traveled: [], remaining: [] },
    [route, phase, progressBucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextStep = state.nextStep;
  const followingStep = useMemo(() => {
    if (!route || !nextStep) return null;
    const i = route.steps.findIndex((s) => s.id === nextStep.id);
    return i >= 0 ? route.steps[i + 1] ?? null : null;
  }, [route, nextStep]);
  const estimated = state.positionMode === "DEAD_RECKONING" || state.positionMode === "MANUAL";
  const uncertaintyM = state.positionUncertaintyM ?? null;
  const positionReliable = !estimated && state.gnss !== "LOST" && state.confidenceBand !== "UNKNOWN";
  // Without GNSS the app never declares arrival by itself; the driver confirms.
  const arrived = phase === "navigating" && (state.mode === "ARRIVED" || (!!route && state.routeRemainingM < 30 && state.positionMode === "GNSS"));
  const lastFix = !isDemo ? navigationEngine.getLastTrustedFix() : null;
  const lastFixAgeMin = lastFix ? Math.round((Date.now() - lastFix.timestamp) / 60_000) : null;

  // Fit the whole route once it arrives in overview, above the (measured) panel.
  const [panelH, setPanelH] = useState(300);
  useEffect(() => {
    if (route && phase === "overview") {
      const pts = user ? [user, ...route.geometry] : route.geometry;
      const timer = setTimeout(() => map.current?.fitPoints(pts, panelH + 16), 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [route?.id, phase, Math.round(panelH / 40)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (arrived) setPhase("arrived"); }, [arrived]);

  // Learn the landmarks of this route while there is network, for guidance
  // later without GPS ("after the OKKO fuel station turn right").
  const intel = useRouteIntel();
  useEffect(() => { if (route && !isDemo) void useRouteIntel.getState().prepare(route); }, [route?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useRouteIntel.getState().clear(), []);
  const nextCue = nextStep ? intel.byStep[nextStep.id] ?? null : null;

  // ——— Voice guidance ———
  const speakText = useCallback((text: string) => { void speak(text, { lang, gender: voiceGender }); }, [lang, voiceGender]);
  useEffect(() => {
    if (phase !== "navigating" || !nextStep) return;
    if (positionReliable) {
      const text = announcer.next(nextStep as StepLike, state.nextStepDistanceM ?? null, mode, lang, nextCue);
      if (text) speakText(text);
      return;
    }
    // Estimated position: one cautious prompt per maneuver once it could be close.
    const reach = (state.nextStepDistanceM ?? Infinity) - (uncertaintyM ?? 0);
    if (estimated && reach <= (mode === "walk" ? 60 : 400) && cautiousSpoken.current !== nextStep.id) {
      cautiousSpoken.current = nextStep.id;
      speakText(cautiousPhrase(nextStep as StepLike, lang, nextCue));
    }
  }, [phase, nextStep?.id, state.nextStepDistanceM, positionReliable, estimated, uncertaintyM, mode, lang, speakText, nextCue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Spoken resilience transitions: degrading → lost (route guidance) → recovered.
  const cautiousSpoken = useRef<string | null>(null);
  const resilience = useRef<"ok" | "degraded" | "lost">("ok");
  useEffect(() => {
    if (phase !== "navigating" || isDemo) return;
    const now = estimated ? "lost" : state.gnss === "DEGRADED" ? "degraded" : "ok";
    const prev = resilience.current;
    if (now === prev) return;
    resilience.current = now;
    if (now === "lost") speakText(resiliencePhrase("lost", lang));
    else if (now === "degraded" && prev === "ok") speakText(resiliencePhrase("degraded", lang));
    else if (now === "ok" && prev === "lost") speakText(resiliencePhrase("recovered", lang));
  }, [phase, estimated, state.gnss, isDemo, lang, speakText]);
  // Proactive: announce an air alert starting or ending during the trip.
  const alertNow = useNaviaStore((s) => s.alert);
  // Map beacons: same colours as the home map (shared StatusBeacons). Before
  // the first fix GPS reads "searching" (neutral), not "lost".
  const navGpsStatus: GpsStatus = permissionDenied ? "permission" : isDemo || state.position || state.lastTrustedFixAt != null ? "ready" : "searching";
  const [details, setDetails] = useState<StatusKind | null>(null);
  const alertSpoken = useRef<boolean | null>(null);
  useEffect(() => {
    if (phase !== "navigating" || isDemo || alertNow?.active == null) return;
    if (alertSpoken.current === null) { alertSpoken.current = alertNow.active; if (!alertNow.active) return; }
    else if (alertSpoken.current === alertNow.active) return;
    alertSpoken.current = alertNow.active;
    speakText(alertPhrase(alertNow.active, alertNow.scope, lang));
  }, [phase, isDemo, alertNow?.active, alertNow?.scope, lang, speakText]); // eslint-disable-line react-hooks/exhaustive-deps
  const conflictSpoken = useRef<number | null>(null);
  useEffect(() => {
    const since = state.gnssConflict?.sinceMs ?? null;
    if (phase !== "navigating" || since == null || conflictSpoken.current === since) return;
    conflictSpoken.current = since;
    speakText(t("resilient.conflictSpoken"));
  }, [phase, state.gnssConflict?.sinceMs, speakText, t]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // Keep the map of this route on the phone in case the network drops.
    if (route && !isDemo) void saveRouteOffline(route.geometry, config.mapStyleUrl, setOffline);
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
  // During navigation the puck sits low on screen so most of the view shows the road ahead.
  const padding = useMemo(() => phase === "navigating"
    ? { top: Math.round(screenH * 0.45), bottom: 110 + insets.bottom }
    : { top: topInset + 150, bottom: 150 + insets.bottom }, [phase, screenH, topInset, insets.bottom]);

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
          speedMps={state.speedMps}
          view3d={nav3d}
          {...(__DEV__ ? { onFrame: fps.onFrame } : {})}
        />
      )}

      {picking && (
        <View pointerEvents="none" style={styles.crosshair}>
          <Icon name="pin" size={44} color={c.accent} strokeWidth={2.4} />
        </View>
      )}

      {isDemo && (
        <View style={[styles.demo, { paddingTop: insets.top, backgroundColor: c.brandOrange }]}>
          <Text variant="caption" color={{ custom: c.onAccent }}>{t("route.demoBanner")}</Text>
          {__DEV__ && phase === "navigating" && (
            // Dev-only scenario controls (not in release builds).
            <View style={styles.demoDev}>
              <Text variant="caption" color={{ custom: c.onAccent }} onPress={() => demoEngine.simulateGradualGnssLoss()}>РЕБ ▸</Text>
              <Text variant="caption" color={{ custom: c.onAccent }} onPress={() => demoEngine.restoreGnss()}>GPS ✓</Text>
            </View>
          )}
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
          <Animated.View onLayout={(e) => setPanelH(e.nativeEvent.layout.height)} style={[styles.bottomPanel, { paddingBottom: insets.bottom + space.md, backgroundColor: c.surface, opacity: overviewOpacity, transform: [{ translateY: overviewDrop }] }, elevation(3, c)]}>
            {!isDemo && <Segmented<RouteMode> value={mode} onChange={setMode} options={[{ value: "car", label: t("route.car") }, { value: "walk", label: t("route.walk") }]} />}
            {permissionDenied ? (
              <StateBlock title={t("route.permissionDenied")} action={t("gps.openSettings")} onAction={() => void Linking.openSettings()} />
            ) : routeError ? (
              <StateBlock title={t("route.failed")} body={t("route.failedHint")} debug={__DEV__ ? routeError : undefined} action={t("common.retry")} onAction={() => setRetry((n) => n + 1)} />
            ) : route ? (
              <>
                {briefingEnabled && !isDemo && <Briefing distanceM={route.distanceM} gnss={state.gnss} t={t} lang={lang} c={c} />}
                <View style={styles.summaryRow}>
                  <Text variant="title" color="success">{formatDuration(route.durationS, lang)}</Text>
                  <Text variant="headline" color="secondary">{formatDistance(route.distanceM, lang)}</Text>
                  <Text variant="subhead" color="muted" style={styles.flexEnd}>{t("route.arrival")} {formatClock(Date.now() + route.durationS * 1000, lang)}</Text>
                </View>
                <Button label={t("route.start")} icon="locateFilled" onPress={start} />
              </>
            ) : noFix && !picking ? (
              <View style={styles.loading}>
                <Text variant="headline" color="warning">{t("resilient.noFixTitle")}</Text>
                <Text variant="callout" color="secondary">{t("resilient.noFixBody")}</Text>
                {lastFix && lastFixAgeMin != null && lastFixAgeMin <= 10 && (
                  <Button label={t("resilient.fromLastFix", { minutes: Math.max(1, lastFixAgeMin) })} icon="clock" onPress={() => startFromRef.current?.(lastFix.position)} />
                )}
                <Button label={t("resilient.pickOnMap")} icon="pin" variant="secondary" onPress={() => setPicking(true)} />
              </View>
            ) : picking ? (
              <View style={styles.loading}>
                <Text variant="callout" color="secondary">{t("resilient.pickHint")}</Text>
                <Button label={t("resilient.pickConfirm")} icon="locateFilled" onPress={() => {
                  void map.current?.getCenter().then((p) => { if (p) { setPicking(false); startFromRef.current?.(p); } });
                }} />
              </View>
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
            <ManeuverCard step={nextStep} cue={nextCue ? landmarkCue(nextCue, lang) : null} distanceM={state.nextStepDistanceM ?? null} following={followingStep} reliable={positionReliable} estimated={estimated} uncertaintyM={uncertaintyM} offRoute={state.offRoute} t={t} lang={lang} c={c} />
            {!estimated && state.gnssTrend?.level === "degrading" && (
              <Appear from={-8} style={[styles.resilientBanner, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
                <Icon name="satellite" size={iconSize.md} color={c.warning} />
                <View style={styles.flex}>
                  <Text variant="subhead" color="warning">{t("gps.warnDegrading")}</Text>
                  <Text variant="caption" color="secondary">{[gnssTrendReasons(state.gnssTrend, t), t("gps.warnDegradingHint")].filter(Boolean).join(" · ")}</Text>
                </View>
              </Appear>
            )}
            {estimated && (
              <Appear from={-8} style={[styles.resilientBanner, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
                <Icon name="satellite" size={iconSize.md} color={c.warning} />
                <View style={styles.flex}>
                  <Text variant="subhead" color="warning">{state.positionMode === "MANUAL" ? t("resilient.bannerManual") : t("resilient.banner")}</Text>
                  {uncertaintyM != null && <Text variant="caption" color="secondary">{t("resilient.uncertainty", { meters: uncertaintyM })}</Text>}
                </View>
              </Appear>
            )}
            {state.gnssConflict && (
              <Appear from={-8} style={[styles.resilientBanner, styles.conflict, { backgroundColor: c.criticalSoft, borderColor: c.critical }]}>
                <Text variant="subhead" color="critical">{t("resilient.conflict", { distance: formatDistance(state.gnssConflict.distanceM, lang) })}</Text>
                <View style={styles.conflictRow}>
                  <Button label={t("resilient.conflictYes")} icon="check" style={styles.flex} onPress={() => { navigationEngine.acceptGnssConflict(); refresh(); }} />
                  <Button label={t("resilient.conflictNo")} variant="secondary" style={styles.flex} onPress={() => { navigationEngine.rejectGnssConflict(); refresh(); }} />
                </View>
              </Appear>
            )}
            {estimated && nextStep && (state.nextStepDistanceM ?? Infinity) <= Math.max(150, (uncertaintyM ?? 0) * 1.5) && (
              <Button style={styles.confirmButton} icon="check" variant="secondary"
                label={nextStep.maneuver === "arrive" ? t("resilient.confirmArrive") : t("resilient.confirmTurn")}
                onPress={() => {
                  if (nextStep.maneuver === "arrive") { setPhase("arrived"); return; }
                  navigationEngine.confirmManeuverReached();
                  refresh();
                }} />
            )}
          </Appear>
          <SpeedBadge speedMps={state.gnss === "NORMAL" ? state.speedMps : null} bottom={insets.bottom + 104} t={t} c={c} />
          {/* HUD: co-pilot and the two status beacons (GPS, air alert) */}
          <View style={[styles.hudRight, { bottom: insets.bottom + 104 }]} pointerEvents="box-none">
            <Touchable accessibilityRole="button" accessibilityLabel={nav3d ? t("nav.to2d") : t("nav.to3d")} onPress={() => setNav3d(!nav3d)}
              style={[styles.hudToggle, { backgroundColor: c.maneuverCard, borderColor: nav3d ? c.brandTeal : c.border }]}>
              <Text variant="headline" color={{ custom: nav3d ? c.brandTeal : c.onManeuver }}>{nav3d ? "3D" : "2D"}</Text>
            </Touchable>
            {__DEV__ && <Text variant="caption" color={{ custom: c.onManeuverSecondary }}>{fps.value} fps</Text>}
            <Touchable accessibilityRole="button" accessibilityLabel={t("copilot.title")} onPress={() => navigation.navigate("Assistant", { voice: true })}
              style={[styles.hudCopilot, { backgroundColor: c.maneuverCard, borderColor: c.brandTeal }, elevation(3, c)]}>
              <NaviaAiMark size={38} />
            </Touchable>
            <StatusBeacons size={44} gpsStatus={navGpsStatus} health={healthFrom(state.gnss)} alert={alertNow}
              onPressGps={() => setDetails((k) => (k === "gps" ? null : "gps"))}
              onPressAlert={() => setDetails((k) => (k === "alert" ? null : "alert"))} />
          </View>
          {details && (
            <Appear from={12} style={[styles.hudDetails, { bottom: insets.bottom + 104 + 84 }]}>
              <StatusDetails kind={details} gpsStatus={navGpsStatus} onClose={() => setDetails(null)} style={styles.fill} />
            </Appear>
          )}
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
              {offline.state === "saving" && <Text variant="caption" color="muted">{t("offline.saving", { percent: offline.percent })}</Text>}
              {offline.state === "saved" && <Text variant="caption" color="success">{t("offline.saved")}</Text>}
            </View>
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

function ManeuverCard({ step, cue, distanceM, following, reliable, estimated, uncertaintyM, offRoute, t, lang, c }: {
  step: RouteStep | null; cue: string | null; distanceM: number | null; following: RouteStep | null; reliable: boolean; estimated: boolean; uncertaintyM: number | null; offRoute: boolean; t: Translate; lang: "uk" | "en"; c: ThemeColors;
}): JSX.Element | null {
  if (!step) return null;
  const maneuverLabel = step.maneuver === "roundabout" && step.roundaboutExit ? t("maneuver.roundaboutExit", { exit: step.roundaboutExit }) : t(`maneuver.${step.maneuver}` as Parameters<Translate>[0]);
  const fg = c.onManeuver;
  return (
    <View style={[styles.maneuverCard, { backgroundColor: c.maneuverCard, borderColor: c.brandTeal, shadowColor: c.brandTeal }]}>
      <Crossfade contentKey={`${step.id}-${offRoute}`}>
        <View style={styles.maneuverMain}>
          <ManeuverIcon maneuver={step.maneuver} exit={step.roundaboutExit} size={64} color={fg} faint={c.onManeuverFaint} />
          <View style={styles.flex}>
            {offRoute ? (
              <Text variant="maneuverStreet" color={{ custom: fg }}>{t("route.offRoute")}</Text>
            ) : <>
              <Text variant="maneuverDistance" color={{ custom: fg }}>
                {distanceM == null ? maneuverLabel
                  : reliable ? formatDistance(distanceM, lang)
                    : estimated && uncertaintyM != null && uncertaintyM < distanceM * 0.5 ? `≈ ${formatDistance(distanceM, lang)}`
                      : estimated ? t("resilient.soon") : maneuverLabel}
              </Text>
              <Text variant="maneuverStreet" color={{ custom: c.onManeuverSecondary }} numberOfLines={2}>{step.roadName ? `${capitalize(maneuverLabel)} · ${step.roadName}` : capitalize(maneuverLabel)}</Text>
              {cue && (
                <View style={styles.cueRow}>
                  <Icon name="pin" size={iconSize.sm} color={c.brandOrange} />
                  <Text variant="subhead" color={{ custom: c.brandOrange }} numberOfLines={2} style={styles.flex}>{capitalize(cue)}</Text>
                </View>
              )}
              {!reliable && !estimated && <Text variant="subhead" color={{ custom: c.onManeuverSecondary }}>{t("gps.explainLost")}</Text>}
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

// Pre-trip briefing from live state only (alert, GPS, offline map, length).
function Briefing({ distanceM, gnss, t, lang, c }: { distanceM: number; gnss: string; t: Translate; lang: "uk" | "en"; c: ThemeColors }): JSX.Element {
  const alert = useNaviaStore((s) => s.alert);
  const lines: { tone: "critical" | "warning" | "success" | "neutral"; text: string }[] = [];
  if (alert?.active) {
    const where = t(alert.scope === "region" ? "alert.activeIn.region" : alert.scope === "city" ? "alert.activeIn.city" : "alert.activeIn.district").replace(/^Тривога |^Alert /, "");
    lines.push({ tone: "critical", text: t("briefing.alertActive", { where }) });
  } else if (alert?.active === false) {
    lines.push(alert.otherDistrictsActive ? { tone: "warning", text: t("briefing.alertOther", { count: alert.otherDistrictsActive }) } : { tone: "success", text: t("briefing.alertClear") });
  }
  lines.push(gnss === "NORMAL" ? { tone: "success", text: t("briefing.gpsStable") } : { tone: "warning", text: t("briefing.gpsWeak") });
  lines.push({ tone: "neutral", text: t("briefing.offline") });
  const intel = useRouteIntel();
  if (intel.state === "loading") lines.push({ tone: "neutral", text: t("briefing.landmarksLoading") });
  else if (intel.state === "ready" && intel.along.length > 0) lines.push({ tone: "neutral", text: t("briefing.landmarks", { count: intel.along.length, turns: Object.keys(intel.byStep).length }) });
  if (distanceM > 50_000) lines.push({ tone: "neutral", text: t("briefing.long", { distance: formatDistance(distanceM, lang) }) });
  const dot = (tone: string) => tone === "critical" ? c.critical : tone === "warning" ? c.warning : tone === "success" ? c.success : c.brandTeal;
  return (
    <View style={[styles.briefing, { backgroundColor: c.surfaceMuted }]}>
      <View style={styles.briefingHead}><NaviaAiMark size={28} /><Text variant="subhead" color="secondary">{t("briefing.title")}</Text></View>
      {lines.map((l) => (
        <View key={l.text} style={styles.briefingRow}>
          <View style={[styles.briefingDot, { backgroundColor: dot(l.tone) }]} />
          <Text variant="callout" style={styles.flex}>{l.text}</Text>
        </View>
      ))}
    </View>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function SpeedBadge({ speedMps, bottom, t, c }: { speedMps: number | null; bottom: number; t: Translate; c: ThemeColors }): JSX.Element {
  const kmh = speedMps != null && speedMps >= 0 ? Math.round(speedMps * 3.6) : null;
  return (
    <View accessibilityLabel={kmh != null ? `${kmh} ${t("nav.speedUnit")}` : t("nav.speedUnit")}
      style={[styles.speed, { bottom, backgroundColor: c.maneuverCard, borderColor: c.brandTeal, shadowColor: c.brandTeal }]}>
      <Text variant="numeric" color={{ custom: c.onManeuver }} style={styles.speedValue}>{kmh ?? "—"}</Text>
      <Text variant="caption" color={{ custom: c.onManeuverSecondary }}>{t("nav.speedUnit")}</Text>
    </View>
  );
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
  demoDev: { position: "absolute", right: space.md, bottom: space.xxs, flexDirection: "row", gap: space.md },
  demo: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingBottom: space.xxs },
  topBar: { position: "absolute", left: space.md, right: space.md, flexDirection: "row", gap: space.xs, alignItems: "center" },
  destCard: { flex: 1, minHeight: 44, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.md, gap: space.md },
  summaryRow: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  loading: { gap: space.xs, paddingVertical: space.xs },
  maneuverWrap: { position: "absolute", left: space.sm, right: space.sm },
  // HUD card: deep-space glass with a thin teal edge and glow.
  maneuverCard: { borderRadius: radius.xl, overflow: "hidden", borderWidth: 1, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  hudRight: { position: "absolute", right: space.md, alignItems: "flex-end", gap: space.sm },
  // Left of the HUD column (beacons row = 2 × 44 + gap) and above the speed badge.
  hudDetails: { position: "absolute", left: space.md, right: space.md + 96 + space.sm, maxWidth: 320 },
  fill: { width: "100%" },
  hudToggle: { width: 56, height: 44, borderRadius: 22, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  hudCopilot: { width: 56, height: 56, borderRadius: 28, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  maneuverMain: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  thenRow: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xs },
  recenter: { position: "absolute", alignSelf: "center" },
  tripBar: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.md, paddingTop: space.md, flexDirection: "row", alignItems: "center", gap: space.sm },
  endButton: { minHeight: 44, paddingHorizontal: space.md },
  arrivedHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  resilientBanner: { marginTop: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.lg, borderWidth: 1 },
  confirmButton: { marginTop: space.xs },
  conflict: { flexDirection: "column", alignItems: "stretch" },
  conflictRow: { flexDirection: "row", gap: space.xs },
  cueRow: { flexDirection: "row", alignItems: "center", gap: space.xxs, marginTop: space.xxs },
  briefing: { borderRadius: radius.lg, padding: space.sm, gap: space.xs },
  briefingHead: { flexDirection: "row", alignItems: "center", gap: space.xs },
  briefingRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  briefingDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  speed: { position: "absolute", left: space.md, width: 72, height: 72, borderRadius: 36, borderWidth: 2, alignItems: "center", justifyContent: "center", shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  speedValue: { fontSize: 24, lineHeight: 28 },
  crosshair: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", paddingBottom: 44 },
});

/** Dev-only: rendered map frames per second (from MapLibre's per-frame event). */
function useFrameCounter(enabled: boolean): { value: number; onFrame: () => void } {
  const frames = useRef(0);
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => { setValue(frames.current); frames.current = 0; }, 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return { value, onFrame: useCallback(() => { frames.current += 1; }, []) };
}
