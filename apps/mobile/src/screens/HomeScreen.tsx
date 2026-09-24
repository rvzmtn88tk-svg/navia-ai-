// Map-first home: full-screen map with the NAVIA position puck, search on
// top, category chips, floating map controls and a draggable bottom sheet with
// GPS health, the local air-alert status, the co-pilot and saved places.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList, RouteMode } from "../navigation/RootNavigator";
import { useNaviaStore } from "../engine/naviaController";
import { useLiveContext, type GnssHealth, type GpsStatus } from "../engine/useLiveContext";
import { useAppSettings, type MapLayer } from "../settings/AppSettings";
import { usePlacesStore, placeId, type PlaceRef } from "../store/placesStore";
import { CATEGORY_META, CHIP_CATEGORIES, nearestShelter, placesFor, type ChipCategory } from "../places/categories";
import type { NearbyPlace, NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";
import type { AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import { NaviaMap, type CameraMode, type NaviaMapHandle } from "../map/NaviaMap";
import { layerAvailable, useMapStyle } from "../map/mapStyles";
import { BottomSheet, type SheetSnap } from "../components/BottomSheet";
import { Crossfade } from "../components/Crossfade";
import { BrandMark } from "../components/BrandMark";
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
    setCameraMode("free");
    setSnap("half");
    map.current?.flyTo(focus, 16, halfSheetHeight);
    navigation.setParams({ focusPlace: undefined });
  }, [navigation, route.params?.focusPlace]);

  const user = useMemo(() => fix ? { lat: fix.lat, lon: fix.lon, headingDeg: fix.headingDeg, accuracyM: fix.accuracyM } : null, [fix]);
  const categoryPlaces = useMemo(() => category ? placesFor(category, live.places) : [], [category, live.places]);
  const shelter = nearestShelter(live.places);
  const alertActive = alert?.active === true;

  const openPlace = useCallback((place: NearbyPlace) => {
    setSelected({
      id: place.id, label: place.name, subtitle: place.address, lat: place.location.lat, lon: place.location.lon,
      category: place.category, hours: place.openingHours, source: place.source, distanceM: place.distanceM,
    });
    setCameraMode("free");
    setSnap("half");
    map.current?.flyTo(place.location, 16.5, halfSheetHeight);
  }, [halfSheetHeight]);


  function selectCategory(next: ChipCategory) {
    setSelected(null);
    if (category === next) { setCategory(null); setSnap("peek"); return; }
    setCategory(next);
    setSnap("half");
    const nearby = placesFor(next, live.places).slice(0, 8).map((p) => p.location);
    if (nearby.length > 0) {
      setCameraMode("free");
      map.current?.fitPoints(fix ? [{ lat: fix.lat, lon: fix.lon }, ...nearby] : nearby, halfSheetHeight);
    }
  }

  function startRoute(place: PlaceRef, mode: RouteMode) {
    setDemoMode(false);
    usePlacesStore.getState().addRecent(place);
    navigation.navigate("Navigation", { destinationLat: place.lat, destinationLon: place.lon, destinationLabel: place.label, mode });
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
      <Animated.View style={[styles.rightRail, { bottom: controlsBottom }]} pointerEvents="box-none">
        <IconButton icon="layers" label={t("home.layers")} onPress={() => setLayersOpen(true)} />
        <IconButton icon={cameraMode === "free" ? "locate" : "locateFilled"} label={t("home.locate")}
          onPress={() => { if (!fix) void live.requestPermission(); setCameraMode("follow"); map.current?.recenter(); }} />
      </Animated.View>
      {alertActive && shelter && !selected && (
        <Animated.View style={[styles.leftRail, { bottom: controlsBottom }]}>
          <Button label={t("home.nearestShelter")} icon="shelter" variant="critical"
            onPress={() => startRoute({ id: shelter.id, label: shelter.name, lat: shelter.location.lat, lon: shelter.location.lon }, "walk")} />
        </Animated.View>
      )}

      <BottomSheet snap={snap} onSnapChange={setSnap} peekHeight={PEEK_H} fullTop={fullTop} visibleHeight={sheetVisible}
        header={selected ? <PlaceHeader place={selected} t={t} lang={lang} onClose={closeContext} />
          : category ? <CategoryHeader category={category} count={categoryPlaces.length} t={t} onClose={closeContext} />
            : <StatusHeader gpsStatus={live.gpsStatus} health={live.health} accuracyM={fix?.accuracyM ?? null} alert={alert} alertState={live.alertState}
              t={t} onGps={() => setSnap("half")} onAlert={() => setSnap("half")} />}
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
            <CategoryList places={categoryPlaces} state={live.placesState} t={t} lang={lang} onPick={openPlace} onRetry={() => void live.refresh()} />
          ) : (
            <>
              <GpsCard gpsStatus={live.gpsStatus} health={live.health} accuracyM={fix?.accuracyM ?? null} fixAt={fix?.timestamp ?? null} t={t} lang={lang}
                onAllow={() => void live.requestPermission()} onRefresh={() => void live.refresh()} />
              <AlertCard alert={alert} threat={threat} state={live.alertState} t={t} lang={lang} />
              <CopilotCard question={question} onChange={setQuestion} onSend={() => askCopilot()} onVoice={() => askCopilot("", true)} onPrompt={(q) => askCopilot(q)} t={t} />
              <SectionLabel style={styles.sectionGap}>{t("saved.title")}</SectionLabel>
              <View style={styles.savedRow}>
                <SavedTile icon="home" label={t("saved.home")} place={home} onPress={() => home ? startRoute(home, "car") : navigation.navigate("Search", { pickFor: "home" })} />
                <SavedTile icon="work" label={t("saved.work")} place={work} onPress={() => work ? startRoute(work, "car") : navigation.navigate("Search", { pickFor: "work" })} />
              </View>
              {custom.slice(0, 5).map((p) => <ListRow key={p.id} icon="star" title={p.label} subtitle={p.subtitle} onPress={() => { setSelected(p); setSnap("half"); map.current?.flyTo(p, 16, halfSheetHeight); setCameraMode("free"); }} />)}
              {recents.length > 0 && <SectionLabel style={styles.sectionGap}>{t("recent.title")}</SectionLabel>}
              {recents.slice(0, 5).map((p, i) => <View key={p.id}>
                {i > 0 && <Divider inset={52} />}
                <ListRow icon="clock" iconTint={c.textSecondary} title={p.label} subtitle={p.subtitle} onPress={() => { setSelected(p); setSnap("half"); map.current?.flyTo(p, 16, halfSheetHeight); setCameraMode("free"); }} />
              </View>)}
              <Pressable onPress={() => navigation.navigate("Sources")} accessibilityRole="link" style={styles.sources}>
                <Icon name="info" size={iconSize.sm} color={c.textMuted} />
                <Text variant="caption" color="muted">{t("home.sources")} · © OpenStreetMap</Text>
              </Pressable>
              {__DEV__ && <Text variant="caption" color="accent" style={styles.demoLink} onPress={() => {
                setDemoMode(true);
                navigation.navigate("Navigation", { destinationLat: 50.3450, destinationLon: 30.8950, destinationLabel: `Бориспіль (${t("common.demo")})` });
              }}>{t("common.demo")} ▸</Text>}
            </>
          )}
        </ScrollView>
      </BottomSheet>

      <LayersModal open={layersOpen} value={mapLayer} onClose={() => setLayersOpen(false)} onPick={(layer) => { setMapLayer(layer); setLayersOpen(false); }} t={t} c={c} />
    </View>
  );
}

// ——— Sheet headers ———

function gpsTone(status: GpsStatus, health: GnssHealth): { tone: "success" | "warning" | "critical" | "neutral"; key: Parameters<Translate>[0] } {
  if (status === "permission") return { tone: "neutral", key: "gps.permission" };
  if (status === "error") return { tone: "critical", key: "gps.error" };
  if (status !== "ready") return { tone: "neutral", key: "gps.searching" };
  return health === "stable" ? { tone: "success", key: "gps.stable" } : health === "unstable" ? { tone: "warning", key: "gps.unstable" } : { tone: "critical", key: "gps.lost" };
}

function alertTone(alert: GeolocatedAirAlert | null, state: string): { tone: "success" | "warning" | "critical" | "neutral"; key: Parameters<Translate>[0] } {
  if (!alert) return { tone: "neutral", key: state === "loading" ? "alert.checking" : "alert.waiting" };
  if (alert.active === true) return { tone: "critical", key: "alert.active" };
  if (alert.active === false) return { tone: "success", key: "alert.clear" };
  return { tone: "neutral", key: "alert.unknown" };
}

function StatusHeader({ gpsStatus, health, accuracyM, alert, alertState, t, onGps, onAlert }: {
  gpsStatus: GpsStatus; health: GnssHealth; accuracyM: number | null; alert: GeolocatedAirAlert | null; alertState: string; t: Translate; onGps: () => void; onAlert: () => void;
}): JSX.Element {
  const gps = gpsTone(gpsStatus, health);
  const al = alertTone(alert, alertState);
  return (
    <View style={styles.statusRow}>
      <StatusTile icon="satellite" tone={gps.tone} title={t(gps.key)} caption={accuracyM != null && gpsStatus === "ready" ? t("gps.accuracy", { meters: Math.round(accuracyM) }) : t("gps.title")} onPress={onGps} />
      <StatusTile icon="alert" tone={al.tone} title={t(al.key)} caption={alert?.locationLabel ?? t("alert.title")} onPress={onAlert} />
    </View>
  );
}

function StatusTile({ icon, tone, title, caption, onPress }: { icon: IconName; tone: "success" | "warning" | "critical" | "neutral"; title: string; caption: string; onPress: () => void }): JSX.Element {
  const c = useColors();
  const fg = toneColor(c, tone);
  const bg = toneSoft(c, tone);
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={`${title}. ${caption}`} onPress={onPress} style={[styles.tile, { backgroundColor: c.surfaceMuted }]}>
      <View style={[styles.tileIcon, { backgroundColor: bg }]}><Icon name={icon} size={iconSize.md} color={fg} /></View>
      <View style={styles.tileText}>
        <Crossfade contentKey={title}><Text variant="subhead" style={{ color: fg }} numberOfLines={1}>{title}</Text></Crossfade>
        <Text variant="caption" color="muted" numberOfLines={1}>{caption}</Text>
      </View>
    </Touchable>
  );
}

function CategoryHeader({ category, count, t, onClose }: { category: ChipCategory; count: number; t: Translate; onClose: () => void }): JSX.Element {
  return (
    <View style={styles.contextHeader}>
      <Text variant="title" style={styles.flex} numberOfLines={1}>{t("category.nearbyCount", { category: t(CATEGORY_META[category].label), count })}</Text>
      <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={onClose} />
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

function CategoryList({ places, state, t, lang, onPick, onRetry }: { places: NearbyPlace[]; state: string; t: Translate; lang: "uk" | "en"; onPick: (p: NearbyPlace) => void; onRetry: () => void }): JSX.Element {
  if (places.length === 0) {
    return (
      <View style={styles.empty}>
        <Text variant="callout" color="secondary">{state === "error" ? t("category.error") : state === "loading" || state === "idle" ? t("category.loading") : t("category.none")}</Text>
        {state === "error" && <Text variant="bodyStrong" color="accent" onPress={onRetry}>{t("common.retry")}</Text>}
      </View>
    );
  }
  return <>{places.slice(0, 30).map((p, i) => (
    <View key={p.id}>
      {i > 0 && <Divider inset={52} />}
      <ListRow icon={CATEGORY_META[p.category].icon} iconTint={CATEGORY_META[p.category].color} title={p.name}
        subtitle={[formatDistance(p.distanceM, lang), p.address && p.address !== p.name ? p.address : null].filter(Boolean).join(" · ")} onPress={() => onPick(p)} />
    </View>
  ))}</>;
}

function GpsCard({ gpsStatus, health, accuracyM, fixAt, t, lang, onAllow, onRefresh }: {
  gpsStatus: GpsStatus; health: GnssHealth; accuracyM: number | null; fixAt: number | null; t: Translate; lang: "uk" | "en"; onAllow: () => void; onRefresh: () => void;
}): JSX.Element {
  const c = useColors();
  const g = gpsTone(gpsStatus, health);
  const explain = gpsStatus !== "ready" ? null : health === "stable" ? t("gps.explainStable") : health === "unstable" ? t("gps.explainUnstable") : t("gps.explainLost");
  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="satellite" size={iconSize.lg} color={toneColor(c, g.tone)} />
        <View style={styles.flex}>
          <Crossfade contentKey={g.key}><Text variant="headline" style={{ color: toneColor(c, g.tone) }}>{t(g.key)}</Text></Crossfade>
          <Text variant="subhead" color="secondary">
            {[accuracyM != null && gpsStatus === "ready" ? t("gps.accuracy", { meters: Math.round(accuracyM) }) : null, fixAt ? t("gps.updated", { time: formatClock(fixAt, lang) }) : null].filter(Boolean).join(" · ") || t("gps.title")}
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

function AlertCard({ alert, threat, state, t, lang }: { alert: GeolocatedAirAlert | null; threat: AirThreatSummary | null; state: string; t: Translate; lang: "uk" | "en" }): JSX.Element {
  const c = useColors();
  const a = alertTone(alert, state);
  const sameRegion = threat && alert && threat.region === alert.region;
  const kinds = sameRegion ? threat.threatKinds.map((k) => t((`alert.kind.${k}` in KIND_KEYS ? `alert.kind.${k}` : "alert.kind.other") as Parameters<Translate>[0])).join(", ") : "";
  const summary = !sameRegion ? null : threat.state === "reported" ? t("alert.region.reported", { kinds }) : threat.state === "advisory" ? t("alert.region.advisory", { kinds }) : threat.state === "none" ? t("alert.region.none") : t("alert.region.unavailable");
  const meta = [alert?.locationLabel, alert?.active && alert.since ? t("alert.since", { time: formatClock(alert.since, lang) }) : null, alert?.updatedAt ? t("alert.checked", { time: formatClock(alert.updatedAt, lang) }) : null].filter(Boolean).join(" · ");
  return (
    <Card style={[styles.card, alert?.active === true && { borderColor: c.critical, backgroundColor: c.criticalSoft }]}>
      <View style={styles.cardHead}>
        <Icon name="alert" size={iconSize.lg} color={toneColor(c, a.tone)} />
        <View style={styles.flex}>
          <Crossfade contentKey={a.key}><Text variant="headline" style={{ color: toneColor(c, a.tone) }}>{t(a.key)}</Text></Crossfade>
          {meta ? <Text variant="subhead" color="secondary" numberOfLines={2}>{meta}</Text> : null}
        </View>
      </View>
      {summary && <Text variant="callout" color="secondary">{summary}</Text>}
    </Card>
  );
}

const KIND_KEYS: Record<string, true> = {
  "alert.kind.uav": true, "alert.kind.fpv": true, "alert.kind.recon": true, "alert.kind.kab": true, "alert.kind.cruise_missile": true,
  "alert.kind.ballistic_missile": true, "alert.kind.missile": true, "alert.kind.aircraft": true, "alert.kind.other": true,
};

function CopilotCard({ question, onChange, onSend, onVoice, onPrompt, t }: { question: string; onChange: (v: string) => void; onSend: () => void; onVoice: () => void; onPrompt: (q: string) => void; t: Translate }): JSX.Element {
  const c = useColors();
  const prompts = [t("copilot.prompt.gps"), t("copilot.prompt.shelter"), t("copilot.prompt.fuel")];
  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="sparkle" size={iconSize.lg} color={c.accent} />
        <Text variant="headline" style={styles.flex}>{t("copilot.title")}</Text>
      </View>
      <View style={[styles.composer, { backgroundColor: c.surfaceMuted }]}>
        <TextField value={question} onChangeText={onChange} placeholder={t("copilot.placeholder")} returnKeyType="send" onSubmitEditing={onSend} accessibilityLabel={t("copilot.placeholder")} />
        <IconButton icon={question.trim() ? "send" : "mic"} tone="accent" size={40} label={question.trim() ? t("copilot.send") : t("copilot.mic")} onPress={question.trim() ? onSend : onVoice} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts}>
        {prompts.map((p) => <Chip key={p} label={p} onPress={() => onPrompt(p)} />)}
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
  compassRow: { alignItems: "flex-end", paddingHorizontal: space.md, marginTop: space.sm },
  compass: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  rightRail: { position: "absolute", right: space.md, gap: space.sm },
  leftRail: { position: "absolute", left: space.md },
  statusRow: { flexDirection: "row", gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
  tile: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs, padding: space.xs, borderRadius: radius.lg },
  tileIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  tileText: { flex: 1, minWidth: 0 },
  contextHeader: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
  metaRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs, marginTop: space.xxs },
  sheetContent: { paddingHorizontal: space.md, paddingBottom: space.xl, gap: space.sm },
  sectionGap: { marginTop: space.sm, marginBottom: 0 },
  card: { gap: space.sm },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  composer: { flexDirection: "row", alignItems: "center", borderRadius: radius.pill, paddingLeft: space.md, paddingRight: space.xxs, minHeight: 48 },
  prompts: { gap: space.xs },
  savedRow: { flexDirection: "row", gap: space.xs },
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
