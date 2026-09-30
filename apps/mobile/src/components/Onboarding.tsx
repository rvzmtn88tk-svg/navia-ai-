// First-launch story: why NAVIA exists and how it gets you to the goal when
// GPS is jammed during an alert. Seven swipeable pages with live scenes —
// greeting + slogan, Why? (GPS lies), How? (route guidance without signal),
// Where? (landmark at every turn), the co-pilot (ask, confirm, done), Why
// trust me? (honest colours), Safety — ending with the location permission
// explained in context. Skippable.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, ScrollView, StatusBar, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { useAppSettings } from "../settings/AppSettings";
import { useT, type StringKey } from "../i18n";
import { palettes, space } from "../theme/tokens";
import { Button, Text, Touchable } from "./ui";
import { NaviaEmblem } from "./NaviaEmblem";
import { CopilotScene, JamScene, LandmarkScene, ResilientScene, SafetyScene, TrustScene } from "./StoryScenes";

const BRAND = palettes.dark;

type Page = { key: string; kicker: StringKey; title?: StringKey; body?: StringKey; accent: string };

const PAGES: Page[] = [
  { key: "hello", kicker: "story.hello.kicker", body: "story.hello.body", accent: BRAND.brandTeal },
  { key: "why", kicker: "story.why.kicker", title: "story.why.title", body: "story.why.body", accent: BRAND.critical },
  { key: "how", kicker: "story.how.kicker", title: "story.how.title", body: "story.how.body", accent: BRAND.brandTeal },
  { key: "where", kicker: "story.where.kicker", title: "story.where.title", body: "story.where.body", accent: BRAND.brandOrange },
  { key: "copilot", kicker: "story.copilot.kicker", title: "story.copilot.title", body: "story.copilot.body", accent: BRAND.brandTeal },
  { key: "trust", kicker: "story.trust.kicker", title: "story.trust.title", body: "story.trust.body", accent: BRAND.success },
  { key: "safety", kicker: "story.safety.kicker", title: "story.safety.title", body: "story.safety.body", accent: BRAND.brandOrange },
];

// One grid for every page: the scene box and the text block have fixed sizes
// and sit at the same place, so nothing jumps while swiping. The text block
// fits kicker + a two-line title + four lines of body.
const COPY_H = 188;

export function Onboarding({ onDone }: { onDone: () => void }): JSX.Element {
  const { completeOnboarding } = useAppSettings();
  const { t } = useT();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const x = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(0);
  const last = page === PAGES.length - 1;
  const sceneW = Math.min(width - space.xl * 2, 360);
  const sceneH = Math.round(sceneW * 2 / 3);
  const labels = useMemo(() => ({
    jammed: t("story.scene.jammed"), guiding: t("story.scene.guiding"), lights: t("story.scene.lights"),
    fuel: t("story.scene.fuel"), bridge: t("story.scene.bridge"), turned: t("story.scene.turned"), answer: t("story.scene.answer"),
    copilotQ: t("story.scene.copilotQ"), copilotA: t("story.scene.copilotA"), stopAdded: t("story.scene.stopAdded"),
    yes: t("copilot.yes"), no: t("copilot.no"),
    green: t("onboarding.gps.green"), yellow: t("onboarding.gps.yellow"), red: t("onboarding.gps.red"),
  }), [t]);

  function finish() {
    completeOnboarding();
    onDone();
  }

  async function allowAndFinish() {
    await Location.requestForegroundPermissionsAsync().catch(() => null);
    finish();
  }

  function go(next: number) {
    scroll.current?.scrollTo({ x: next * width, animated: true });
    setPage(next);
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
          const opacity = x.interpolate({ inputRange: input, outputRange: [0, 1, 0], extrapolate: "clamp" });
          const shift = x.interpolate({ inputRange: input, outputRange: [40, 0, -40], extrapolate: "clamp" });
          const active = page === i;
          return (
            <View key={p.key} style={[styles.page, { width }]}>
              <View style={styles.flex} />
              <Animated.View style={[styles.scene, { width: sceneW, height: sceneH, opacity, transform: [{ translateX: shift }] }]}>
                {p.key === "hello" && <HelloScene size={sceneH} active={active} />}
                {p.key === "why" && <JamScene width={sceneW} active={active} labels={labels} />}
                {p.key === "how" && <ResilientScene width={sceneW} active={active} labels={labels} />}
                {p.key === "where" && <LandmarkScene width={sceneW} active={active} labels={labels} />}
                {p.key === "copilot" && <CopilotScene width={sceneW} active={active} labels={labels} />}
                {p.key === "trust" && <TrustScene width={sceneW} active={active} labels={labels} />}
                {p.key === "safety" && <SafetyScene width={sceneW} active={active} labels={labels} />}
              </Animated.View>
              <Animated.View style={[styles.copy, { width: sceneW, opacity }]}>
                <Text variant="subhead" style={[styles.kicker, { color: p.accent }]}>{t(p.kicker).toLocaleUpperCase()}</Text>
                {p.key === "hello"
                  ? <HelloSlogan active={active} slogan={t("story.hello.slogan")} />
                  : p.title && <Text variant="title" color={{ custom: BRAND.textPrimary }} style={styles.center}>{t(p.title)}</Text>}
                {p.body && <Text variant="body" color={{ custom: BRAND.textSecondary }} style={styles.center}>{t(p.body)}</Text>}
              </Animated.View>
              <View style={styles.flex} />
            </View>
          );
        })}
      </Animated.ScrollView>
      <View style={styles.dots}>
        {PAGES.map((p, i) => {
          // Width can't use the native driver; scale a fixed-width pill instead.
          const scaleX = x.interpolate({ inputRange: [(i - 1) * width, i * width, (i + 1) * width], outputRange: [1 / 3, 1, 1 / 3], extrapolate: "clamp" });
          return <Animated.View key={p.key} style={[styles.dot, { backgroundColor: page === i ? p.accent : BRAND.border, transform: [{ scaleX }] }]} />;
        })}
      </View>
      <View style={styles.actions}>
        {last ? <>
          <Button label={t("onboarding.location.cta")} icon="locateFilled" onPress={() => void allowAndFinish()} />
          <Touchable accessibilityRole="button" onPress={finish} style={styles.secondary}><Text variant="bodyStrong" color={{ custom: BRAND.textSecondary }}>{t("onboarding.start")}</Text></Touchable>
        </> : (
          <Button label={t("common.next")} onPress={() => go(page + 1)} />
        )}
      </View>
    </View>
  );
}

/** Greeting: the emblem draws itself inside a slowly turning orbit. */
function HelloScene({ active, size }: { active: boolean; size: number }): JSX.Element {
  const draw = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) return;
    draw.setValue(0);
    const intro = Animated.timing(draw, { toValue: 1, duration: 1300, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: false });
    const breathe = Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      Animated.timing(glow, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
    ]));
    const spin = Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 8000, easing: Easing.linear, useNativeDriver: true }));
    intro.start();
    breathe.start();
    spin.start();
    return () => { intro.stop(); breathe.stop(); spin.stop(); };
  }, [active, draw, glow, orbit]);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={[styles.orbit, { width: size, height: size, borderRadius: size / 2, transform: [{ rotate: orbit.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]}>
        <View style={[styles.satellite, { left: size / 2 - 5 }]} />
      </Animated.View>
      <NaviaEmblem size={Math.round(size * 0.7)} progress={draw} glow={glow} />
    </View>
  );
}

/** The slogan's two halves arrive after the emblem has drawn itself. */
function HelloSlogan({ active, slogan }: { active: boolean; slogan: string }): JSX.Element {
  const words = useRef([new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    if (!active) return;
    words.forEach((w) => w.setValue(0));
    const a = Animated.sequence([
      Animated.delay(900),
      Animated.stagger(380, words.map((w) => Animated.timing(w, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }))),
    ]);
    a.start();
    return () => a.stop();
  }, [active, words]);
  // One phrase per line, no final full stops (an open, calm slogan).
  const lines = slogan.split(/\n|\.\s+/).map((x) => x.trim().replace(/\.+$/, "")).filter(Boolean).slice(0, 2);
  return (
    <View>
      {lines.map((line, i) => (
        <Animated.Text key={i} style={[styles.sloganLine, { color: i === 0 ? BRAND.textPrimary : BRAND.brandTeal, opacity: words[i], transform: [{ translateY: words[i]!.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>{line}</Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 101 },
  skipRow: { height: 48, alignItems: "flex-end", justifyContent: "center", paddingHorizontal: space.md },
  skip: { padding: space.xs },
  page: { flex: 1, alignItems: "center", paddingHorizontal: space.xl },
  scene: { alignItems: "center", justifyContent: "center" },
  copy: { height: COPY_H, marginTop: space.xl, alignItems: "center", gap: space.sm },
  kicker: { letterSpacing: 2, fontWeight: "800", textAlign: "center" },
  center: { textAlign: "center" },
  orbit: { position: "absolute", borderWidth: 1, borderColor: "rgba(63,224,218,0.25)" },
  satellite: { position: "absolute", top: -5, width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND.brandOrange, shadowColor: BRAND.brandOrange, shadowOpacity: 1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  sloganLine: { fontSize: 22, lineHeight: 28, fontWeight: "800", textAlign: "center" },
  flex: { flex: 1 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 0, marginBottom: space.lg },
  dot: { width: 24, height: 8, borderRadius: 4 },
  actions: { paddingHorizontal: space.md, gap: space.xs },
  secondary: { alignItems: "center", padding: space.sm },
});
