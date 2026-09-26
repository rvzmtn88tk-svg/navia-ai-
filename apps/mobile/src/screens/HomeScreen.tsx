// Map-first home: full-screen map with the NAVIA position puck, search on
// top, category chips, floating map controls and a draggable bottom sheet with
// GPS health, the local air-alert status, the co-pilot and saved places.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList, RouteMode } from "../navigation/RootNavigator";
import { DEMO_DESTINATION, destinationPoint } from "@navia/core";
import { useNaviaStore } from "../engine/naviaController";
import { useLiveContext, type GnssHealth, type GpsStatus } from "../engine/useLiveContext";
import { useAppSettings, type MapLayer } from "../settings/AppSettings";
import { usePlacesStore, placeId, type PlaceRef } from "../store/placesStore";
import { CATEGORY_META, CHIP_CATEGORIES, nearestShelter, type ChipCategory } from "../places/categories";
import type { NearbyPlace, NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";
import type { AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import { NaviaMap, type CameraMode, type NaviaMapHandle } from "../map/NaviaMap";
import { layerAvailable, useMapStyle } from "../map/mapStyles";
import { BottomSheet, type SheetSnap } from "../components/BottomSheet";
import { Crossfade } from "../components/Crossfade";
import { BrandMark } from "../components/BrandMark";
import { AlertStatus, alertBeaconTone, alertHeadline, type AlertTone } from "../components/AlertStatus";
import { SafetyPanel } from "../components/SafetyPanel";
import { useCopilotWorld } from "../ai/useCopilotWorld";
import { useCopilotActions } from "../ai/useCopilotActions";
import { proactiveInsights, suggestions } from "../ai/copilotBrain";
import { StatusBeacons } from "../components/StatusBeacons";
import { gpsTone } from "../engine/liveStatus";
import { gnssTrendReasons } from "../engine/gnssWords";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { Icon, type IconName } from "../components/Icon";
import { Button, Card, Chip, Divider, IconButton, ListRow, SectionLabel, Segmented, Text, TextField, Touchable, useColors } from "../components/ui";
import { formatClock, formatDistance, useT, type Translate } from "../i18n";
import { elevation, iconSize, radius, space, type ThemeColors } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

type SelectedPlace = PlaceRef & { category?: NearbyPlaceCategory; hours?: string; source?: string; distanceM?: number };

const SEARCH_H = 52;
const CHIPS_H = 36;
const PEEK_H = 100;

export function HomeScreen({ navigation, route }: Props): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const { isDark, mapLayer, setMapLayer } = useAppSettings();
  const live = useLiveContext();
  const fix = useNaviaStore((s) => s.currentFix);
  const alert = useNaviaStore((s) => s.alert);
  const threat = useNaviaStore((s) => s.airThreatSummary);
  const setDemoMode = useNaviaStore((s) => s.setDemoMode);
  const { home, work, recents, load: loadPlaces, saveCustom, custom } = usePlacesStore();

  const map = useRef<NaviaMapHandle>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");
  const [bearing, setBearing] = useState(0);
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [category, setCategory] = useState<ChipCategory | null>(null);
  const [selected, setSelected] = useState<SelectedPlace | null>(null);
  const [routeMode, setRouteMode] = useState<RouteMode>("car");
  const [layersOpen, setLayersOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [styleRetry, setStyleRetry] = useState(0);
  const sheetVisible = useRef(new Animated.Value(PEEK_H + insets.bottom)).current;
  const style = useMapStyle(mapLayer, isDark, styleRetry);
  const halfSheetHeight = Math.round(screenH * 0.48);

  useEffect(() => { void loadPlaces(); }, [loadPlaces]);

  // A place picked in Search arrives as a route param.
  useEffect(() => {
    const focus = route.params?.focusPlace;
    if (!focus) return;
    setCategory(null);
    setSelected(focus);
    setSnap("half");
    focusOn(focus, 16);
    navigation.setParams({ focusPlace: undefined });
  }, [navigation, route.params?.focusPlace]);

  // The co-pilot's "Safety" button.
  useEffect(() => {
    if (!route.params?.openSafety) return;
    openSafety(true);
    navigation.setParams({ openSafety: undefined });
  }, [navigation, route.params?.openSafety]); // eslint-disable-line react-hooks/exhaustive-deps

  const user = useMemo(() => fix ? { lat: fix.lat, lon: fix.lon, headingDeg: fix.headingDeg, accuracyM: fix.accuracyM } : null, [fix]);
  const categoryEntry = category ? live.byCategory[category] : undefined;
  const categoryPlaces = useMemo(() => categoryEntry?.places ?? [], [categoryEntry]);
  const shelter = nearestShelter(live.byCategory.shelter?.places ?? []);
  const alertActive = alert?.active === true;

  // Leave follow mode first, then fly on the next frame, so a GPS update in
  // between cannot pull the camera back to the user.
  const focusOn = useCallback((point: { lat: number; lon: number }, zoom: number) => {
    setCameraMode("free");
    setTimeout(() => map.current?.flyTo(point, zoom, halfSheetHeight), 60);
  }, [halfSheetHeight]);

  const openPlace = useCallback((place: NearbyPlace) => {
    setSelected({
      id: place.id, label: place.name, subtitle: place.address, lat: place.location.lat, lon: place.location.lon,
      category: place.category, hours: place.openingHours, source: place.source, distanceM: place.distanceM,
    });
    setSnap("half");
    focusOn(place.location, 16.5);
  }, [focusOn]);


  function setCategoryRadius(radiusM: number | null) {
    if (!category) return;
    framedCategory.current = null;
    void live.loadCategory(category, true, radiusM);
  }

  function selectCategory(next: ChipCategory) {
    setSelected(null);
    if (category === next) { setCategory(null); setSnap("peek"); return; }
    setCategory(next);
    setSnap("half");
    void live.loadCategory(next);
  }

  // A chosen radius: frame the whole search circle.
  const circleRadius = categoryEntry?.radiusM ?? null;
  useEffect(() => {
    if (!category || circleRadius == null || !fix) return;
    const c0 = { lat: fix.lat, lon: fix.lon };
    setCameraMode("free");
    map.current?.fitPoints([0, 90, 180, 270].map((b) => destinationPoint(c0, b, circleRadius)), halfSheetHeight);
  }, [category, circleRadius]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame the user and the nearest results once a category has loaded.
  const framedCategory = useRef<string | null>(null);
  useEffect(() => {
    if (!category || categoryPlaces.length === 0 || framedCategory.current === category || circleRadius != null) return;
    framedCategory.current = category;
    const nearby = categoryPlaces.slice(0, 8).map((p) => p.location);
    setCameraMode("free");
    map.current?.fitPoints(fix ? [{ lat: fix.lat, lon: fix.lon }, ...nearby] : nearby, halfSheetHeight);
  }, [category, categoryPlaces]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!category) framedCategory.current = null; }, [category]);

  function startRoute(place: PlaceRef, mode: RouteMode) {
    setDemoMode(false);
    usePlacesStore.getState().addRecent(place);
    navigation.navigate("Navigation", { destinationLat: place.lat, destinationLon: place.lon, destinationLabel: place.label, mode });
  }

  function openSafety(next: boolean) {
    setSafetyOpen(next);
    if (next) { void live.loadCategory("shelter"); void live.loadCategory("resilience"); }
  }

  function askCopilot(text?: string, voice?: boolean) {
    const initialQuestion = (text ?? question).trim();
    setQuestion("");
    navigation.navigate("Assistant", { initialQuestion: initialQuestion || undefined, voice });
  }

  function closeContext() {
    setSelected(null);
    setCategory(null);
    setSnap("peek");
  }

  const fullTop = insets.top + space.xs + SEARCH_H + space.xs;
  const controlsBottom = Animated.add(sheetVisible, space.md);
  // Floating controls step aside once the sheet grows past half height.
  const controlsOpacity = sheetVisible.interpolate({ inputRange: [halfSheetHeight + space.lg, halfSheetHeight + space.xxl * 2], outputRange: [1, 0], extrapolate: "clamp" });
  const cameraPadding = useMemo(() => ({ top: fullTop + CHIPS_H, bottom: PEEK_H + insets.bottom }), [fullTop, insets.bottom]);

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      {style.status === "ready" ? (
        <NaviaMap
          ref={map}
          mapStyle={style.style}
          user={user}
          quality={live.health === "stable" ? "good" : live.health === "unstable" ? "degraded" : "lost"}
          cameraMode={cameraMode}
          onUserGesture={() => setCameraMode("free")}
          onBearingChange={setBearing}
          places={categoryPlaces}
          searchCircle={categoryEntry?.radiusM != null && fix ? { center: { lat: fix.lat, lon: fix.lon }, radiusM: categoryEntry.radiusM } : null}
          speedMps={fix?.speedMps ?? null}
          selectedPlaceId={selected?.id}
          onPlacePress={openPlace}
          destination={selected && !selected.category ? selected : null}
          padding={cameraPadding}
          onMapError={() => setStyleRetry((n) => n + 1)}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.mapState, { backgroundColor: c.surfaceMuted }]}>
          {style.status === "unavailable" && <Text variant="callout" color="secondary">{style.reason === "needsKey" ? t("layers.needsKey") : t("route.failedHint")}</Text>}
        </View>
      )}

      {/* Search + chips */}
      <View style={[styles.top, { paddingTop: insets.top + space.xs }]} pointerEvents="box-none">
        <View style={styles.searchRow}>
          <Touchable accessibilityRole="search" accessibilityLabel={t("home.searchPlaceholder")} onPress={() => navigation.navigate("Search")}
            style={[styles.search, { backgroundColor: c.surfaceElevated }, elevation(2, c)]}>
            <BrandMark size={28} />
            <Text variant="body" color="secondary" style={styles.searchText} numberOfLines={1}>{t("home.searchPlaceholder")}</Text>
            <Icon name="search" size={iconSize.md} color={c.textMuted} />
          </Touchable>
          <IconButton icon="user" label={t("home.openSettings")} onPress={() => navigation.navigate("Settings")} size={SEARCH_H} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipsScroll}>
          {CHIP_CATEGORIES.map((cat) => (
            <Chip key={cat} label={t(CATEGORY_META[cat].label)} icon={CATEGORY_META[cat].icon} tint={CATEGORY_META[cat].color}
              selected={category === cat} onPress={() => selectCategory(cat)} />
          ))}
        </ScrollView>
        <StatusBeacons gpsStatus={live.gpsStatus} health={live.health} alert={alert} style={styles.beacons}
          onPressGps={() => setSnap("half")} onPressAlert={() => setSnap("half")} />
        {Math.abs(bearing) > 1 && (
          <View style={styles.compassRow} pointerEvents="box-none">
            <Touchable accessibilityRole="button" accessibilityLabel="N" onPress={() => map.current?.resetNorth()}
              style={[styles.compass, { backgroundColor: c.surfaceElevated }, elevation(2, c), { transform: [{ rotate: `${-bearing}deg` }] }]}>
              <Icon name="compass" size={iconSize.lg} color={c.critical} />
            </Touchable>
          </View>
        )}
      </View>

      {/* Floating controls above the sheet */}
      <Animated.View style={[styles.rightRail, { bottom: controlsBottom, opacity: controlsOpacity }]} pointerEvents={snap === "full" ? "none" : "box-none"}>
        <Touchable accessibilityRole="button" accessibilityLabel={t("copilot.title")} onPress={() => askCopilot("", true)}
          style={[styles.copilotFab, { backgroundColor: c.surfaceElevated, borderColor: c.brandTeal }, elevation(3, c)]}>
          <NaviaAiMark size={40} />
        </Touchable>
        <IconButton icon="layers" label={t("home.layers")} onPress={() => setLayersOpen(true)} />
        <IconButton icon={cameraMode === "free" ? "locate" : "locateFilled"} label={t("home.locate")}
          onPress={() => { if (!fix) void live.requestPermission(); setCameraMode("follow"); map.current?.recenter(); }} />
      </Animated.View>
      {alertActive && shelter && !selected && (
        <Animated.View style={[styles.leftRail, { bottom: controlsBottom, opacity: controlsOpacity }]} pointerEvents={snap === "full" ? "none" : "box-none"}>
          <Button label={t("home.nearestShelter")} icon="shelter" variant="critical"
            onPress={() => startRoute({ id: shelter.id, label: shelter.name, lat: shelter.location.lat, lon: shelter.location.lon }, "walk")} />
        </Animated.View>
      )}

      <BottomSheet snap={snap} onSnapChange={setSnap} peekHeight={PEEK_H} fullTop={fullTop} visibleHeight={sheetVisible}
        header={selected ? <PlaceHeader place={selected} t={t} lang={lang} onClose={closeContext} />
          : category ? <CategoryHeader category={category} count={categoryPlaces.length} radiusM={categoryEntry?.radiusM ?? null} loading={categoryEntry?.state === "loading"} onRadius={setCategoryRadius} t={t} lang={lang} onClose={closeContext} />
            : <View style={[styles.savedRow, styles.savedHeader]}>
                <SavedTile icon="home" label={t("saved.home")} place={home} onPress={() => home ? startRoute(home, "car") : navigation.navigate("Search", { pickFor: "home" })} />
                <SavedTile icon="work" label={t("saved.work")} place={work} onPress={() => work ? startRoute(work, "car") : navigation.navigate("Search", { pickFor: "work" })} />
              </View>}
      >
        <ScrollView
          contentContainerStyle={styles.sheetContent}
          scrollEnabled={snap !== "peek"}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={live.refreshing} onRefresh={() => void live.refresh()} tintColor={c.accent} />}
        >
          {selected ? (
            <PlaceBody place={selected} t={t} mode={routeMode} onMode={setRouteMode} onRoute={() => startRoute(selected, routeMode)}
              saved={[home, work, ...custom].some((p) => p?.id === selected.id)} onSave={() => saveCustom({ id: selected.id || placeId(selected.lat, selected.lon), label: selected.label, subtitle: selected.subtitle, lat: selected.lat, lon: selected.lon })} />
          ) : category ? (
            <CategoryList places={categoryPlaces} state={categoryEntry?.state ?? "loading"} unavailable={categoryEntry?.unavailable ?? []} usedOffline={!!categoryEntry?.usedOffline} t={t} lang={lang} onPick={openPlace} onRetry={() => category && void live.loadCategory(category, true)} />
          ) : (
            <>
              <GpsCard gpsStatus={live.gpsStatus} health={live.health} accuracyM={fix?.accuracyM ?? null} fixAt={fix?.timestamp ?? null} t={t} lang={lang}
                onAllow={() => void live.requestPermission()} onRefresh={() => void live.refresh()} />
              <AlertStatus alert={alert} threat={threat} loading={live.alertState === "loading"} />
              <CopilotCard question={question} onChange={setQuestion} onSend={() => askCopilot()} onVoice={() => askCopilot("", true)} onPrompt={(q) => askCopilot(q)} t={t} />
              {custom.slice(0, 5).map((p) => <ListRow key={p.id} icon="star" title={p.label} subtitle={p.subtitle} onPress={() => { setSelected(p); setSnap("half"); focusOn(p, 16); }} />)}
              {recents.length > 0 && <SectionLabel style={styles.sectionGap}>{t("recent.title")}</SectionLabel>}
              {recents.slice(0, 5).map((p, i) => <View key={p.id}>
                {i > 0 && <Divider inset={52} />}
                <ListRow icon="clock" iconTint={c.textSecondary} title={p.label} subtitle={p.subtitle} onPress={() => { setSelected(p); setSnap("half"); focusOn(p, 16); }} />
              </View>)}
              <Pressable onPress={() => navigation.navigate("Sources")} accessibilityRole="link" style={styles.sources}>
                <Icon name="info" size={iconSize.sm} color={c.textMuted} />
                <Text variant="caption" color="muted">{t("home.sources")} · © OpenStreetMap</Text>
              </Pressable>
              {__DEV__ && <Text variant="caption" color="accent" style={styles.demoLink} onPress={() => {
                setDemoMode(true);
                navigation.navigate("Navigation", { destinationLat: DEMO_DESTINATION.lat, destinationLon: DEMO_DESTINATION.lon, destinationLabel: `Бориспіль (${t("common.demo")})` });
              }}>{t("common.demo")} ▸</Text>}
            </>
          )}
        </ScrollView>
      </BottomSheet>

      <SafetyPanel open={safetyOpen} onOpenChange={openSafety} alert={alert} threat={threat} alertLoading={live.alertState === "loading"}
        shelters={live.byCategory.shelter?.places ?? []} resilience={live.byCategory.resilience?.places ?? []}
        sheltersLoading={live.byCategory.shelter?.state !== "ready" && live.byCategory.shelter?.state !== "error"}
        position={fix ? { lat: fix.lat, lon: fix.lon } : null}
        onRoute={(p) => { setSafetyOpen(false); startRoute({ id: p.id, label: p.name, lat: p.location.lat, lon: p.location.lon }, "walk"); }} />
      <LayersModal open={layersOpen} value={mapLayer} onClose={() => setLayersOpen(false)} onPick={(layer) => { setMapLayer(layer); setLayersOpen(false); }} t={t} c={c} />
    </View>
  );
}

// ——— Sheet headers ———

const RADII: (number | null)[] = [null, 500, 1000, 3000, 5000, 10000];

function CategoryHeader({ category, count, radiusM, loading, onRadius, t, lang, onClose }: {
  category: ChipCategory; count: number; radiusM: number | null; loading: boolean; onRadius: (r: number | null) => void; t: Translate; lang: "uk" | "en"; onClose: () => void;
}): JSX.Element {
  const title = radiusM == null
    ? t("category.nearbyCount", { category: t(CATEGORY_META[category].label), count })
    : t("category.inRadius", { category: t(CATEGORY_META[category].label), count, radius: formatDistance(radiusM, lang) });
  return (
    <View style={styles.categoryHeader}>
      <View style={styles.contextHeaderRow}>
        <Text variant="title" style={styles.flex} numberOfLines={2}>{loading ? t(CATEGORY_META[category].label) : title}</Text>
        <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={onClose} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.radiusRow}>
        {RADII.map((r) => (
          <Chip key={String(r)} label={r == null ? t("category.radiusAuto") : formatDistance(r, lang)} selected={r === radiusM} onPress={() => onRadius(r)} />
        ))}
      </ScrollView>
    </View>
  );
}

function PlaceHeader({ place, t, lang, onClose }: { place: SelectedPlace; t: Translate; lang: "uk" | "en"; onClose: () => void }): JSX.Element {
  const meta = place.category ? CATEGORY_META[place.category] : null;
  return (
    <View style={styles.contextHeader}>
      <View style={styles.flex}>
        <Text variant="title" numberOfLines={2}>{place.label}</Text>
        <View style={styles.metaRow}>
          {meta && <Text variant="subhead" style={{ color: meta.color }}>{t(meta.label)}</Text>}
          {place.distanceM != null && <Text variant="subhead" color="secondary">{t("place.distance", { distance: formatDistance(place.distanceM, lang) })}</Text>}
          {!meta && place.subtitle ? <Text variant="subhead" color="secondary" numberOfLines={1}>{place.subtitle}</Text> : null}
        </View>
      </View>
      <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={onClose} />
    </View>
  );
}

// ——— Sheet bodies ———

function PlaceBody({ place, t, mode, onMode, onRoute, saved, onSave }: {
  place: SelectedPlace; t: Translate; mode: RouteMode; onMode: (m: RouteMode) => void; onRoute: () => void; saved: boolean; onSave: () => void;
}): JSX.Element {
  return (
    <View style={styles.stack}>
      <Segmented<RouteMode> value={mode} onChange={onMode} options={[{ value: "car", label: t("route.car") }, { value: "walk", label: t("route.walk") }]} />
      <View style={styles.buttonRow}>
        <Button label={t("place.route")} icon="route" onPress={onRoute} style={styles.flex} />
        <Button label={saved ? t("saved.saved") : t("place.save")} icon="star" variant="secondary" disabled={saved} onPress={onSave} />
      </View>
      {place.category && place.subtitle && place.subtitle !== place.label ? <Text variant="callout" color="secondary">{place.subtitle}</Text> : null}
      {place.hours ? <Text variant="callout" color="secondary">{t("place.hours", { hours: place.hours })}</Text> : null}
      {place.category === "shelter" || place.category === "resilience" ? <Text variant="caption" color="muted">{t("place.unverified")}</Text> : null}
    </View>
  );
}

function CategoryList({ places, state, unavailable, usedOffline, t, lang, onPick, onRetry }: { places: NearbyPlace[]; state: string; unavailable: string[]; usedOffline: boolean; t: Translate; lang: "uk" | "en"; onPick: (p: NearbyPlace) => void; onRetry: () => void }): JSX.Element {
  if (places.length === 0) {
    return (
      <View style={styles.empty}>
        <Text variant="callout" color="secondary">{state === "error" ? t("category.error") : state === "loading" || state === "idle" ? t("category.loading") : t("category.none")}</Text>
        {state === "error" && <Text variant="bodyStrong" color="accent" onPress={onRetry}>{t("common.retry")}</Text>}
      </View>
    );
  }
  const shown = places.slice(0, 100);
  return <>
    {unavailable.length > 0 && <Text variant="caption" color="warning" style={styles.moreNote}>{usedOffline ? t("category.offlineUsed", { sources: unavailable.join(", ") }) : t("category.partial", { sources: unavailable.join(", ") })}</Text>}
    {shown.map((p, i) => (
      <View key={p.id}>
        {i > 0 && <Divider inset={52} />}
        <ListRow icon={CATEGORY_META[p.category].icon} iconTint={CATEGORY_META[p.category].color} title={p.name}
          subtitle={[formatDistance(p.distanceM, lang), p.address && p.address !== p.name ? p.address : null, placeSourceLabel(p, t)].filter(Boolean).join(" · ")} onPress={() => onPick(p)} />
      </View>
    ))}
    {places.length > shown.length && <Text variant="caption" color="muted" style={styles.moreNote}>{t("category.shownOf", { shown: shown.length, total: places.length })}</Text>}
  </>;
}

/** "КМДА · онлайн", "OpenStreetMap · онлайн", "Бучанська міська рада · офлайн". */
function placeSourceLabel(p: NearbyPlace, t: Translate): string {
  const who = p.source === "Kyiv City open data" ? "КМДА" : p.source === "data.gov.ua" ? (p.sourceDetail?.split(" · ")[0] ?? "data.gov.ua") : "OpenStreetMap";
  return `${who} · ${t(`place.origin.${p.origin}` as Parameters<Translate>[0])}`;
}

function GpsCard({ gpsStatus, health, accuracyM, fixAt, t, lang, onAllow, onRefresh }: {
  gpsStatus: GpsStatus; health: GnssHealth; accuracyM: number | null; fixAt: number | null; t: Translate; lang: "uk" | "en"; onAllow: () => void; onRefresh: () => void;
}): JSX.Element {
  const c = useColors();
  const g = gpsTone(gpsStatus, health);
  const trend = useNaviaStore((s) => s.state.gnssTrend);
  const warning = health === "unstable" && trend?.level === "degrading" ? `${t("gps.warnDegrading")}: ${gnssTrendReasons(trend, t)}.` : null;
  const explain = gpsStatus !== "ready" ? null : health === "stable" ? t("gps.explainStable") : health === "unstable" ? (warning ?? t("gps.explainUnstable")) : t("gps.explainLost");
  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="satellite" size={iconSize.lg} color={toneColor(c, g.tone)} />
        <View style={styles.flex}>
          <Crossfade contentKey={g.key}><Text variant="headline" style={{ color: toneColor(c, g.tone) }}>{t(g.key)}</Text></Crossfade>
          <Text variant="subhead" color="secondary">
            {[accuracyM != null && gpsStatus === "ready" && health !== "lost" ? t("gps.accuracy", { meters: Math.round(accuracyM) }) : null, fixAt ? t("gps.updated", { time: formatClock(fixAt, lang) }) : null].filter(Boolean).join(" · ") || t("gps.title")}
          </Text>
        </View>
        <IconButton icon="refresh" tone="plain" size={40} label={t("common.retry")} onPress={onRefresh} />
      </View>
      {explain && <Text variant="callout" color="secondary">{explain}</Text>}
      {gpsStatus === "permission" && <Button label={t("gps.allow")} onPress={onAllow} variant="secondary" />}
      {gpsStatus === "permission" && <Text variant="bodyStrong" color="accent" onPress={() => void Linking.openSettings()}>{t("gps.openSettings")}</Text>}
    </Card>
  );
}

// The co-pilot speaks first: the most important thing right now (alert with
// the nearest shelter, GPS trouble, or "all calm") with action buttons, then
// a field to ask anything.
function CopilotCard({ question, onChange, onSend, onVoice, onPrompt, t }: { question: string; onChange: (v: string) => void; onSend: () => void; onVoice: () => void; onPrompt: (q: string) => void; t: Translate }): JSX.Element {
  const c = useColors();
  const world = useCopilotWorld();
  const run = useCopilotActions(onPrompt);
  const insight = proactiveInsights(world)[0]!;
  const tone = insight.tone === "critical" ? c.critical : insight.tone === "warning" ? c.warning : c.brandTeal;
  const chips = suggestions(world).slice(0, 4);
  return (
    <Card style={[styles.card, { borderColor: insight.tone === "calm" ? c.border : tone }]}>
      <View style={styles.cardHead}>
        <NaviaAiMark size={40} active={insight.tone !== "calm"} />
        <View style={styles.flex}>
          <Text variant="headline">{t("copilot.title")}</Text>
          <Text variant="caption" color="muted">{t("copilot.onDevice")}</Text>
        </View>
      </View>
      <Text variant="callout" style={{ color: insight.tone === "calm" ? c.textSecondary : c.textPrimary }}>{insight.text}</Text>
      {insight.actions.length > 0 && (
        <View style={styles.insightActions}>
          {insight.actions.map((a, i) => (
            <Button key={`${a.kind}-${i}`} label={a.label} variant={a.kind === "route" ? (insight.tone === "critical" ? "critical" : "primary") : "secondary"}
              icon={a.kind === "route" ? (a.mode === "walk" ? "walk" : "car") : a.kind === "safety" ? "shield" : "sparkle"} onPress={() => run(a)} />
          ))}
        </View>
      )}
      <View style={[styles.composer, { backgroundColor: c.surfaceMuted }]}>
        <TextField value={question} onChangeText={onChange} placeholder={t("copilot.placeholder")} returnKeyType="send" onSubmitEditing={onSend} accessibilityLabel={t("copilot.placeholder")} />
        <IconButton icon={question.trim() ? "send" : "mic"} tone="accent" size={40} label={question.trim() ? t("copilot.send") : t("copilot.mic")} onPress={question.trim() ? onSend : onVoice} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts}>
        {chips.map((a) => a.kind === "ask" && <Chip key={a.question} label={a.label} onPress={() => onPrompt(a.question)} />)}
      </ScrollView>
    </Card>
  );
}

function SavedTile({ icon, label, place, onPress }: { icon: IconName; label: string; place: PlaceRef | null; onPress: () => void }): JSX.Element {
  const c = useColors();
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.savedTile, { backgroundColor: c.surfaceMuted }]}>
      <Icon name={icon} size={iconSize.md} color={c.accent} />
      <View style={styles.flex}>
        <Text variant="subhead" numberOfLines={1}>{label}</Text>
        <Text variant="caption" color="muted" numberOfLines={1}>{place?.label ?? "+"}</Text>
      </View>
    </Touchable>
  );
}

function LayersModal({ open, value, onClose, onPick, t, c }: { open: boolean; value: MapLayer; onClose: () => void; onPick: (l: MapLayer) => void; t: Translate; c: ThemeColors }): JSX.Element {
  const options: { layer: MapLayer; icon: IconName; label: Parameters<Translate>[0] }[] = [
    { layer: "standard", icon: "layers", label: "layers.standard" },
    { layer: "satellite", icon: "globe", label: "layers.satellite" },
    { layer: "terrain", icon: "route", label: "layers.terrain" },
  ];
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.modalScrim, { backgroundColor: c.scrim }]} onPress={onClose}>
        <Pressable style={[styles.layersCard, { backgroundColor: c.surfaceElevated }, elevation(3, c)]}>
          <View style={styles.cardHead}>
            <Text variant="headline" style={styles.flex}>{t("layers.title")}</Text>
            <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={onClose} />
          </View>
          <View style={styles.layerRow}>
            {options.map((o) => {
              const available = layerAvailable(o.layer);
              const active = value === o.layer;
              return (
                <Touchable key={o.layer} disabled={!available} accessibilityRole="button" accessibilityState={{ selected: active, disabled: !available }} accessibilityLabel={t(o.label)}
                  onPress={() => onPick(o.layer)} style={[styles.layerOption, { borderColor: active ? c.accent : c.border, backgroundColor: c.surfaceMuted, opacity: available ? 1 : 0.5 }]}>
                  <Icon name={o.icon} size={iconSize.xl} color={active ? c.accent : c.textSecondary} />
                  <Text variant="subhead" color={active ? "accent" : "primary"}>{t(o.label)}</Text>
                  {!available && <Text variant="caption" color="muted" style={styles.center}>{t("layers.needsKey")}</Text>}
                </Touchable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function toneColor(c: ThemeColors, tone: "success" | "warning" | "critical" | "neutral"): string {
  return tone === "success" ? c.success : tone === "warning" ? c.warning : tone === "critical" ? c.critical : c.textSecondary;
}
function toneSoft(c: ThemeColors, tone: "success" | "warning" | "critical" | "neutral"): string {
  return tone === "success" ? c.successSoft : tone === "warning" ? c.warningSoft : tone === "critical" ? c.criticalSoft : c.surface;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  center: { textAlign: "center" },
  mapState: { alignItems: "center", justifyContent: "center", padding: space.lg },
  top: { position: "absolute", left: 0, right: 0, top: 0 },
  searchRow: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.md },
  search: { flex: 1, height: SEARCH_H, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm },
  searchText: { flex: 1 },
  chipsScroll: { marginTop: space.xs, flexGrow: 0 },
  chips: { gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xxs },
  beacons: { paddingHorizontal: space.md, marginTop: space.sm },
  compassRow: { alignItems: "flex-end", paddingHorizontal: space.md, marginTop: space.sm },
  compass: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  rightRail: { position: "absolute", right: space.md, gap: space.sm, alignItems: "center" },
  copilotFab: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", borderWidth: 1.5 },
  leftRail: { position: "absolute", left: space.md },
  statusRow: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
  tile: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs, padding: space.xs, borderRadius: radius.lg },
  tileIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  tileText: { flex: 1, minWidth: 0 },
  categoryHeader: { paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.xs },
  contextHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  radiusRow: { gap: space.xs, paddingRight: space.md },
  moreNote: { paddingHorizontal: space.md, paddingVertical: space.sm },
  contextHeader: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
  metaRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs, marginTop: space.xxs },
  sheetContent: { paddingHorizontal: space.md, paddingBottom: space.xl, gap: space.sm },
  sectionGap: { marginTop: space.sm, marginBottom: 0 },
  card: { gap: space.sm },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  composer: { flexDirection: "row", alignItems: "center", borderRadius: radius.pill, paddingLeft: space.md, paddingRight: space.xxs, minHeight: 48 },
  prompts: { gap: space.xs },
  savedRow: { flexDirection: "row", gap: space.xs },
  insightActions: { gap: space.xs },
  savedHeader: { paddingHorizontal: space.md, paddingBottom: space.sm },
  savedTile: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.lg },
  stack: { gap: space.md },
  buttonRow: { flexDirection: "row", gap: space.xs },
  empty: { gap: space.sm, paddingVertical: space.lg },
  sources: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingVertical: space.md },
  demoLink: { textAlign: "center" },
  modalScrim: { flex: 1, justifyContent: "flex-end", padding: space.md },
  layersCard: { borderRadius: radius.xl, padding: space.md, gap: space.md, marginBottom: space.xl },
  layerRow: { flexDirection: "row", gap: space.xs },
  layerOption: { flex: 1, alignItems: "center", gap: space.xs, paddingVertical: space.md, paddingHorizontal: space.xs, borderRadius: radius.lg, borderWidth: 2 },
});
