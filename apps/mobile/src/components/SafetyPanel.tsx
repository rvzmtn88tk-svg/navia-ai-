// "Безпека" panel: slides in from the right edge of the home map. Shows the
// alert status for the user's location, the nearest shelters and resilience
// points (walking route on tap) and lets the user share their position.
// Place data is unverified OSM/official data and is labelled as such.
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, PanResponder, ScrollView, Share, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import type { AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import type { NearbyPlace } from "../providers/NearbyPlacesProvider";
import { formatDistance, useT } from "../i18n";
import { CATEGORY_META } from "../places/categories";
import { AlertStatus } from "./AlertStatus";
import { Icon } from "./Icon";
import { Button, Divider, IconButton, ListRow, SectionLabel, Text, Touchable, useColors } from "./ui";
import { elevation, iconSize, radius, space } from "../theme/tokens";

const EDGE_W = 20;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alert: GeolocatedAirAlert | null;
  threat: AirThreatSummary | null;
  alertLoading: boolean;
  shelters: NearbyPlace[];
  resilience: NearbyPlace[];
  sheltersLoading: boolean;
  position: { lat: number; lon: number } | null;
  onRoute: (place: NearbyPlace) => void;
};

export function SafetyPanel(props: Props): JSX.Element {
  const { open, onOpenChange } = props;
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelW = Math.min(width - space.xl, 420);
  const x = useRef(new Animated.Value(panelW)).current; // 0 = open, panelW = closed

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 0 : panelW, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [open, panelW, x]);

  // Drag from the right screen edge to open, drag the panel right to close.
  const edgePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => g.dx < -6 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_e, g) => x.setValue(Math.max(0, Math.min(panelW, panelW + g.dx))),
    onPanResponderRelease: (_e, g) => {
      const opening = g.dx < -panelW * 0.25 || g.vx < -0.4 || Math.abs(g.dx) < 4; // a tap on the handle opens too
      if (opening === open) Animated.timing(x, { toValue: open ? 0 : panelW, duration: 200, useNativeDriver: true }).start();
      onOpenChange(opening);
    },
  }), [onOpenChange, open, panelW, x]);
  const panelPan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_e, g) => x.setValue(Math.max(0, Math.min(panelW, g.dx))),
    onPanResponderRelease: (_e, g) => {
      const closing = g.dx > panelW * 0.3 || g.vx > 0.4;
      if (!closing) Animated.timing(x, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      onOpenChange(!closing);
    },
  }), [onOpenChange, panelW, x]);

  const backdrop = x.interpolate({ inputRange: [0, panelW], outputRange: [0.45, 0], extrapolate: "clamp" });

  async function share() {
    if (!props.position) return;
    const link = `https://www.openstreetmap.org/?mlat=${props.position.lat.toFixed(5)}&mlon=${props.position.lon.toFixed(5)}#map=17/${props.position.lat.toFixed(5)}/${props.position.lon.toFixed(5)}`;
    try { await Share.share({ message: t("safety.shareMessage", { link }) }); } catch { /* user cancelled */ }
  }

  const shelters = props.shelters.slice(0, 5);
  const resilience = props.resilience.slice(0, 3);

  return (
    <>
      {/* Edge grip: always present on the right side of the map. */}
      {!open && (
        <View style={[styles.edge, { top: insets.top + 160, bottom: 220 }]} {...edgePan.panHandlers} accessible accessibilityRole="button" accessibilityLabel={t("safety.title")}>
          <View style={[styles.grip, { backgroundColor: props.alert?.active ? c.critical : c.brandTeal }]} />
        </View>
      )}
      <Animated.View pointerEvents={open ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: "#000", opacity: backdrop }]}>
        <Touchable accessibilityRole="button" accessibilityLabel={t("common.close")} style={StyleSheet.absoluteFill} onPress={() => onOpenChange(false)} />
      </Animated.View>
      <Animated.View {...panelPan.panHandlers} pointerEvents={open ? "auto" : "none"}
        style={[styles.panel, { width: panelW, backgroundColor: c.background, paddingTop: insets.top + space.xs, transform: [{ translateX: x }] }, elevation(3, c)]}>
        <View style={styles.header}>
          <Icon name="shield" size={iconSize.lg} color={c.brandTeal} />
          <Text variant="title" style={styles.flex}>{t("safety.title")}</Text>
          <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={() => onOpenChange(false)} />
        </View>
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.lg }]}>
          <AlertStatus alert={props.alert} threat={props.threat} loading={props.alertLoading} />
          {shelters[0] && (
            <Button label={t("safety.goShelter")} icon="shelter" variant={props.alert?.active ? "critical" : "primary"} onPress={() => shelters[0] && props.onRoute(shelters[0])} />
          )}
          <SectionLabel>{t("safety.shelters")}</SectionLabel>
          <PlaceList places={shelters} empty={props.sheltersLoading ? t("category.loading") : t("safety.none")} lang={lang} onPick={props.onRoute} />
          {resilience.length > 0 && <SectionLabel>{t("safety.resilience")}</SectionLabel>}
          {resilience.length > 0 && <PlaceList places={resilience} empty="" lang={lang} onPick={props.onRoute} />}
          <Text variant="caption" color="muted">{t("place.unverified")}</Text>
          <Button label={t("safety.share")} icon="send" variant="secondary" disabled={!props.position} onPress={() => void share()} />
        </ScrollView>
      </Animated.View>
    </>
  );
}

function PlaceList({ places, empty, lang, onPick }: { places: NearbyPlace[]; empty: string; lang: "uk" | "en"; onPick: (p: NearbyPlace) => void }): JSX.Element {
  if (places.length === 0) return <Text variant="callout" color="secondary">{empty}</Text>;
  return (
    <View>
      {places.map((p, i) => (
        <View key={p.id}>
          {i > 0 && <Divider inset={52} />}
          <ListRow icon={CATEGORY_META[p.category].icon} iconTint={CATEGORY_META[p.category].color} title={p.name}
            subtitle={[formatDistance(p.distanceM, lang), p.address && p.address !== p.name ? p.address : null].filter(Boolean).join(" · ")} onPress={() => onPick(p)} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: { position: "absolute", right: 0, width: EDGE_W, justifyContent: "center", alignItems: "flex-end" },
  grip: { width: 5, height: 56, borderTopLeftRadius: radius.pill, borderBottomLeftRadius: radius.pill, opacity: 0.9 },
  panel: { position: "absolute", top: 0, bottom: 0, right: 0, borderTopLeftRadius: radius.xl, borderBottomLeftRadius: radius.xl, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.xs },
  flex: { flex: 1 },
  body: { paddingHorizontal: space.md, gap: space.md },
});
