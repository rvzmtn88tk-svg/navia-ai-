import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, Linking, Pressable, ScrollView, Share,
  StyleSheet, View,
} from "react-native";
import * as Location from "expo-location";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { DEMO_DESTINATION, type GNSSRawSample } from "@navia/core";
import { GeolocatedAirAlertProvider } from "../providers/GeolocatedAirAlertProvider";
import { AirThreatSummaryProvider, type AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import { NearbyPlacesProvider, type NearbyPlace, type NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";
import { MapLibreRouteView } from "../providers/MapLibreRouteView";
import { config } from "../config";
import { navigationEngine, useNaviaStore } from "../engine/naviaController";
import { useAppSettings } from "../settings/AppSettings";
import { BrandMark } from "../components/BrandMark";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { AppText as Text, AppTextInput as TextInput, typography } from "../components/AppText";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;
type GpsStatus = "checking" | "permission" | "searching" | "ready" | "error";
type GpsSignal = "stable" | "degraded" | "lost";
type PoiFilter = "safety" | "fuel" | "essentials" | "all";

const alertProvider = new GeolocatedAirAlertProvider();
const threatProvider = new AirThreatSummaryProvider();
const placesProvider = new NearbyPlacesProvider();

export function HomeScreen({ navigation }: Props): JSX.Element {
  const isFocused = useIsFocused();
  const recentDestinations = useNaviaStore((store) => store.recentDestinations);
  const setDemoMode = useNaviaStore((store) => store.setDemoMode);
  const currentFix = useNaviaStore((store) => isFocused ? store.currentFix : null);
  const setCurrentFix = useNaviaStore((store) => store.setCurrentFix);
  const alert = useNaviaStore((store) => isFocused ? store.alert : null);
  const setAlert = useNaviaStore((store) => store.setAlert);
  const airThreatSummary = useNaviaStore((store) => isFocused ? store.airThreatSummary : null);
  const setAirThreatSummary = useNaviaStore((store) => store.setAirThreatSummary);
  const { palette: p, language, isDark, displayName } = useAppSettings();
  const en = language === "en";
  const styles = makeStyles(p, isDark);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("checking");
  const [gpsSignal, setGpsSignal] = useState<GpsSignal>("lost");
  const [gpsFresh, setGpsFresh] = useState(false);
  const [alertError, setAlertError] = useState(false);
  const [refreshingAlert, setRefreshingAlert] = useState(false);
  const [nearbyPlaces, setNearbyPlaces] = useState<NearbyPlace[]>([]);
  const [placesError, setPlacesError] = useState(false);
  const [refreshingPlaces, setRefreshingPlaces] = useState(false);
  const [poiFilter, setPoiFilter] = useState<PoiFilter>("safety");
  const [question, setQuestion] = useState("");
  const locationSub = useRef<Location.LocationSubscription | null>(null);
  const lastAlertRequestAt = useRef(0);
  const lastPlacesRequestAt = useRef(0);
  const gpsSignalRef = useRef<GpsSignal>("lost");
  const brandScale = useRef(new Animated.Value(0.9)).current;
  const brandOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(brandScale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 4 }),
      Animated.timing(brandOpacity, { toValue: 1, duration: 420, useNativeDriver: true }),
    ]).start();
  }, [brandOpacity, brandScale]);

  const refreshPlaces = useCallback(async (point: GNSSRawSample, region?: string, force = false) => {
    if (!force && Date.now() - lastPlacesRequestAt.current < 45_000) return;
    lastPlacesRequestAt.current = Date.now();
    setRefreshingPlaces(true);
    try {
      const items = await placesProvider.fetchNearby(
        { lat: point.lat, lon: point.lon },
        { includeKyivOfficialData: region === "м. Київ", force },
      );
      setNearbyPlaces(items);
      setPlacesError(false);
    } catch {
      setPlacesError(true);
    } finally {
      setRefreshingPlaces(false);
    }
  }, []);

  const refreshAlert = useCallback(async (point: GNSSRawSample, force = false) => {
    if (!force && Date.now() - lastAlertRequestAt.current < 30_000) return;
    lastAlertRequestAt.current = Date.now();
    setRefreshingAlert(true);
    try {
      const status = await alertProvider.fetchAt({ lat: point.lat, lon: point.lon });
      setAlert(status);
      setAlertError(false);
      void threatProvider.fetchForRegion(status.region, status.district ?? "").then(setAirThreatSummary);
      void refreshPlaces(point, status.region);
    } catch (error) {
      setAlert(null);
      setAlertError(true);
      const latest = useNaviaStore.getState();
      setThreatUnavailable(error instanceof Error ? error.message : "Source unavailable", latest.currentFix, latest.alert?.region ?? "", latest.alert?.district ?? "", setAirThreatSummary);
    } finally {
      setRefreshingAlert(false);
    }
  }, [refreshPlaces, setAirThreatSummary, setAlert]);

  const startGps = useCallback(async (requestPermission: boolean) => {
    let permission = await Location.getForegroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
    if (permission.status !== "granted" && requestPermission) {
      permission = await Location.requestForegroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
    }
    if (permission.status !== "granted") {
      setGpsStatus("permission");
      return;
    }
    setGpsStatus("searching");
    try {
      const onLocation = (loc: Location.LocationObject) => {
        const accuracy = loc.coords.accuracy;
        const point: GNSSRawSample = {
          lat: loc.coords.latitude,
          lon: loc.coords.longitude,
          timestamp: loc.timestamp,
          accuracyM: accuracy != null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
          speedMps: loc.coords.speed != null && Number.isFinite(loc.coords.speed) && loc.coords.speed >= 0 ? loc.coords.speed : null,
          headingDeg: loc.coords.heading != null && Number.isFinite(loc.coords.heading) && loc.coords.heading >= 0 && loc.coords.heading < 360 ? loc.coords.heading : null,
        };
        if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90 || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180
          || Date.now() - point.timestamp > 15_000 || point.timestamp > Date.now() + 1_500) return;
        const accepted = navigationEngine.pushGnssSample(point, Date.now());
        const navigationState = navigationEngine.tick(Date.now());
        const trustedPosition = navigationState.trustedPosition?.position;
        if (!accepted || trustedPosition?.timestamp !== point.timestamp) {
          const engineSignal: GpsSignal = navigationState.gnss === "NORMAL" ? "stable" : navigationState.gnss === "DEGRADED" ? "degraded" : "lost";
          gpsSignalRef.current = engineSignal;
          setGpsSignal(engineSignal);
          setGpsStatus("ready");
          return;
        }
        setCurrentFix(point);
        setGpsFresh(true);
        setGpsStatus("ready");
        gpsSignalRef.current = navigationState.gnss === "NORMAL" ? "stable" : navigationState.gnss === "DEGRADED" ? "degraded" : "lost";
        setGpsSignal(gpsSignalRef.current);
        void refreshAlert(point);
        if (Date.now() - lastPlacesRequestAt.current >= 45_000) {
          void refreshPlaces(point, useNaviaStore.getState().alert?.region);
        }
      };
      const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      onLocation(first);
      if (!locationSub.current) {
        locationSub.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 20 },
          onLocation,
        );
      }
    } catch {
      setGpsStatus("error");
    }
  }, [refreshAlert, refreshPlaces, setCurrentFix]);

  useFocusEffect(useCallback(() => {
    void startGps(false);
    const staleCheck = setInterval(() => {
      const latest = useNaviaStore.getState().currentFix;
      const fresh = Boolean(latest && Date.now() - latest.timestamp <= 10_000 && latest.timestamp <= Date.now() + 1_500);
      setGpsFresh((previous) => previous === fresh ? previous : fresh);
      if (!fresh && latest && gpsSignalRef.current !== "lost") {
        const navigationState = navigationEngine.tick(Date.now());
        const engineSignal: GpsSignal = navigationState.gnss === "NORMAL" ? "stable" : navigationState.gnss === "DEGRADED" ? "degraded" : "lost";
        gpsSignalRef.current = engineSignal;
        setGpsSignal(engineSignal);
      }
    }, 2_000);
    return () => { clearInterval(staleCheck); locationSub.current?.remove(); locationSub.current = null; };
  }, [startGps]));

  async function shareCurrentLocation() {
    let point = currentFix;
    if (!point || !gpsFresh || Date.now() - point.timestamp > 10_000) {
      await startGps(true);
      point = useNaviaStore.getState().currentFix;
    }
    if (!point || Date.now() - point.timestamp > 10_000) {
      Alert.alert(en ? "Current position unavailable" : "Немає актуальної геолокації", en ? "Wait for a fresh GPS fix before sharing your position." : "Дочекайтеся нового GPS-вимірювання, перш ніж надсилати геолокацію.");
      return;
    }
    const lat = point.lat.toFixed(6), lon = point.lon.toFixed(6);
    await Share.share({ title: en ? "My location" : "Моє місце", message: `${lat}, ${lon}\nhttps://maps.apple.com/?ll=${lat},${lon}` });
  }

  function startDemo() {
    setDemoMode(true);
    navigation.navigate("Navigation", {
      destinationLat: DEMO_DESTINATION.lat,
      destinationLon: DEMO_DESTINATION.lon,
      destinationLabel: en ? "Boryspil (demo)" : "Бориспіль (демо)",
    });
  }

  function openSearch() {
    setDemoMode(false);
    navigation.navigate("Search");
  }

  function askNavia(text = question) {
    const initialQuestion = text.trim();
    setQuestion("");
    navigation.navigate("Assistant", initialQuestion ? { initialQuestion } : undefined);
  }

  function openPlace(place: NearbyPlace) {
    setDemoMode(false);
    navigation.navigate("Navigation", {
      destinationLat: place.location.lat,
      destinationLon: place.location.lon,
      destinationLabel: place.name,
    });
  }

  const gpsLabel = gpsStatus === "ready" && gpsSignal === "lost" && Boolean(currentFix)
    ? (en ? "GNSS lost · last trusted position" : "GNSS втрачено · остання достовірна позиція")
    : gpsStatus === "ready" && gpsSignal === "lost"
      ? (en ? "Waiting for a trusted GPS fix" : "Очікуємо на достовірний GPS-сигнал")
    : gpsStatus === "ready" && gpsSignal === "degraded"
      ? `${en ? "GNSS unstable" : "GNSS нестабільний"}${currentFix?.accuracyM != null ? ` · ±${Math.round(currentFix.accuracyM)} ${en ? "m" : "м"}` : ""}`
      : gpsStatus === "ready" && !gpsFresh
        ? (en ? "GPS signal lost · showing last known fix" : "Сигнал GPS втрачено · показано останню позицію")
        : gpsStatus === "ready"
      ? currentFix?.accuracyM == null
      ? (en ? "GPS accuracy unknown" : "Точність GPS невідома")
      : currentFix.accuracyM <= 25
        ? `${en ? "Signal stable" : "Сигнал стабільний"} · ±${Math.round(currentFix.accuracyM)} ${en ? "m" : "м"}`
        : `${en ? "GPS signal is weak" : "GPS нестабільний"} · ±${Math.round(currentFix.accuracyM)} ${en ? "m" : "м"}`
    : gpsStatus === "searching" || gpsStatus === "checking"
      ? (en ? "Looking for GPS signal…" : "Шукаємо сигнал GPS…")
      : gpsStatus === "error"
        ? (en ? "Could not get your position" : "Не вдалося отримати координати")
        : (en ? "Location permission needed" : "Потрібен дозвіл на геолокацію");

  const alertLabel = alertError
    ? (en ? "Can't refresh the alert status" : "Не вдалося оновити статус тривоги")
    : !currentFix
      ? (en ? "Allow location to check your area" : "Дозвольте геолокацію, щоб перевірити район")
      : !alert
        ? (en ? "Checking your current area…" : "Перевіряємо ваш район…")
        : alert.active === null
          ? (en ? "The area could not be confirmed" : "Не вдалося підтвердити статус району")
          : alert.active
            ? (en ? "Air alert active in your area" : "У вашому районі повітряна тривога")
            : (en ? "No active air alert in your district" : "У вашому районі активної тривоги немає");

  const visiblePlaces = nearbyPlaces.filter((item) => {
    if (poiFilter === "all") return true;
    if (poiFilter === "safety") return item.category === "shelter" || item.category === "resilience";
    if (poiFilter === "fuel") return item.category === "fuel" || item.category === "charger";
    return ["shop", "pharmacy", "hospital", "transport", "food", "parking", "atm", "water", "toilets"].includes(item.category);
  });
  const safetyCount = nearbyPlaces.filter((item) => item.category === "shelter" || item.category === "resilience").length;
  const visibleThreatSummary = airThreatSummary?.region === alert?.region && airThreatSummary?.district === (alert?.district ?? "") ? airThreatSummary : null;
  const gpsUpdated = currentFix?.timestamp ? new Date(currentFix.timestamp).toLocaleTimeString(en ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <Animated.View style={{ opacity: brandOpacity, transform: [{ scale: brandScale }] }}><BrandMark size={46} /></Animated.View>
          <View style={styles.brandCopy}>
            <Text style={styles.brandName}>NAVIA</Text>
            <Text style={styles.brandTagline}>{en ? "YOUR SAFETY NAVIGATOR" : "ВАШ НАВІГАТОР БЕЗПЕКИ"}</Text>
          </View>
          <Pressable style={styles.headerButton} onPress={() => navigation.navigate("Settings")} accessibilityLabel={en ? "Open settings" : "Відкрити налаштування"}><Text style={styles.headerButtonText}>☷</Text></Pressable>
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{displayName.trim() ? (en ? `WELCOME, ${displayName.trim().toLocaleUpperCase()}` : `ВІТАЮ, ${displayName.trim().toLocaleUpperCase()}`) : (en ? "MOVE WITH CONFIDENCE" : "РУХАЙСЯ ВПЕВНЕНО")}</Text>
          <Text style={styles.headline}>{en ? "Where to?" : "Куди прямуємо?"}</Text>
          <Text style={styles.heroText}>{en ? "Live map, route guidance and safety information for your area." : "Жива мапа, маршрут і важлива інформація у вашому районі."}</Text>
          <Pressable style={styles.searchButton} onPress={openSearch} accessibilityRole="button">
            <View style={styles.searchGlyph}><Text style={styles.searchGlyphText}>⌕</Text></View>
            <Text style={styles.searchButtonText}>{en ? "Search a place or address" : "Пошук місця або адреси"}</Text>
            <Text style={styles.searchArrow}>↗</Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <View><Text style={styles.sectionTitle}>{en ? "LIVE MAP" : "ЖИВА МАПА"}</Text><Text style={styles.sectionCaption}>{currentFix ? (en ? "Centered on your GPS position" : "У центрі — ваше GPS-місце") : (en ? "Kyiv map preview · location not confirmed" : "Попередній перегляд Києва · GPS не підтверджено")}</Text></View>
          <Pressable onPress={() => currentFix && gpsFresh ? void refreshPlaces(currentFix, alert?.region, true) : void startGps(true)} style={styles.mapAction} accessibilityLabel={en ? "Refresh nearby places" : "Оновити місця поруч"}><Text style={styles.mapActionText}>↻</Text></Pressable>
        </View>
        <View style={styles.mapCard}>
          <MapLibreRouteView
            styleUrl={isDark ? config.mapStyleDarkUrl : config.mapStyleUrl}
            routeGeometry={[]}
            currentPosition={currentFix ? { lat: currentFix.lat, lon: currentFix.lon } : null}
            headingDeg={currentFix?.headingDeg ?? null}
            nearbyPlaces={visiblePlaces}
            isDark={isDark}
            isEnglish={en}
            positionQuality={gpsSignal === "stable" ? "good" : gpsSignal === "degraded" ? "degraded" : "lost"}
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <FilterChip label={en ? `Shelters · ${safetyCount}` : `Укриття · ${safetyCount}`} selected={poiFilter === "safety"} onPress={() => setPoiFilter("safety")} styles={styles} />
          <FilterChip label={en ? "Fuel & charging" : "Пальне й зарядки"} selected={poiFilter === "fuel"} onPress={() => setPoiFilter("fuel")} styles={styles} />
          <FilterChip label={en ? "Essentials" : "Потрібне поруч"} selected={poiFilter === "essentials"} onPress={() => setPoiFilter("essentials")} styles={styles} />
          <FilterChip label={en ? "Everything" : "Усе"} selected={poiFilter === "all"} onPress={() => setPoiFilter("all")} styles={styles} />
        </ScrollView>
        {!currentFix && <Pressable style={styles.locationHint} onPress={() => void startGps(true)}><Text style={styles.locationHintText}>{en ? "Enable GPS to show nearby places and check your local alert status →" : "Увімкніть GPS, щоб побачити точки поруч і статус тривоги у вашому районі →"}</Text></Pressable>}
        {currentFix && <>
          {refreshingPlaces && nearbyPlaces.length === 0 ? <View style={styles.placeStatus}><ActivityIndicator color={p.accent} /><Text style={styles.placeStatusText}>{en ? "Finding places around you…" : "Шукаємо місця поруч…"}</Text></View> : placesError ? <Pressable style={styles.locationHint} onPress={() => void refreshPlaces(currentFix, alert?.region, true)}><Text style={styles.locationHintText}>{en ? "Places could not load · tap to retry" : "Не вдалося завантажити місця · натисніть, щоб повторити"}</Text></Pressable> : <View style={styles.nearbyList}>
            {visiblePlaces.length === 0 ? <Text style={styles.placeStatusText}>{en ? "No places in this category were returned by the source." : "Джерело не повернуло точок цієї категорії поруч."}</Text> : visiblePlaces.slice(0, 4).map((place) => <Pressable key={place.id} style={styles.placeRow} onPress={() => openPlace(place)}>
              <View style={[styles.placeGlyph, { backgroundColor: placeColor(place.category) }]}><Text style={styles.placeGlyphText}>{placeGlyph(place.category)}</Text></View>
              <View style={styles.placeCopy}><Text numberOfLines={1} style={styles.placeName}>{place.name}</Text><Text numberOfLines={1} style={styles.placeMeta}>{Math.round(place.distanceM)} {en ? "m" : "м"}{place.address ? ` · ${place.address}` : ""}{place.openingHours ? ` · ${place.openingHours}` : ""}</Text></View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>)}
            {visiblePlaces.length > 0 && <Text style={styles.attributionNote}>{en ? "Places from OpenStreetMap and, in Kyiv, municipal open data. Availability may change." : "Місця з OpenStreetMap і міських відкритих даних Києва. Доступність перевіряйте на місці."}</Text>}
          </View>}
        </>}

        <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>{en ? "YOUR GPS" : "СИГНАЛ GPS"}</Text><Text style={styles.sectionCaption}>{gpsUpdated ? `${en ? "Last fix" : "Останнє вимірювання"} · ${gpsUpdated}` : (en ? "Device positioning" : "Позиціонування пристрою")}</Text></View></View>
        <Pressable style={styles.gpsCard} onPress={() => void startGps(true)}>
          <View style={[styles.gpsDot, gpsSignal === "stable" && styles.gpsDotStable, gpsSignal === "degraded" && styles.gpsDotDegraded, gpsSignal === "lost" && styles.gpsDotLost]}><Text style={[styles.gpsIcon, { color: gpsSignal === "lost" && gpsStatus === "ready" ? p.danger : gpsSignal === "degraded" ? p.warning : p.accent }]}>⌖</Text></View>
          <View style={styles.gpsCopy}><Text style={styles.gpsTitle}>{gpsLabel}</Text><Text style={styles.cardMeta}>{gpsStatus === "permission" ? (en ? "Tap to allow location" : "Натисніть, щоб дозволити доступ") : currentFix && !gpsFresh ? (en ? `Last fix · ${Math.round((Date.now() - currentFix.timestamp) / 1000)}s ago` : `Останній замір · ${Math.round((Date.now() - currentFix.timestamp) / 1000)} с тому`) : (en ? "Updates while NAVIA is open" : "Оновлюється, поки відкрита NAVIA")}</Text></View>
          {gpsStatus === "searching" || gpsStatus === "checking" ? <ActivityIndicator color={p.accent} /> : <Text style={styles.chevron}>›</Text>}
        </Pressable>

        <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>{en ? "AIR-RAID ALERT" : "СТАТУС ПОВІТРЯНОЇ ТРИВОГИ"}</Text><Text style={styles.sectionCaption}>{alert?.region ?? (en ? "Waiting for location" : "Очікуємо геолокацію")}</Text></View></View>
        <Pressable style={[styles.alertCard, alert?.active === true && styles.alertCardActive]} onPress={() => currentFix ? void refreshAlert(currentFix, true) : void startGps(true)} accessibilityRole="button">
          <View style={[styles.alertIcon, alert?.active === true && styles.alertIconActive]}><Text style={[styles.alertIconText, alert?.active === true && styles.alertIconTextActive]}>{alert?.active === true ? "!" : alert?.active === false ? "✓" : "?"}</Text></View>
          <View style={styles.alertCopy}>
            <Text style={styles.alertLocation}>{alert?.locationLabel?.toLocaleUpperCase(en ? "en-US" : "uk-UA") ?? (en ? "CURRENT LOCATION" : "ПОТОЧНЕ МІСЦЕ")}</Text>
            <Text style={[styles.alertStatus, alert?.active === true && styles.alertStatusActive]}>{alertLabel}</Text>
            {alert && <Text style={styles.cardMeta}>{alert.source} · {alert.updatedAt ? `${en ? "checked" : "перевірено"} ${formatTime(alert.updatedAt, en)}` : (en ? "update unavailable" : "час перевірки невідомий")}</Text>}
            {alert?.detail && <Text style={styles.cardMeta}>{localizeAlertDetail(alert.detail, en)}</Text>}
            {alertError && <Text style={styles.cardMeta}>{en ? "Tap to check again · follow the official siren" : "Натисніть, щоб повторити · стежте за офіційною сиреною"}</Text>}
          </View>
          {refreshingAlert ? <ActivityIndicator color={p.subtle} /> : <Text style={styles.chevron}>↻</Text>}
        </Pressable>
        <Text style={styles.safetyNote}>{en ? "Informational status. Keep official alert notifications enabled; NAVIA is not an emergency-warning system." : "Інформаційний статус. Не вимикайте офіційні сповіщення: NAVIA не замінює систему екстреного оповіщення."}</Text>
        {alert?.sourceUrl && <Pressable onPress={() => void Linking.openURL(alert.sourceUrl)}><Text style={styles.sourceLink}>{en ? "Open the data source ↗" : "Перевірити джерело даних ↗"}</Text></Pressable>}

        <AirThreatCard summary={visibleThreatSummary} region={alert?.region} english={en} styles={styles} onOpen={() => void Linking.openURL("https://neptun.in.ua/")} />

        <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>{en ? "YOUR CO-PILOT" : "ОСОБИСТИЙ ШТУРМАН"}</Text><Text style={styles.sectionCaption}>{en ? "Ready with live NAVIA context" : "Працює з поточними даними NAVIA"}</Text></View><NaviaAiMark size={40} /></View>
        <View style={styles.assistantCard}>
          <Text style={styles.assistantTitle}>{en ? `I'm here${displayName ? `, ${displayName}` : ""}. What do you need?` : `Я поруч${displayName ? `, ${displayName}` : ""}. Що підказати?`}</Text>
          <Text style={styles.assistantText}>{alert?.active === true ? (en ? "An alert is active in your area. I can help find the nearest listed shelter." : "У вашому районі тривога. Допоможу знайти найближче позначене укриття.") : currentFix?.accuracyM != null && currentFix.accuracyM > 50 ? (en ? "GPS accuracy is reduced. I'll be careful with position-based advice." : "Точність GPS знижена. Я враховуватиму невизначеність у підказках.") : (en ? "Ask about GPS, your route, the alert status or nearby essentials." : "Запитайте про GPS, маршрут, тривогу або корисні місця поруч.")}</Text>
          <View style={styles.assistantComposer}><TextInput value={question} onChangeText={setQuestion} placeholder={en ? "Ask your co-pilot…" : "Запитайте свого штурмана…"} placeholderTextColor={p.subtle} returnKeyType="send" onSubmitEditing={() => askNavia()} style={styles.assistantInput} accessibilityLabel={en ? "Ask the NAVIA co-pilot" : "Запитати штурмана NAVIA"} /><Pressable style={styles.assistantSend} onPress={() => askNavia()} accessibilityLabel={en ? "Send to NAVIA" : "Надіслати NAVIA"}><Text style={styles.assistantSendText}>↑</Text></Pressable></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.promptRow}>
            <AssistantPrompt label={en ? "GPS status?" : "Стан GPS?"} onPress={() => askNavia(en ? "GPS status?" : "Який стан GPS?")} styles={styles} />
            <AssistantPrompt label={en ? "Nearest shelter?" : "Де укриття?"} onPress={() => askNavia(en ? "Nearest shelter?" : "Де найближче укриття?")} styles={styles} />
            <AssistantPrompt label={en ? "Alert status?" : "Статус тривоги?"} onPress={() => askNavia(en ? "Alert status?" : "Який статус тривоги?")} styles={styles} />
          </ScrollView>
        </View>

        {recentDestinations.length > 0 && <View style={styles.recentSection}><View style={styles.sectionHeader}><Text style={styles.sectionTitle}>{en ? "RECENT PLACES" : "НЕДАВНІ МІСЦЯ"}</Text></View>{recentDestinations.map((item) => <Pressable key={`${item.lat},${item.lon},${item.visitedAt}`} style={styles.recentRow} onPress={() => { setDemoMode(false); navigation.navigate("Navigation", { destinationLat: item.lat, destinationLon: item.lon, destinationLabel: item.label }); }}><Text style={styles.recentPin}>⌖</Text><Text numberOfLines={1} style={styles.recentText}>{item.label}</Text><Text style={styles.chevron}>›</Text></Pressable>)}</View>}

        <View style={styles.bottomActions}>
          <Pressable style={styles.secondaryAction} onPress={() => void shareCurrentLocation()}><Text style={styles.secondaryActionIcon}>↗</Text><Text style={styles.secondaryActionText}>{en ? "Share location" : "Надіслати геолокацію"}</Text></Pressable>
          <Pressable style={styles.secondaryAction} onPress={startDemo}><Text style={styles.secondaryActionIcon}>▷</Text><Text style={styles.secondaryActionText}>{en ? "Try demo route" : "Спробувати демомаршрут"}</Text></Pressable>
        </View>
        <Text style={styles.footerNote}>{en ? "Open map data · Kyiv official safety places · live region status" : "Відкриті мапи · міські точки безпеки · актуальний статус району"}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function setThreatUnavailable(message: string, point: GNSSRawSample | null, region: string, district: string, setSummary: (summary: AirThreatSummary | null) => void): void {
  if (!point) return;
  setSummary({ state: "unavailable", region, district, count: 0, advisoryCount: 0, threatKinds: [], confidence: "unknown", checkedAt: Date.now(), source: "NEPTUN", sourceUrl: "https://neptun.in.ua/", detail: message });
}

function AirThreatCard({ summary, region, english, styles, onOpen }: { summary: AirThreatSummary | null; region?: string; english: boolean; styles: ReturnType<typeof makeStyles>; onOpen: () => void }): JSX.Element {
  const kindNames: Record<string, [string, string]> = {
    uav: ["БпЛА", "UAVs"], fpv: ["FPV-дрони", "FPV drones"], recon: ["розвіддрони", "recon drones"], kab: ["КАБ", "guided bombs"],
    cruise_missile: ["крилаті ракети", "cruise missiles"], ballistic_missile: ["балістичні ракети", "ballistic missiles"],
    missile: ["ракетні загрози", "missile reports"], aircraft: ["авіація", "aircraft"], other: ["інші загрози", "other reports"],
  };
  const kinds = summary?.threatKinds.map((kind) => kindNames[kind]?.[english ? 1 : 0] ?? kind).join(", ");
  const title = !summary
    ? (english ? "Checking regional threat reports…" : "Перевіряємо повідомлення в області…")
    : summary.state === "unavailable"
      ? (english ? "Regional threat reports unavailable" : "Повідомлення про повітряні загрози недоступні")
    : summary.state === "none"
      ? (english ? "No recent regional reports" : "Свіжих повідомлень у регіоні немає")
      : summary.state === "advisory"
        ? (english ? `Observation only · ${kinds || "air activity"}` : `Лише спостереження · ${kinds || "повітряна активність"}`)
        : (english ? `Regional reports: ${kinds || "air threats"}` : `Повідомлення в області: ${kinds || "повітряні загрози"}`);
  const confidence = summary?.confidence && summary.confidence !== "unknown"
    ? (english ? summary.confidence + " source confidence" : "впевненість джерела: " + summary.confidence)
    : "";
  const meta = summary?.checkedAt
    ? [summary.source, (english ? "checked " : "перевірено ") + formatTime(summary.checkedAt, english), summary.district || region || "", summary.count ? summary.count + (english ? " reports" : " повідомлень") : "", summary.advisoryCount ? summary.advisoryCount + (english ? " observations, not warnings" : " спостережень, не тривог") : "", confidence].filter(Boolean).join(" · ")
    : (english ? "Waiting for your location" : "Очікуємо геолокацію");
  return <>
    <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>{english ? "AIR-THREAT REPORTS" : "ПОВІДОМЛЕННЯ ПРО ПОВІТРЯНІ ЗАГРОЗИ"}</Text><Text style={styles.sectionCaption}>{english ? "Regional, approximate and attributed" : "Регіональні, приблизні, з указаним джерелом"}</Text></View></View>
    <Pressable style={styles.threatCard} onPress={onOpen}>
      <View style={[styles.threatMark, summary?.state === "reported" && styles.threatMarkReported, summary?.state === "advisory" && styles.threatMarkAdvisory]}><Text style={styles.threatMarkText}>{summary?.state === "reported" ? "!" : summary?.state === "advisory" ? "i" : summary?.state === "none" ? "·" : "?"}</Text></View>
      <View style={styles.alertCopy}><Text style={styles.threatTitle}>{title}</Text><Text style={styles.cardMeta}>{meta}</Text><Text style={styles.sourceLink}>{english ? "Open NEPTUN source ↗" : "Відкрити джерело NEPTUN ↗"}</Text></View>
    </Pressable>
    <Text style={styles.safetyNote}>{english ? "This is a community-aggregated report, not radar detection. It may be delayed or wrong. No report does not mean an area is safe. Follow official alerts and sirens." : "Це повідомлення інформаційного агрегатора, а не дані радара. Можливі затримки й помилки; відсутність повідомлень не означає безпеку. Дотримуйтеся офіційних тривог і сигналів сирени."}</Text>
  </>;
}

function FilterChip({ label, selected, onPress, styles }: { label: string; selected: boolean; onPress: () => void; styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return <Pressable onPress={onPress} style={[styles.filterChip, selected && styles.filterChipSelected]}><Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>{label}</Text></Pressable>;
}

function AssistantPrompt({ label, onPress, styles }: { label: string; onPress: () => void; styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return <Pressable style={styles.assistantPrompt} onPress={onPress}><Text style={styles.assistantPromptText}>{label}</Text></Pressable>;
}

function formatTime(value: number, english: boolean): string {
  return new Date(value).toLocaleTimeString(english ? "en-GB" : "uk-UA", { hour: "2-digit", minute: "2-digit" });
}

function localizeAlertDetail(detail: string, english: boolean): string {
  if (!english) return detail;
  if (detail.includes("район за GPS")) return "The GPS district could not be confirmed, so the source cannot confirm that there is no alert here.";
  if (detail.includes("Статус для цього місця")) return "The source cannot confirm alert status for this location.";
  return detail;
}

function placeGlyph(category: NearbyPlaceCategory): string {
  switch (category) {
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
    case "food": return "•";
    default: return "•";
  }
}

function placeColor(category: NearbyPlaceCategory): string {
  if (category === "shelter") return "#c53a53";
  if (category === "resilience") return "#c27c11";
  if (category === "fuel" || category === "charger") return "#346bda";
  if (category === "hospital" || category === "pharmacy") return "#16836e";
  if (category === "police" || category === "fire") return "#ba4542";
  return "#556f82";
}

function makeStyles(p: ReturnType<typeof useAppSettings>["palette"], isDark: boolean) {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: p.background }, content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 34 },
    brandRow: { flexDirection: "row", alignItems: "center", marginBottom: 17, gap: 11 }, brandCopy: { flex: 1 },
    brandName: { color: p.text, fontSize: 17, fontWeight: "900", letterSpacing: 2.3 }, brandTagline: { color: p.subtle, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
    headerButton: { width: 40, height: 40, borderRadius: 14, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, alignItems: "center", justifyContent: "center" }, headerButtonText: { color: p.text, fontSize: 20, fontWeight: "700" },
    hero: { marginBottom: 20 }, eyebrow: { color: p.accent, fontSize: 10, fontWeight: "900", letterSpacing: 1, marginBottom: 6 }, headline: { ...typography.display, color: p.text }, heroText: { color: p.muted, fontSize: 14, lineHeight: 20, marginTop: 4, marginBottom: 13 },
    searchButton: { minHeight: 53, borderRadius: 17, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 10 }, searchGlyph: { width: 33, height: 33, borderRadius: 11, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, searchGlyphText: { color: p.accent, fontSize: 25, lineHeight: 29 }, searchButtonText: { color: p.muted, fontSize: 13, fontWeight: "600", flex: 1 }, searchArrow: { color: p.accent, fontSize: 19, paddingHorizontal: 5 },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 9, marginTop: 5 }, sectionTitle: { color: p.text, fontSize: 13, fontWeight: "900", letterSpacing: 0.6 }, sectionCaption: { color: p.subtle, fontSize: 11, lineHeight: 15, marginTop: 3 },
    mapAction: { width: 36, height: 36, borderRadius: 13, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, alignItems: "center", justifyContent: "center" }, mapActionText: { color: p.accent, fontSize: 21 }, mapCard: { height: 280, borderRadius: 22, overflow: "hidden", borderWidth: 1, borderColor: p.border, backgroundColor: p.surfaceRaised },
    filterRow: { gap: 7, paddingVertical: 10 }, filterChip: { borderRadius: 13, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, paddingHorizontal: 11, paddingVertical: 8 }, filterChipSelected: { backgroundColor: p.accent, borderColor: p.accent }, filterChipText: { color: p.muted, fontSize: 11, fontWeight: "700" }, filterChipTextSelected: { color: p.accentText },
    locationHint: { backgroundColor: p.surfaceRaised, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 12 }, locationHintText: { color: p.accent, fontSize: 12, fontWeight: "700", lineHeight: 17 }, placeStatus: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 8 }, placeStatusText: { color: p.subtle, fontSize: 12, lineHeight: 17 }, nearbyList: { backgroundColor: p.surface, borderRadius: 17, borderWidth: 1, borderColor: p.border, overflow: "hidden", marginBottom: 14 }, placeRow: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border }, placeGlyph: { width: 31, height: 31, borderRadius: 11, alignItems: "center", justifyContent: "center", marginRight: 10 }, placeGlyphText: { color: "#fff", fontSize: 11, fontWeight: "900" }, placeCopy: { flex: 1 }, placeName: { color: p.text, fontSize: 13, fontWeight: "700" }, placeMeta: { color: p.subtle, fontSize: 10, marginTop: 3 }, chevron: { color: p.subtle, fontSize: 22, paddingHorizontal: 3 }, attributionNote: { color: p.subtle, fontSize: 10, lineHeight: 14, paddingHorizontal: 11, paddingVertical: 7 },
    gpsCard: { minHeight: 72, borderRadius: 17, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 14 }, gpsDot: { width: 38, height: 38, borderRadius: 13, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, gpsDotStable: { backgroundColor: isDark ? "#173d37" : "#dff4ed" }, gpsDotDegraded: { backgroundColor: isDark ? "#49391f" : "#fff0d3" }, gpsDotLost: { backgroundColor: isDark ? "#49252b" : "#fde7e9" }, gpsIcon: { fontSize: 22, fontWeight: "700" }, gpsCopy: { flex: 1, marginLeft: 10 }, gpsTitle: { color: p.text, fontSize: 14, fontWeight: "700" }, cardMeta: { color: p.subtle, fontSize: 10, lineHeight: 14, marginTop: 4 },
    alertCard: { minHeight: 91, borderRadius: 18, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12 }, alertCardActive: { backgroundColor: isDark ? "#351c27" : "#fff1f2", borderColor: p.danger }, alertIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, alertIconActive: { backgroundColor: p.danger }, alertIconText: { color: p.accent, fontSize: 19, fontWeight: "900" }, alertIconTextActive: { color: "#fff" }, alertCopy: { flex: 1, marginLeft: 10 }, alertLocation: { color: p.subtle, fontSize: 10, fontWeight: "800", letterSpacing: 0.7 }, alertStatus: { color: p.text, fontSize: 14, lineHeight: 18, fontWeight: "800", marginTop: 3 }, alertStatusActive: { color: p.danger }, safetyNote: { color: p.subtle, fontSize: 10, lineHeight: 14, marginTop: 7, paddingHorizontal: 2 }, sourceLink: { color: p.accent, fontSize: 11, fontWeight: "800", marginTop: 5 },
    threatCard: { minHeight: 80, borderRadius: 17, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, flexDirection: "row", alignItems: "center", padding: 11 }, threatMark: { width: 36, height: 36, borderRadius: 13, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, threatMarkReported: { backgroundColor: p.warning }, threatMarkAdvisory: { backgroundColor: p.surfaceRaised }, threatMarkText: { color: p.text, fontSize: 17, fontWeight: "900" }, threatTitle: { color: p.text, fontSize: 11, fontWeight: "800", lineHeight: 15 },
    assistantCard: { borderRadius: 20, padding: 14, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border }, assistantTitle: { color: p.text, fontSize: 16, fontWeight: "800" }, assistantText: { color: p.muted, fontSize: 13, lineHeight: 18, marginTop: 5 }, assistantComposer: { minHeight: 48, borderRadius: 14, backgroundColor: p.field, borderWidth: 1, borderColor: p.border, marginTop: 11, paddingLeft: 11, paddingRight: 5, flexDirection: "row", alignItems: "center" }, assistantInput: { color: p.text, fontSize: 14, flex: 1, minWidth: 0, paddingVertical: 9 }, assistantSend: { width: 35, height: 35, borderRadius: 11, backgroundColor: p.accent, alignItems: "center", justifyContent: "center" }, assistantSendText: { color: p.accentText, fontSize: 19, fontWeight: "900" }, promptRow: { gap: 6, paddingTop: 8 }, assistantPrompt: { borderRadius: 12, borderWidth: 1, borderColor: p.border, paddingHorizontal: 9, paddingVertical: 7 }, assistantPromptText: { color: p.muted, fontSize: 10, fontWeight: "700" },
    recentSection: { marginTop: 18 }, recentRow: { minHeight: 46, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border }, recentPin: { color: p.accent, fontSize: 18, marginRight: 10 }, recentText: { color: p.text, flex: 1, fontSize: 11 }, bottomActions: { flexDirection: "row", gap: 8, marginTop: 17 }, secondaryAction: { flex: 1, minHeight: 45, borderRadius: 14, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }, secondaryActionIcon: { color: p.accent, fontSize: 15, fontWeight: "800" }, secondaryActionText: { color: p.text, fontSize: 8, fontWeight: "700" }, footerNote: { color: p.subtle, fontSize: 8, textAlign: "center", lineHeight: 12, marginTop: 16 },
  });
}
