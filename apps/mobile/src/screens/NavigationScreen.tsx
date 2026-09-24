// Active-navigation screen for real GPS and the explicit demo route. This
// screen ONLY: pushes real sensor samples into the shared NavigationEngine
// (via naviaController), reads NavigationState back out, renders it, and
// forwards user actions (reroute-on-offroute is triggered here, but the
// off-route DETECTION itself is entirely OffRouteDetector's, inside the
// engine) — no navigation math lives in this file, per the user's explicit
// "screens must not duplicate navigation logic" instruction, which applies
// identically to Demo Mode (naviaController's DemoEngine) and real mode
// (NavigationEngine).
import React, { useEffect, useRef, useState } from "react";
import { Alert, View, Pressable, Linking, ScrollView, StyleSheet } from "react-native";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GeolocatedAirAlertProvider } from "../providers/GeolocatedAirAlertProvider";
import { AirThreatSummaryProvider, type AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import { NearbyPlacesProvider, type NearbyPlace, type NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";
import { useAppSettings } from "../settings/AppSettings";
import { AppText as Text, typography } from "../components/AppText";

type Props = NativeStackScreenProps<RootStackParamList, "Navigation">;

const TICK_INTERVAL_MS = 1000;
const DEMO_TICK_SECONDS = 1; // 1x simulated time per real second

function maneuverPhrase(m: string, en = false): string {
  if (en) {
    switch (m) {
      case "left": return "left";
      case "right": return "right";
      case "uturn": return "make a U-turn";
      case "roundabout": return "at the roundabout";
      case "arrive": return "arrive";
      case "depart": return "go";
      default: return "straight";
    }
  }
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

function maneuverGlyph(m: string): string {
  switch (m) {
    case "left": return "↰";
    case "right": return "↱";
    case "uturn": return "↶";
    case "roundabout": return "⟳";
    case "arrive": return "◎";
    default: return "↑";
  }
}

function gnssStatusText(gnss: string, hasTrustedFix: boolean, en = false): string {
  if (en) {
    if (gnss === "NORMAL") return "GPS · stable signal";
    if (gnss === "DEGRADED") return "GPS · weak signal";
    return hasTrustedFix ? "GPS · no signal · last confirmed place" : "GPS · waiting for a trusted fix";
  }
  if (gnss === "NORMAL") return "GPS · стабільний сигнал";
  if (gnss === "DEGRADED") return "GPS · нестабільний сигнал";
  return hasTrustedFix ? "GPS · сигнал втрачено · останнє підтверджене місце" : "GPS · очікуємо на достовірне визначення";
}

function confidenceText(band: string, en = false): string {
  if (en) {
    switch (band) {
      case "HIGH": return "high accuracy";
      case "MEDIUM": return "medium accuracy";
      case "LOW": return "low accuracy";
      default: return "accuracy unknown";
    }
  }
  switch (band) {
    case "HIGH": return "висока точність";
    case "MEDIUM": return "середня точність";
    case "LOW": return "низька точність";
    default: return "точність невідома";
  }
}

function threatPillLabel(summary: AirThreatSummary | null, en: boolean): string {
  if (!summary || summary.state === "unavailable") return en ? "Regional air-threat reports unavailable" : "Повідомлення про загрози недоступні";
  if (summary.state === "none") return en ? "No recent reports in the regional source" : "Джерело не має свіжих повідомлень у регіоні";
  const labels: Record<string, [string, string]> = {
    uav: ["БпЛА", "UAV"], fpv: ["FPV", "FPV"], recon: ["розвіддрони", "recon drones"], kab: ["КАБ", "guided bombs"],
    cruise_missile: ["крилаті ракети", "cruise missiles"], ballistic_missile: ["балістичні ракети", "ballistic missiles"],
    missile: ["ракети", "missiles"], aircraft: ["авіація", "aircraft"], other: ["інші повідомлення", "other reports"],
  };
  const kinds = summary.threatKinds.map((kind) => labels[kind]?.[en ? 1 : 0] ?? kind).join(", ");
  if (summary.state === "advisory") return en ? `Observation only · ${kinds || "air activity"}` : `Лише спостереження · ${kinds || "повітряна активність"}`;
  return en ? `Regional reports: ${kinds || "air threats"}` : `Регіональні повідомлення: ${kinds || "повітряні загрози"}`;
}

export function NavigationScreen({ route: navRoute, navigation }: Props): JSX.Element {
  const { destinationLat, destinationLon, destinationLabel } = navRoute.params;
  const { state, route, isDemoMode, setDemoMode, refresh, currentFix, setCurrentFix, alert, setAlert, airThreatSummary, setAirThreatSummary } = useNaviaStore();
  const { palette: p, language, isDark } = useAppSettings();
  const en = language === "en";
  const styles = makeStyles(p);
  const insets = useSafeAreaInsets();
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const voice = useRef(new ExpoSpeechVoiceProvider()).current;
  const lastAnnouncedStepId = useRef<string | null>(null);
  const rerouting = useRef(false);
  const lastRerouteAttemptAt = useRef(0);
  const firstRouteRequested = useRef(false);
  const alertProvider = useRef(new GeolocatedAirAlertProvider()).current;
  const threatProvider = useRef(new AirThreatSummaryProvider()).current;
  const placesProvider = useRef(new NearbyPlacesProvider()).current;
  const lastAlertRefreshAt = useRef(0);
  const lastPlacesRefreshAt = useRef(0);
  const alertRef = useRef(alert);
  alertRef.current = alert;
  const [nearbyPlaces, setNearbyPlaces] = useState<NearbyPlace[]>([]);
  const [nearbyExpanded, setNearbyExpanded] = useState(false);
  const [placesQueriedAt, setPlacesQueriedAt] = useState<number | null>(null);
  const [placesError, setPlacesError] = useState(false);
  const [poiFilter, setPoiFilter] = useState<"safety" | "fuel" | "shop" | "all">("safety");
  const activeDestination = useRef({ lat: destinationLat, lon: destinationLon });
  const [activeDestinationLabel, setActiveDestinationLabel] = useState(destinationLabel);

  useEffect(() => {
    const sessionIsDemo = isDemoMode;
    let cancelled = false;
    let positionSub: { remove: () => void } | null = null;
    let motionSub: { remove: () => void } | null = null;
    let tickHandle: ReturnType<typeof setInterval> | null = null;

    // These engines are app singletons. A route from an earlier trip must not
    // suppress the first route request for this screen session.
    if (sessionIsDemo) demoEngine.reset();
    else navigationEngine.clearRoute();
    firstRouteRequested.current = false;
    lastRerouteAttemptAt.current = 0;
    refresh();

    async function startReal() {
      const locationProvider = new ExpoLocationPositionProvider();
      let granted: boolean;
      try {
        granted = await locationProvider.requestPermission();
      } catch {
        granted = false;
      }
      if (cancelled) return;
      if (!granted) {
        if (!cancelled) setPermissionDenied(true);
        return;
      }

      const motionProvider = new ExpoSensorsMotionProvider();
      motionSub = motionProvider.subscribe((sample: IMUSample) => navigationEngine.pushImuSample(sample));

      let locationSubscription;
      try {
        locationSubscription = await locationProvider.subscribe((sample: GNSSRawSample) => {
        if (cancelled) return;
        const accepted = navigationEngine.pushGnssSample(sample, Date.now());
        const navigationState = navigationEngine.tick(Date.now());
        const trustedFix = navigationState.trustedPosition?.position;
        const acceptedFix = accepted && trustedFix?.timestamp === sample.timestamp ? trustedFix : null;
        if (acceptedFix) {
          setCurrentFix({
            lat: acceptedFix.lat,
            lon: acceptedFix.lon,
            timestamp: acceptedFix.timestamp,
            accuracyM: acceptedFix.accuracyM,
            speedMps: sample.speedMps,
            headingDeg: sample.headingDeg,
          });
        }
        refresh();

        // Location-based status and map places refresh in the background;
        // neither request blocks the one-second guidance/GPS updates.
        if (acceptedFix && Date.now() - lastAlertRefreshAt.current >= 60_000) {
          lastAlertRefreshAt.current = Date.now();
          void alertProvider.fetchAt({ lat: acceptedFix.lat, lon: acceptedFix.lon }).then((status) => {
            if (cancelled) return;
            setAlert(status);
            void threatProvider.fetchForRegion(status.region, status.district ?? "").then((summary) => { if (!cancelled) setAirThreatSummary(summary); }).catch(() => { if (!cancelled) setAirThreatSummary(null); });
            if (Date.now() - lastPlacesRefreshAt.current >= 45_000) {
              lastPlacesRefreshAt.current = Date.now();
              void placesProvider.fetchNearby({ lat: acceptedFix.lat, lon: acceptedFix.lon }, { includeKyivOfficialData: status.region === "м. Київ" })
                .then((items) => { if (!cancelled) { setNearbyPlaces(items); setPlacesQueriedAt(Date.now()); setPlacesError(false); } })
                .catch(() => { if (!cancelled) setPlacesError(true); });
            }
          }).catch(() => { if (!cancelled) setAlert(null); });
        } else if (acceptedFix && Date.now() - lastPlacesRefreshAt.current >= 60_000) {
          lastPlacesRefreshAt.current = Date.now();
          void placesProvider.fetchNearby({ lat: acceptedFix.lat, lon: acceptedFix.lon }, { includeKyivOfficialData: alertRef.current?.region === "м. Київ" })
            .then((items) => { if (!cancelled) { setNearbyPlaces(items); setPlacesQueriedAt(Date.now()); setPlacesError(false); } })
            .catch(() => { if (!cancelled) setPlacesError(true); });
        }

        // First fix with no route yet -> request one now that we know origin.
        const trustedOrigin = navigationEngine.getState().gnss === "NORMAL" ? navigationEngine.getState().trustedPosition?.position : null;
        if (!navigationEngine.getRoute() && !firstRouteRequested.current && trustedOrigin) {
          firstRouteRequested.current = true;
          void navigationEngine.requestRoute({ lat: trustedOrigin.lat, lon: trustedOrigin.lon }, activeDestination.current)
            .then(() => { if (!cancelled) { setRouteError(null); refresh(); } })
            .catch((err: unknown) => { if (!cancelled) setRouteError((err as Error).message); });
        }
        }, true);
      } catch (error) {
        if (!cancelled) {
          setRouteError((error as Error).message || (en ? "Location service could not start." : "Не вдалося запустити геолокацію."));
        }
        motionSub?.remove();
        return;
      }
      if (cancelled) {
        locationSubscription.remove();
        motionSub?.remove();
        return;
      }
      positionSub = locationSubscription;

      tickHandle = setInterval(() => {
        navigationEngine.tick(Date.now());
        refresh();
        const navState = navigationEngine.getState();
        const position = navState.gnss === "NORMAL" ? navState.trustedPosition?.position : null;
        if (position) void maybeReroute(position, activeDestination.current);
      }, TICK_INTERVAL_MS);
    }

    async function startDemo() {
      try {
        await demoEngine.start();
        if (cancelled) {
          demoEngine.reset();
          return;
        }
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
      if (Date.now() - lastRerouteAttemptAt.current < 30_000) return;
      lastRerouteAttemptAt.current = Date.now();
      rerouting.current = true;
      try {
        await navigationEngine.requestRoute(current, dest);
        if (!cancelled) { setRouteError(null); refresh(); }
      } catch (err) {
        if (!cancelled) setRouteError((err as Error).message);
      } finally {
        rerouting.current = false;
      }
    }

    if (sessionIsDemo) void startDemo();
    else void startReal().catch((error: unknown) => { if (!cancelled) setRouteError((error as Error).message); });

    return () => {
      cancelled = true;
      positionSub?.remove();
      motionSub?.remove();
      if (tickHandle) clearInterval(tickHandle);
      if (sessionIsDemo) demoEngine.reset();
      else {
        navigationEngine.clearRoute();
        navigationEngine.tick(Date.now());
      }
      refresh();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speak the next maneuver once, the first time it becomes the current one.
  useEffect(() => {
    const step = state.nextStep;
    if (step && step.id !== lastAnnouncedStepId.current) {
      lastAnnouncedStepId.current = step.id;
      const distanceM = state.nextStepDistanceM ?? step.distanceM;
      const text = en ? `In ${Math.round(distanceM)} meters, ${maneuverPhrase(step.maneuver, true)}${step.roadName ? ` onto ${step.roadName}` : ""}.` : `Через ${Math.round(distanceM)} метрів, ${maneuverPhrase(step.maneuver)}${step.roadName ? `, на ${step.roadName}` : ""}.`;
      void voice.speak(text, { language: en ? "en-US" : "uk-UA" }).catch(() => {});
    }
  }, [state.nextStep, voice, en]);

  const visiblePlaces = nearbyPlaces.filter((item) => poiFilter === "all"
    || (poiFilter === "safety" && (item.category === "shelter" || item.category === "resilience"))
    || (poiFilter === "fuel" && item.category === "fuel")
    || (poiFilter === "shop" && (item.category === "shop" || item.category === "pharmacy" || item.category === "hospital")));
  const safetyCount = nearbyPlaces.filter((item) => item.category === "shelter" || item.category === "resilience").length;
  const fuelCount = nearbyPlaces.filter((item) => item.category === "fuel").length;
  const visibleThreatSummary = airThreatSummary?.region === alert?.region && airThreatSummary?.district === (alert?.district ?? "") ? airThreatSummary : null;

  async function routeToPlace(place: NearbyPlace) {
    const origin = !isDemoMode && state.gnss === "NORMAL" ? state.trustedPosition?.position ?? null : null;
    if (!origin) {
      Alert.alert(en ? "Waiting for GPS" : "Очікуємо GPS", en ? "Wait for the phone to confirm its position, then try again." : "Дочекайтеся, поки телефон визначить координати, і спробуйте ще раз.");
      return;
    }
    try {
      activeDestination.current = place.location;
      setActiveDestinationLabel(place.name);
      await navigationEngine.requestRoute({ lat: origin.lat, lon: origin.lon }, place.location);
      setRouteError(null);
      refresh();
    } catch (error) {
      activeDestination.current = { lat: destinationLat, lon: destinationLon };
      setActiveDestinationLabel(destinationLabel);
      Alert.alert(en ? "Could not navigate to this place" : "Не вдалося прокласти маршрут до точки", (error as Error).message);
    }
  }

  return (
    <View style={styles.container}>
      {isDemoMode && (
        <View style={[styles.demoBanner, { top: insets.top }]}>
          <Text style={styles.demoBannerText}>{en ? "DEMO MODE — no real GPS" : "ДЕМО-РЕЖИМ — без реального GPS"}</Text>
        </View>
      )}
      <MapLibreRouteView
        styleUrl={isDark ? config.mapStyleDarkUrl : config.mapStyleUrl}
        routeGeometry={route?.geometry ?? []}
        currentPosition={state.position?.position ?? state.trustedPosition?.position ?? null}
        headingDeg={state.headingDeg}
        nearbyPlaces={isDemoMode ? [] : visiblePlaces}
        initialCenter={state.trustedPosition?.position ?? null}
        isDark={isDark}
        isEnglish={en}
        positionQuality={state.gnss === "NORMAL" ? "good" : state.gnss === "DEGRADED" ? "degraded" : "lost"}
        controlsTopOffset={insets.top + (route ? 228 : isDemoMode ? 150 : 220)}
      />

      {permissionDenied && <View style={[styles.stateBanner, { top: insets.top + (route ? 166 : 64) }]}>
        <Text style={styles.errorText}>{en ? "Location access is off." : "Доступ до геолокації не надано."}</Text>
        <Text style={styles.errorSub}>{en ? "The map remains available. Allow GPS for live guidance." : "Мапа працює; для живого маршруту дозвольте GPS."}</Text>
        <View style={styles.stateButtons}><Pressable style={styles.messageButton} onPress={() => void Linking.openSettings()}><Text style={styles.messageButtonText}>{en ? "Open Settings" : "Налаштування"}</Text></Pressable><Pressable style={styles.backButton} onPress={() => navigation.goBack()}><Text style={styles.backButtonText}>{en ? "Back" : "Назад"}</Text></Pressable></View>
      </View>}
      {!!routeError && <View style={[styles.routeErrorBanner, { top: insets.top + (route ? 162 : 58) }]}><Text style={styles.errorText}>{en ? "Route unavailable" : "Маршрут поки недоступний"}</Text><Text style={styles.errorSub}>{en ? "Check the connection. You can still see the map and nearby services." : "Перевірте з’єднання. Мапа та місця поруч залишаються доступними."}</Text>{__DEV__ && <Text style={styles.debugError}>{routeError}</Text>}</View>}

      {route && (
        <View style={[styles.hudTop, { top: insets.top + (isDemoMode ? 44 : 14) }]}>
          <View style={styles.maneuverIcon}><Text style={styles.maneuverGlyph}>{state.nextStep ? maneuverGlyph(state.nextStep.maneuver) : "↑"}</Text></View>
          <View style={styles.maneuverCopy}>
            {state.nextStep ? <>
              <Text style={styles.hudTopDistance}>{state.nextStepDistanceM != null ? (en ? `IN ${Math.round(state.nextStepDistanceM)} M` : `ЧЕРЕЗ ${Math.round(state.nextStepDistanceM)} М`) : (en ? "NEXT MANEUVER" : "НАСТУПНИЙ МАНЕВР")}</Text>
              <Text style={styles.hudTopManeuver} numberOfLines={1}>{maneuverPhrase(state.nextStep.maneuver, en)}</Text>
              {state.nextStep.roadName ? <Text style={styles.hudTopRoad} numberOfLines={1}>{state.nextStep.roadName}</Text> : null}
            </> : <>
              <Text style={styles.hudTopDistance}>{en ? "ROUTE IN PROGRESS" : "МАРШРУТ АКТИВНИЙ"}</Text>
              <Text style={styles.hudTopManeuver} numberOfLines={1}>{activeDestinationLabel}</Text>
              <Text style={styles.hudTopRoad}>{en ? `${(state.routeRemainingM / 1000).toFixed(1)} km remaining` : `Залишилося ${(state.routeRemainingM / 1000).toFixed(1)} км`}</Text>
            </>}
          </View>
        </View>
      )}

      {!route && !permissionDenied && !routeError && <View style={[styles.routeStartingCard, { top: insets.top + (isDemoMode ? 44 : 122) }]}>
        <View style={styles.routeStartingMark}><Text style={styles.routeStartingGlyph}>⌖</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.routeStartingTitle}>{en ? "Getting your route ready" : "Готуємо маршрут"}</Text>
          <Text style={styles.routeStartingDestination} numberOfLines={1}>{activeDestinationLabel}</Text>
          <Text style={styles.routeStartingNote}>{state.gnss === "NORMAL" ? (en ? "Finding the best route…" : "Прокладаємо найкращий шлях…") : (en ? "Waiting for a reliable GPS position" : "Чекаємо на точне визначення GPS")}</Text>
        </View>
      </View>}

      {!isDemoMode && (
        <Pressable accessibilityLabel={alert?.source ?? (en ? "Air alert status" : "Статус повітряної тривоги")} onPress={() => { if (alert?.sourceUrl) void Linking.openURL(alert.sourceUrl); }} style={[styles.alertPill, { top: insets.top + (route ? 111 : 12) }, alert?.active === true && styles.alertPillActive]}>
          <View style={[styles.alertPillDot, alert?.active === true && styles.alertPillDotActive]} />
          <View style={{ flex: 1 }}><Text numberOfLines={1} style={[styles.alertPillText, alert?.active === true && styles.alertPillTextActive]}>{!alert ? (en ? "Checking alert status…" : "Перевіряємо статус тривоги…") : alert.active === null ? (en ? "Alert status unavailable" : "Статус тривоги невідомий") : alert.active ? (en ? "ALERT · " + alert.locationLabel : "ТРИВОГА · " + alert.locationLabel) : (en ? "No alert · " + alert.locationLabel : "Без тривоги · " + alert.locationLabel)}</Text><Text numberOfLines={1} style={[styles.alertPillSource, alert?.active === true && styles.alertPillTextActive]}>{alert?.source ?? (currentFix ? (en ? "Waiting for current data" : "Очікуємо актуальні дані") : (en ? "Waiting for GPS position" : "Очікуємо визначення GPS-місця"))}{alert?.active === true && alert.since ? " · " + new Date(alert.since).toLocaleTimeString(en ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" }) : ""}</Text></View>
        </Pressable>
      )}

      {!isDemoMode && alert && <Pressable onPress={() => void Linking.openURL(visibleThreatSummary?.sourceUrl ?? "https://neptun.in.ua/")} style={[styles.threatPill, { top: insets.top + (route ? 166 : 68) }]}>
        <View style={[styles.threatPillDot, visibleThreatSummary?.state === "reported" && styles.threatPillDotReported]} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={styles.threatPillText}>{threatPillLabel(visibleThreatSummary, en)}</Text>
          <Text numberOfLines={1} style={styles.threatPillMeta}>{visibleThreatSummary?.source ?? "NEPTUN"}{visibleThreatSummary?.checkedAt ? ` · ${new Date(visibleThreatSummary.checkedAt).toLocaleTimeString(en ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" })}` : ""}{visibleThreatSummary?.region ? ` · ${visibleThreatSummary.region}` : ""}</Text>
        </View>
      </Pressable>}

      {route && <View style={[styles.hudBottom, { bottom: Math.max(insets.bottom, 10) + 10 }]}>
        <View style={styles.tripStatsRow}>
          <View style={styles.tripStat}><Text style={styles.tripStatLabel}>{en ? "ARRIVAL" : "ПРИБУТТЯ"}</Text><Text style={styles.tripStatValue}>{state.etaSeconds != null ? new Date(Date.now() + state.etaSeconds * 1000).toLocaleTimeString(en ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—:—"}</Text></View>
          <View style={styles.tripDivider} />
          <View style={styles.tripStat}><Text style={styles.tripStatLabel}>{en ? "DISTANCE LEFT" : "ЗАЛИШИЛОСЯ"}</Text><Text style={styles.tripStatValue}>{(state.routeRemainingM / 1000).toFixed(1)} <Text style={styles.tripStatUnit}>{en ? "km" : "км"}</Text></Text></View>
        </View>
        <View style={styles.gpsRow}>
          <View style={styles.gpsStatusRow}>
            <View style={[styles.gpsStatusDot, state.gnss === "NORMAL" ? styles.gpsStatusDotGood : state.gnss === "DEGRADED" ? styles.gpsStatusDotDegraded : styles.gpsStatusDotLost]} />
            <Text numberOfLines={1} style={[styles.hudBottomStatus, state.gnss !== "NORMAL" && styles.hudBottomWarn]}>{gnssStatusText(state.gnss, Boolean(state.trustedPosition), en)}</Text>
          </View>
          <Text numberOfLines={1} style={styles.gpsAccuracy}>{confidenceText(state.confidenceBand, en)}</Text>
        </View>
        {state.offRoute && <Text style={styles.hudOffRoute}>{en ? "Off route. Recalculating…" : "Ви відхилилися від маршруту. Перераховую…"}</Text>}

        {nearbyExpanded && !isDemoMode && <ScrollView style={styles.nearbyDetails} showsVerticalScrollIndicator={false}>
          <View style={styles.poiFilterRow}>{(["safety", "fuel", "shop", "all"] as const).map((filter) => {
            const selected = poiFilter === filter;
            const label = filter === "safety" ? `${en ? "Safety" : "Безпека"}${safetyCount ? ` ${safetyCount}` : ""}` : filter === "fuel" ? `${en ? "Fuel" : "АЗС"}${fuelCount ? ` ${fuelCount}` : ""}` : filter === "shop" ? (en ? "Services" : "Сервіси") : (en ? "All" : "Усі");
            return <Pressable key={filter} style={[styles.poiChip, selected && styles.poiChipSelected]} onPress={() => setPoiFilter(filter)}><Text style={[styles.poiChipText, selected && styles.poiChipTextSelected]}>{label}</Text></Pressable>;
          })}</View>
          {visiblePlaces.slice(0, 3).map((place) => <Pressable key={place.id} style={styles.nearbyRow} onPress={() => void routeToPlace(place)}><View style={styles.nearbyTextBlock}><Text numberOfLines={1} style={styles.nearbyName}>{place.name}</Text><Text style={styles.nearbyMeta}>{place.category === "shelter" ? (en ? "Shelter" : "Укриття") : place.category === "resilience" ? (en ? "Resilience point" : "Пункт незламності") : place.category === "fuel" ? (en ? "Fuel station" : "АЗС") : place.category === "pharmacy" ? (en ? "Pharmacy" : "Аптека") : place.category === "hospital" ? (en ? "Medical" : "Медицина") : (en ? "Shop" : "Магазин")} · {place.source === "OpenStreetMap" ? "OpenStreetMap" : (en ? "Kyiv municipal data" : "Відкриті дані Києва")}</Text></View><Text style={styles.nearbyDistance}>{place.distanceM < 1000 ? `${Math.round(place.distanceM)} ${en ? "m" : "м"}` : `${(place.distanceM / 1000).toFixed(1)} ${en ? "km" : "км"}`}</Text><Text style={styles.nearbyGo}>↗</Text></Pressable>)}
          {visiblePlaces.length === 0 && <Text style={styles.placesNote}>{placesError ? (en ? "Nearby places could not be refreshed." : "Не вдалося оновити місця поблизу.") : (en ? "Looking for nearby safety places and services…" : "Шукаємо безпечні місця та сервіси поблизу…")}</Text>}
          <Text style={styles.mapAttribution}>{en ? "Places: OpenStreetMap contributors; shelter data may be incomplete. Last query" : "Місця: учасники OpenStreetMap; дані укриттів можуть бути неповними. Останній запит"}{placesQueriedAt ? " " + new Date(placesQueriedAt).toLocaleTimeString(en ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" }) : " —"}. {en ? "Check access on site." : "Перевірте доступність на місці."}</Text>
        </ScrollView>}

        <View style={styles.routeActions}>
          {!isDemoMode && <Pressable accessibilityRole="button" accessibilityLabel={nearbyExpanded ? (en ? "Hide nearby places" : "Сховати місця поруч") : (en ? "Show nearby places" : "Показати місця поруч")} style={[styles.actionButton, nearbyExpanded && styles.actionButtonActive]} onPress={() => setNearbyExpanded((open) => !open)}><Text numberOfLines={1} style={[styles.actionButtonText, nearbyExpanded && styles.actionButtonTextActive]}>{nearbyExpanded ? "⌄ " : "⌃ "}{en ? `Nearby · ${visiblePlaces.length}` : `Поруч · ${visiblePlaces.length}`}</Text></Pressable>}
          <VoicePanel
            isDemoMode={isDemoMode}
            compact
            context={{
              state,
              route,
              nearbyLandmarks: state.nearbyLandmarks,
              nearbyPOI: isDemoMode ? DEMO_POIS : nearbyPlaces.map((item) => ({ id: item.id, name: item.name, category: item.category === "fuel" ? "fuel" as const : item.category === "pharmacy" ? "pharmacy" as const : item.category === "hospital" ? "hospital" as const : item.category === "shop" ? "supermarket" as const : "recognizable_landmark" as const, location: item.location })),
              recentEvents: [...(isDemoMode ? demoEngine : navigationEngine).getTelemetry().getEvents()],
            }}
          />
          <Pressable
            style={styles.endButton}
            onPress={() => {
              setDemoMode(false);
              navigation.goBack();
            }}
          >
            <Text style={styles.endButtonText}>{en ? "End" : "Завершити"}</Text>
          </Pressable>
        </View>
      </View>}
    </View>
  );
}

function makeStyles(p: ReturnType<typeof useAppSettings>["palette"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: p.background }, centerMessage: { flex: 1, backgroundColor: p.background, alignItems: "center", justifyContent: "center", padding: 24 },
    stateBanner: { position: "absolute", left: 18, right: 18, zIndex: 12, backgroundColor: p.surface, borderColor: p.border, borderWidth: 1, borderRadius: 15, padding: 13, alignItems: "center" },
    routeErrorBanner: { position: "absolute", left: 18, right: 18, zIndex: 11, backgroundColor: p.surface, borderColor: p.warning, borderWidth: 1, borderRadius: 15, padding: 13, alignItems: "center" },
    stateButtons: { flexDirection: "row", alignItems: "center", gap: 8 },
    errorText: { color: p.danger, fontSize: 17, fontWeight: "600", marginBottom: 8, textAlign: "center" }, errorSub: { color: p.muted, fontSize: 13, textAlign: "center" }, debugError: { color: p.subtle, fontSize: 10, textAlign: "center", marginTop: 9 },
    messageButton: { backgroundColor: p.surfaceRaised, borderRadius: 13, minHeight: 46, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", marginTop: 20 }, messageButtonText: { color: p.accent, fontSize: 14, fontWeight: "700" }, backButton: { paddingHorizontal: 18, paddingVertical: 12, marginTop: 4 }, backButtonText: { color: p.muted, fontSize: 13, fontWeight: "600" },
    demoBanner: { position: "absolute", left: 0, right: 0, backgroundColor: "#7045c8", paddingVertical: 6, zIndex: 10, alignItems: "center" }, demoBannerText: { color: "#fff", fontWeight: "700", fontSize: 11, letterSpacing: 0.8 },
    hudTop: { position: "absolute", left: 16, right: 16, minHeight: 88, backgroundColor: p.surface, borderColor: p.border, borderWidth: 1, borderLeftWidth: 4, borderLeftColor: p.accent, borderRadius: 20, paddingHorizontal: 15, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 13, zIndex: 20, elevation: 10, shadowColor: "#001018", shadowOpacity: 0.17, shadowRadius: 16, shadowOffset: { width: 0, height: 7 } },
    maneuverIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, maneuverGlyph: { color: p.accent, fontSize: 34, fontWeight: "700", lineHeight: 38 }, maneuverCopy: { flex: 1, minWidth: 0 },
    hudTopDistance: { color: p.accent, fontSize: 13, fontWeight: "800", letterSpacing: 0.5 }, hudTopManeuver: { ...typography.maneuver, color: p.text, marginTop: 1 }, hudTopRoad: { color: p.muted, fontSize: 14, marginTop: 1 },
    routeStartingCard: { position: "absolute", left: 16, right: 16, minHeight: 88, backgroundColor: p.surface, borderColor: p.border, borderWidth: 1, borderRadius: 20, padding: 14, flexDirection: "row", alignItems: "center", gap: 13, zIndex: 20, elevation: 10, shadowColor: "#001018", shadowOpacity: 0.17, shadowRadius: 16, shadowOffset: { width: 0, height: 7 } }, routeStartingMark: { width: 50, height: 50, borderRadius: 17, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, routeStartingGlyph: { color: p.accent, fontSize: 29, fontWeight: "700" }, routeStartingTitle: { color: p.text, fontSize: 17, fontWeight: "700" }, routeStartingDestination: { color: p.accent, fontSize: 14, fontWeight: "700", marginTop: 2 }, routeStartingNote: { color: p.muted, fontSize: 12, marginTop: 1 },
    alertPill: { position: "absolute", left: 18, right: 18, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, minHeight: 52, borderRadius: 15, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, zIndex: 21, elevation: 9 }, alertPillActive: { backgroundColor: "#952f40", borderColor: "#d06372" }, alertPillDot: { width: 9, height: 9, borderRadius: 5, marginRight: 9, backgroundColor: p.accent }, alertPillDotActive: { backgroundColor: "#fff" }, alertPillText: { color: p.text, fontSize: 13, fontWeight: "700", flex: 1 }, alertPillTextActive: { color: "#fff" }, alertPillSource: { color: p.subtle, fontSize: 12, marginTop: 2 },
    threatPill: { position: "absolute", left: 18, right: 18, minHeight: 46, borderRadius: 14, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, paddingVertical: 6, zIndex: 20, elevation: 8 }, threatPillDot: { width: 8, height: 8, borderRadius: 4, marginRight: 9, backgroundColor: p.subtle }, threatPillDotReported: { backgroundColor: p.warning }, threatPillText: { color: p.text, fontSize: 13, fontWeight: "700" }, threatPillMeta: { color: p.subtle, fontSize: 12, marginTop: 2 },
    hudBottom: { position: "absolute", left: 12, right: 12, backgroundColor: p.surface, borderColor: p.border, borderWidth: 1, borderRadius: 24, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 12, zIndex: 20, elevation: 12, shadowColor: "#001018", shadowOpacity: 0.19, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    tripStatsRow: { flexDirection: "row", alignItems: "center", minHeight: 58 }, tripStat: { flex: 1, justifyContent: "center" }, tripStatLabel: { color: p.subtle, fontSize: 11, fontWeight: "800", letterSpacing: 0.4 }, tripStatValue: { ...typography.navigationValue, color: p.text, marginTop: 1 }, tripStatUnit: { color: p.muted, fontSize: 15, fontWeight: "700" }, tripDivider: { width: StyleSheet.hairlineWidth, height: 39, backgroundColor: p.border, marginHorizontal: 14 },
    gpsRow: { minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border, marginTop: 7, paddingTop: 8 }, gpsStatusRow: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1 }, gpsStatusDot: { width: 9, height: 9, borderRadius: 5 }, gpsStatusDotGood: { backgroundColor: p.accent }, gpsStatusDotDegraded: { backgroundColor: p.warning }, gpsStatusDotLost: { backgroundColor: p.danger }, hudBottomStatus: { color: p.accent, fontSize: 13, fontWeight: "700", flexShrink: 1 }, hudBottomWarn: { color: p.warning }, gpsAccuracy: { color: p.muted, fontSize: 12, flexShrink: 0 }, hudOffRoute: { color: p.danger, fontSize: 13, marginTop: 7, fontWeight: "600" }, nearbyDetails: { maxHeight: 170, marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border },
    poiFilterRow: { flexDirection: "row", gap: 6, marginTop: 9, marginBottom: 2 }, poiChip: { flex: 1, minHeight: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: p.surfaceRaised, paddingHorizontal: 4 }, poiChipSelected: { backgroundColor: p.accent }, poiChipText: { color: p.muted, fontSize: 11, fontWeight: "700" }, poiChipTextSelected: { color: p.accentText }, placesNote: { color: p.warning, fontSize: 12, marginTop: 7 },
    nearbyRow: { flexDirection: "row", alignItems: "center", minHeight: 45, paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border }, nearbyTextBlock: { flex: 1, minWidth: 0 }, nearbyName: { color: p.text, fontSize: 12, fontWeight: "700" }, nearbyMeta: { color: p.subtle, fontSize: 10, marginTop: 2 }, nearbyDistance: { color: p.text, fontSize: 11, fontWeight: "700", marginHorizontal: 6 }, nearbyGo: { color: p.accent, fontSize: 14, fontWeight: "800" }, mapAttribution: { color: p.subtle, fontSize: 9, lineHeight: 13, marginTop: 4 },
    routeActions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 }, actionButton: { flex: 1, minWidth: 0, minHeight: 46, borderRadius: 15, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center", paddingHorizontal: 9 }, actionButtonActive: { backgroundColor: p.accent }, actionButtonText: { color: p.text, fontSize: 13, fontWeight: "700" }, actionButtonTextActive: { color: p.accentText }, endButton: { minWidth: 82, minHeight: 46, borderRadius: 15, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 }, endButtonText: { color: p.muted, fontSize: 12, fontWeight: "700" },
  });
}
