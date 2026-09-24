// First-launch tour: four swipeable cards, skippable, ending with the
// location permission request explained in context.
import React, { useRef, useState } from "react";
import { Animated, ScrollView, StatusBar, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { useAppSettings } from "../settings/AppSettings";
import { useT, type StringKey } from "../i18n";
import { palettes, radius, space } from "../theme/tokens";
import { Button, Text, Touchable } from "./ui";
import { Icon, type IconName } from "./Icon";

const BRAND = palettes.dark;

const PAGES: { icon: IconName; tint: string; title: StringKey; body: StringKey }[] = [
  { icon: "search", tint: BRAND.accent, title: "onboarding.map.title", body: "onboarding.map.body" },
  { icon: "satellite", tint: BRAND.success, title: "onboarding.gps.title", body: "onboarding.gps.body" },
  { icon: "shelter", tint: BRAND.critical, title: "onboarding.safety.title", body: "onboarding.safety.body" },
  { icon: "sparkle", tint: BRAND.brandOrange, title: "onboarding.copilot.title", body: "onboarding.copilot.body" },
];

export function Onboarding({ onDone }: { onDone: () => void }): JSX.Element {
  const { completeOnboarding } = useAppSettings();
  const { t } = useT();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const x = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(0);
  const last = page === PAGES.length - 1;

  function finish() {
    completeOnboarding();
    onDone();
  }

  async function allowAndFinish() {
    await Location.requestForegroundPermissionsAsync().catch(() => null);
    finish();
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: BRAND.background, paddingTop: insets.top, paddingBottom: insets.bottom + space.md }]}>
      <StatusBar barStyle="light-content" />
      <View style={styles.skipRow}>
        {!last && <Touchable accessibilityRole="button" onPress={finish} style={styles.skip}><Text variant="bodyStrong" color={{ custom: BRAND.textSecondary }}>{t("common.skip")}</Text></Touchable>}
      </View>
      <Animated.ScrollView
        ref={scroll as never}
        horizontal pagingEnabled showsHorizontalScrollIndicator={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {PAGES.map((p, i) => {
          const input = [(i - 1) * width, i * width, (i + 1) * width];
          const scale = x.interpolate({ inputRange: input, outputRange: [0.7, 1, 0.7], extrapolate: "clamp" });
          const opacity = x.interpolate({ inputRange: input, outputRange: [0, 1, 0], extrapolate: "clamp" });
          return (
            <View key={p.title} style={[styles.page, { width }]}>
              <Animated.View style={[styles.art, { backgroundColor: BRAND.surfaceElevated, borderColor: p.tint, opacity, transform: [{ scale }] }]}>
                <Icon name={p.icon} size={72} color={p.tint} strokeWidth={1.6} />
              </Animated.View>
              <Text variant="largeTitle" color={{ custom: BRAND.textPrimary }} style={styles.center}>{t(p.title)}</Text>
              <Text variant="body" color={{ custom: BRAND.textSecondary }} style={[styles.center, styles.body]}>{t(p.body)}</Text>
            </View>
          );
        })}
      </Animated.ScrollView>
      <View style={styles.dots}>
        {PAGES.map((p, i) => {
          // Width can't use the native driver; scale a fixed-width pill instead.
          const scaleX = x.interpolate({ inputRange: [(i - 1) * width, i * width, (i + 1) * width], outputRange: [1 / 3, 1, 1 / 3], extrapolate: "clamp" });
          return <Animated.View key={p.title} style={[styles.dot, { backgroundColor: page === i ? BRAND.accent : BRAND.border, transform: [{ scaleX }] }]} />;
        })}
      </View>
      <View style={styles.actions}>
        {last ? <>
          <Button label={t("onboarding.location.cta")} icon="locateFilled" onPress={() => void allowAndFinish()} />
          <Touchable accessibilityRole="button" onPress={finish} style={styles.secondary}><Text variant="bodyStrong" color={{ custom: BRAND.textSecondary }}>{t("onboarding.start")}</Text></Touchable>
        </> : (
          <Button label={t("common.next")} onPress={() => { const next = page + 1; scroll.current?.scrollTo({ x: next * width, animated: true }); setPage(next); }} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 101 },
  skipRow: { height: 48, alignItems: "flex-end", justifyContent: "center", paddingHorizontal: space.md },
  skip: { padding: space.xs },
  page: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xl, gap: space.md },
  art: { width: 160, height: 160, borderRadius: radius.xl * 2, alignItems: "center", justifyContent: "center", borderWidth: 2, marginBottom: space.lg },
  center: { textAlign: "center" },
  body: { maxWidth: 340 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 0, marginBottom: space.lg },
  dot: { width: 24, height: 8, borderRadius: 4 },
  actions: { paddingHorizontal: space.md, gap: space.xs },
  secondary: { alignItems: "center", paddingVertical: space.sm },
});
