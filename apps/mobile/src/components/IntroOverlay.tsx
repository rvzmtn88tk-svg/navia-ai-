// Branded launch sequence (~2.4 s): deep-space ground with twinkling stars,
// the NAVIA emblem draws itself (ring traces, ticks appear, the split arrow
// rises with a glow), the NAVIA wordmark rises letter by letter and a light
// sweep crosses it, then the scene pushes towards the viewer into the map.
// The first launch continues into the story tour (greeting + slogan there).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StatusBar, StyleSheet, View, useWindowDimensions } from "react-native";
import { Audio } from "expo-av";
import { useAppSettings } from "../settings/AppSettings";
import { palettes, space, typography } from "../theme/tokens";
import { NaviaEmblem } from "./NaviaEmblem";
import { Onboarding } from "./Onboarding";

const BRAND = palettes.dark;
const EMBLEM = 168;
const LETTERS = ["N", "A", "V", "I", "A"];

/** Deterministic pseudo-random star field. */
function stars(count: number, w: number, h: number): { x: number; y: number; r: number; delay: number }[] {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  return Array.from({ length: count }, () => ({ x: rand() * w, y: rand() * h, r: 0.8 + rand() * 1.6, delay: rand() * 900 }));
}

export function IntroOverlay(): JSX.Element | null {
  const { ready, onboardingComplete, introSoundEnabled } = useAppSettings();
  const { width, height } = useWindowDimensions();
  const [stage, setStage] = useState<"intro" | "tour" | "done">("intro");
  const draw = useRef(new Animated.Value(0)).current; // JS driver: SVG props
  const rise = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const letters = useRef(LETTERS.map(() => new Animated.Value(0))).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const field = useMemo(() => stars(46, width, height), [width, height]);

  useEffect(() => {
    if (!ready) return;
    const first = !onboardingComplete;
    let sound: Audio.Sound | null = null;
    let disposed = false;
    if (introSoundEnabled) {
      void Audio.Sound.createAsync(require("../../assets/navia-intro.wav"), { shouldPlay: true, volume: 0.7 })
        .then((loaded) => { if (disposed) void loaded.sound.unloadAsync(); else sound = loaded.sound; })
        .catch(() => {});
    }
    const ease = Easing.bezier(0.2, 0, 0, 1);
    const tw = Animated.loop(Animated.sequence([
      Animated.timing(twinkle, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(twinkle, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    tw.start();
    const sequence = Animated.sequence([
      Animated.parallel([
        Animated.timing(draw, { toValue: 1, duration: 1250, easing: ease, useNativeDriver: false }),
        Animated.timing(rise, { toValue: 1, duration: 900, delay: 350, easing: Easing.bezier(0.34, 1.4, 0.64, 1), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 700, delay: 700, useNativeDriver: false }),
        Animated.stagger(70, letters.map((l) => Animated.timing(l, { toValue: 1, duration: 360, delay: 700, easing: ease, useNativeDriver: true }))),
      ]),
      Animated.timing(sweep, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(first ? 250 : 120),
      Animated.timing(exit, { toValue: 1, duration: 420, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }),
    ]);
    sequence.start(() => { tw.stop(); setStage(first ? "tour" : "done"); });
    return () => {
      disposed = true;
      sequence.stop();
      tw.stop();
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

  const sceneScale = exit.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] });
  const sceneOpacity = exit.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.6, 0] });
  const emblemScale = rise.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] });
  const sweepX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-120, 260] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: BRAND.background, opacity: sceneOpacity }]} pointerEvents="auto">
      <StatusBar barStyle="light-content" />
      {field.map((s, i) => (
        <Animated.View key={i} style={[styles.star, {
          left: s.x, top: s.y, width: s.r * 2, height: s.r * 2, borderRadius: s.r,
          opacity: twinkle.interpolate({ inputRange: [0, 1], outputRange: i % 2 ? [0.25, 0.8] : [0.8, 0.25] }),
        }]} />
      ))}
      <Animated.View style={[styles.center, { transform: [{ scale: sceneScale }] }]}>
        <Animated.View style={{ transform: [{ scale: emblemScale }] }}>
          <NaviaEmblem size={EMBLEM} progress={draw} glow={glow} />
        </Animated.View>
        <View style={styles.wordmark} accessibilityLabel="NAVIA">
          {LETTERS.map((letter, i) => (
            <Animated.Text key={i} style={[typography.display, styles.letter, {
              color: BRAND.textPrimary,
              opacity: letters[i],
              transform: [{ translateY: letters[i]!.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
            }]}>{letter}</Animated.Text>
          ))}
          <Animated.View pointerEvents="none" style={[styles.sweep, { transform: [{ translateX: sweepX }, { skewX: "-18deg" }] }]} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 100, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center" },
  star: { position: "absolute", backgroundColor: "#DDEBFF" },
  wordmark: { flexDirection: "row", marginTop: space.lg, overflow: "hidden", paddingHorizontal: space.xs },
  letter: { marginHorizontal: space.xs, letterSpacing: 2 },
  sweep: { position: "absolute", top: 0, bottom: 0, width: 36, backgroundColor: "rgba(255,255,255,0.35)" },
});
