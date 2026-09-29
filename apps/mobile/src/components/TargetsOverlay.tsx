// "Цілі" over the home map: slides down from the top while the camera flies
// out to the whole of Ukraine. Always says where the data comes from (with
// the visible NEPTUN link the API requires), when it was updated and that it
// is approximate community monitoring — never an empty map that could read as
// "no targets" when the source is down.
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TARGETS_SOURCE_URL, targetsLine, type AirTarget, type TargetsView } from "../providers/AirTargetsProvider";
export { targetsLine, type TargetsView };
import { directionWords } from "../ai/copilotBrain";
import { useT, type StringKey, type Translate } from "../i18n";
import { Icon } from "./Icon";
import { IconButton, Text, Touchable, useColors } from "./ui";
import { elevation, iconSize, radius, space } from "../theme/tokens";

export function TargetsOverlay({ open, view, selected, onSelect, onClose }: {
  open: boolean;
  view: TargetsView;
  selected: AirTarget | null;
  onSelect: (t: AirTarget | null) => void;
  onClose: () => void;
}): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const shown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(shown, { toValue: open ? 1 : 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [open, shown]);

  const line = targetsLine(view, t, lang);
  const translateY = shown.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] });

  return (
    <Animated.View pointerEvents={open ? "box-none" : "none"} style={[styles.wrap, { paddingTop: insets.top + space.xs, opacity: shown, transform: [{ translateY }] }]}>
      <View style={[styles.card, { backgroundColor: c.surfaceElevated }, elevation(3, c)]}>
        <View style={styles.header}>
          <Icon name="alert" size={iconSize.lg} color={c.critical} />
          <Text variant="title" style={styles.flex}>{t("targets.title")}</Text>
          <IconButton icon="close" tone="plain" size={40} label={t("common.close")} onPress={onClose} />
        </View>
        <Text variant="callout" color={line.tone === "warning" ? "critical" : "primary"}>{line.text}</Text>
        <Touchable accessibilityRole="link" onPress={() => void Linking.openURL(TARGETS_SOURCE_URL)} style={styles.source}>
          <Icon name="info" size={iconSize.sm} color={c.accent} />
          <Text variant="caption" color="accent">{t("targets.source")}</Text>
        </Touchable>
        <Text variant="caption" color="secondary">{t("targets.disclaimer")}</Text>
      </View>
      {selected && (
        <View style={[styles.card, styles.detail, { backgroundColor: c.surfaceElevated }, elevation(3, c)]}>
          <View style={styles.header}>
            <Text variant="bodyStrong" style={styles.flex}>{t(`targets.kind.${selected.kind}` as StringKey)}{selected.count && selected.count > 1 ? ` × ${selected.count}` : ""}</Text>
            <IconButton icon="close" tone="plain" size={36} label={t("common.close")} onPress={() => onSelect(null)} />
          </View>
          <TargetDetail target={selected} t={t} lang={lang} />
        </View>
      )}
    </Animated.View>
  );
}

function TargetDetail({ target, t, lang }: { target: AirTarget; t: Translate; lang: "uk" | "en" }): JSX.Element {
  const place = [target.locality, target.region].filter(Boolean).join(", ") || "—";
  const course = target.headingDeg != null ? directionWords(target.headingDeg, lang).replace(/^на |^to the /, "") : null;
  const mins = Math.max(0, Math.round((Date.now() - target.updatedAt) / 60_000));
  const ago = mins < 1 ? t("targets.ago.now") : t("targets.ago.min", { n: mins });
  return (
    <View style={styles.lines}>
      <Text variant="callout">{course ? t("targets.detail.where", { place, course }) : t("targets.detail.whereNoCourse", { place })}</Text>
      <Text variant="callout" color="secondary">{target.quality === "area" ? t("targets.detail.area") : t("targets.detail.accuracy", { km: target.uncertaintyKm ?? "?", reports: target.reports })}</Text>
      <Text variant="callout" color="secondary">{t("targets.detail.updated", { ago })}</Text>
      {target.stale && <Text variant="callout" color="critical">{t("targets.detail.stale")}</Text>}
      {!!target.note && <Text variant="caption" color="muted">NEPTUN: {target.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: space.md, gap: space.sm },
  card: { borderRadius: radius.lg, padding: space.md, gap: space.xs },
  detail: { alignSelf: "stretch" },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
  source: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: 2 },
  lines: { gap: 2 },
});
