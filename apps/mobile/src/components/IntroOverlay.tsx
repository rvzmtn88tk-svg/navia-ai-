// Branded launch sequence. Starts exactly where the native splash ends (logo
// centred on the dark brand ground), then: the logo settles with a light
// burst, an orbit ring sweeps round, "NAVIA" letters rise one by one, and the
// whole scene pushes towards the viewer and dissolves into the map.
// ~2 s on every launch; the first launch adds the slogan and then the tour.
import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StatusBar, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { Audio } from "expo-av";
import { useAppSettings } from "../settings/AppSettings";
import { useT } from "../i18n";
import { palettes, space, typography } from "../theme/tokens";
import { BrandMark } from "./BrandMark";
import { Onboarding } from "./Onboarding";

const BRAND = palettes.dark;
const LOGO = 130;
const RING = 220;
const LETTERS = ["N", "A", "V", "I", "A"];

export function IntroOverlay(): JSX.Element | null {
  const { ready, onboardingComplete, introSoundEnabled } = useAppSettings();
  const { t } = useT();
  const [stage, setStage] = useState<"intro" | "tour" | "done">("intro");
  const firstLaunch = useRef<boolean | null>(null);
  const logo = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const letters = useRef(LETTERS.map(() => new Animated.Value(0))).current;
  const slogan = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const exit = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!ready) return;
    firstLaunch.current = !onboardingComplete;
    const first = firstLaunch.current;
    let sound: Audio.Sound | null = null;
    let disposed = false;
    if (introSoundEnabled) {
      void Audio.Sound.createAsync(require("../../assets/navia-intro.wav"), { shouldPlay: true, volume: 0.45 })
        .then((loaded) => { if (disposed) void loaded.sound.unloadAsync(); else sound = loaded.sound; })
        .catch(() => {});
    }
    const ease = Easing.bezier(0.2, 0, 0, 1);
    const t_ = (value: Animated.Value, duration: number, delay = 0, easing = ease) =>
      Animated.timing(value, { toValue: 1, duration, delay, easing, useNativeDriver: true });

    const core = Animated.parallel([
      t_(logo, 520, 0, Easing.bezier(0.34, 1.4, 0.64, 1)),
      t_(burst, 700, 80),
      t_(ring, 900, 120, Easing.bezier(0.45, 0, 0.2, 1)),
      Animated.stagger(55, letters.map((l) => t_(l, 320, 480))),
    ]);
    const sloganIn = Animated.stagger(120, slogan.map((s) => t_(s, 300)));
    const out = t_(exit, 420, 0, Easing.bezier(0.4, 0, 1, 1));
    const sequence = first
      ? Animated.sequence([core, sloganIn, Animated.delay(900), out])
      : Animated.sequence([core, Animated.delay(250), out]);
    sequence.start(() => setStage(first ? "tour" : "done"));
    return () => {
      disposed = true;
      sequence.stop();
      if (sound) void (sound as Audio.Sound).unloadAsync().catch(() => {});
    };
    // Run once when settings are ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // "Show the tour again" from Settings.
  useEffect(() => {
    if (ready && stage === "done" && !onboardingComplete) setStage("tour");
  }, [ready, stage, onboardingComplete]);

  if (stage === "done") return null;
  if (stage === "tour") return <Onboarding onDone={() => setStage("done")} />;

  const logoScale = logo.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] });
  const sceneScale = exit.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const sceneOpacity = exit.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.6, 0] });
  const burstScale = burst.interpolate({ inputRange: [0, 1], outputRange: [0.4, 2.2] });
  const burstOpacity = burst.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.35, 0] });
  const ringRotate = ring.interpolate({ inputRange: [0, 1], outputRange: ["-120deg", "240deg"] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 1, 1, 0.55] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: BRAND.background, opacity: sceneOpacity }]} pointerEvents="auto">
      <StatusBar barStyle="light-content" />
      <Animated.View style={[styles.center, { transform: [{ scale: sceneScale }] }]}>
        <View style={styles.stage}>
          <Animated.View style={[styles.burst, { backgroundColor: BRAND.brandTeal, opacity: burstOpacity, transform: [{ scale: burstScale }] }]} />
          <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ rotate: ringRotate }] }]}>
            <Svg width={RING} height={RING}>
              <Defs>
                <LinearGradient id="orbit" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={BRAND.brandTeal} stopOpacity="1" />
                  <Stop offset="0.55" stopColor={BRAND.brandTeal} stopOpacity="0" />
                  <Stop offset="1" stopColor={BRAND.brandOrange} stopOpacity="0.9" />
                </LinearGradient>
              </Defs>
              <Circle cx={RING / 2} cy={RING / 2} r={RING / 2 - 3} stroke="url(#orbit)" strokeWidth={2.5} fill="none" />
              <Circle cx={RING - 3} cy={RING / 2} r={4} fill={BRAND.brandOrange} />
            </Svg>
          </Animated.View>
          <Animated.View style={{ transform: [{ scale: logoScale }] }}><BrandMark size={LOGO} /></Animated.View>
        </View>
        <View style={styles.wordmark} accessibilityLabel="NAVIA">
          {LETTERS.map((letter, i) => (
            <Animated.Text key={i} style={[typography.display, styles.letter, {
              color: BRAND.textPrimary,
              opacity: letters[i],
              transform: [{ translateY: letters[i]!.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            }]}>{letter}</Animated.Text>
          ))}
        </View>
        {firstLaunch.current && (
          <View style={styles.slogan}>
            {(["splash.slogan1", "splash.slogan2", "splash.slogan3"] as const).map((key, i) => (
              <Animated.Text key={key} style={[typography.headline, styles.sloganLine, {
                color: i === 2 ? BRAND.accent : BRAND.textSecondary,
                opacity: slogan[i],
                transform: [{ translateY: slogan[i]!.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
              }]}>{t(key)}</Animated.Text>
            ))}
          </View>
        )}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 100, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center" },
  stage: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  burst: { position: "absolute", width: LOGO, height: LOGO, borderRadius: LOGO / 2 },
  ring: { position: "absolute" },
  wordmark: { flexDirection: "row", marginTop: space.lg },
  letter: { marginHorizontal: space.xxs },
  slogan: { marginTop: space.lg, alignItems: "center", gap: space.xs },
  sloganLine: { textAlign: "center" },
});
