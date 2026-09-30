// Cinematic launch sequence. First launch ≈3.8 s, later launches ≈2.3 s:
//  1. hyperspace — stars stretch into streaks racing past the viewer;
//  2. arrival — a nebula glows up and a planet's lit rim rises from below;
//  3. the NAVIA emblem draws itself, the wordmark rises letter by letter and
//     a light sweep crosses it;
//  4. the camera flies into the emblem and bursts through a curtain of
//     coloured light ribbons (a nod to the famous streaming-service ident),
//     with a haptic "ta-dum", then fades into the map.
// Everything but the emblem's SVG stroke runs on the native driver.
// Reduce Motion: no warp and no burst, just the emblem and a fade.
// The first launch continues into the story tour.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StatusBar, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { useAppSettings } from "../settings/AppSettings";
import { palettes, space, typography } from "../theme/tokens";
import { NaviaEmblem } from "./NaviaEmblem";
import { Onboarding } from "./Onboarding";

const BRAND = palettes.dark;
const EMBLEM = 168;
const LETTERS = ["N", "A", "V", "I", "A"];
const RIBBON_COLORS = ["#3FE0DA", "#1FB5FF", "#7A5CFF", "#FF9A3D", "#FF4D6D", "#8AF4EE", "#F5E6A0", "#12B3AD"];

// Timeline in milliseconds (first launch; later launches run at 0.62×).
const T = { warp: 1050, arrive: 800, nebula: 900, planet: 1300, emblemAt: 950, draw: 1250, sweep: 480, burst: 900 };
const EMBLEM_MS = Math.max(T.draw, 250 + 900, 650 + 700, 600 + 70 * (LETTERS.length - 1) + 380);
const BEFORE_SWEEP = Math.max(T.warp, T.arrive + T.nebula, T.arrive + T.planet, T.emblemAt + EMBLEM_MS);

/** Deterministic pseudo-random numbers, so the sky is the same every launch. */
function rng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

function starField(count: number, w: number, h: number) {
  const r = rng(7);
  return Array.from({ length: count }, () => ({ x: r() * w, y: r() * h, size: 0.8 + r() * 1.8, group: r() < 0.5 ? 0 : 1 }));
}

function streakField(count: number, diag: number) {
  const r = rng(11);
  return Array.from({ length: count }, () => {
    const pick = r();
    return {
      angle: r() * Math.PI * 2,
      from: 12 + r() * diag * 0.35,
      reach: diag * (0.55 + r() * 0.6),
      len: 18 + r() * 34,
      color: pick < 0.72 ? "#DDEBFF" : pick < 0.86 ? "#8AF4EE" : "#FFC98A",
    };
  });
}

function ribbonField(count: number, w: number) {
  const r = rng(23);
  return Array.from({ length: count }, (_, i) => ({
    base: (i / (count - 1) - 0.5) * w * 0.42,
    width: 5 + r() * 22,
    color: RIBBON_COLORS[i % RIBBON_COLORS.length]!,
    spread: 2.6 + r() * 3.4,
    delay: r() * 0.18,
  }));
}

export function IntroOverlay(): JSX.Element | null {
  const { ready, onboardingComplete, introSoundEnabled } = useAppSettings();
  const { width, height } = useWindowDimensions();
  const [stage, setStage] = useState<"intro" | "tour" | "done">("intro");
  const warp = useRef(new Animated.Value(0)).current;
  const nebula = useRef(new Animated.Value(0)).current;
  const planet = useRef(new Animated.Value(0)).current;
  const draw = useRef(new Animated.Value(0)).current; // JS driver: SVG props
  const rise = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const letters = useRef(LETTERS.map(() => new Animated.Value(0))).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const diag = Math.hypot(width, height);
  const stars = useMemo(() => starField(70, width, height), [width, height]);
  const streaks = useMemo(() => streakField(64, diag), [diag]);
  const ribbons = useMemo(() => ribbonField(26, width), [width]);

  useEffect(() => {
    if (!ready) return;
    const first = !onboardingComplete;
    let sound: Audio.Sound | null = null;
    let disposed = false;
    let sequence: Animated.CompositeAnimation | null = null;
    let tw: Animated.CompositeAnimation | null = null;
    let hapticTimer: ReturnType<typeof setTimeout> | null = null;
    if (introSoundEnabled) {
      void Audio.Sound.createAsync(require("../../assets/navia-intro.wav"), { shouldPlay: true, volume: 0.7 })
        .then((loaded) => { if (disposed) void loaded.sound.unloadAsync(); else sound = loaded.sound; })
        .catch(() => {});
    }
    void AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (disposed) return;
      const k = first ? 1 : 0.62; // later launches: the same film, faster
      const ease = Easing.bezier(0.2, 0, 0, 1);
      tw = Animated.loop(Animated.sequence([
        Animated.timing(twinkle, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(twinkle, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      tw.start();
      const emblem = Animated.parallel([
        Animated.timing(draw, { toValue: 1, duration: T.draw * k, easing: ease, useNativeDriver: false }),
        Animated.timing(rise, { toValue: 1, duration: 900 * k, delay: 250 * k, easing: Easing.bezier(0.34, 1.4, 0.64, 1), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 700 * k, delay: 650 * k, useNativeDriver: false }),
        Animated.stagger(70 * k, letters.map((l) => Animated.timing(l, { toValue: 1, duration: 380 * k, delay: 600 * k, easing: ease, useNativeDriver: true }))),
      ]);
      const hold = first ? 220 : 80;
      if (reduce) {
        nebula.setValue(1);
        planet.setValue(1);
        sequence = Animated.sequence([emblem, Animated.delay(500), Animated.timing(burst, { toValue: 1, duration: 450, useNativeDriver: true })]);
      } else {
        sequence = Animated.sequence([
          Animated.parallel([
            // 1. Hyperspace, accelerating.
            Animated.timing(warp, { toValue: 1, duration: T.warp * k, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
            // 2. Arrival: nebula and planet.
            Animated.timing(nebula, { toValue: 1, duration: T.nebula * k, delay: T.arrive * k, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(planet, { toValue: 1, duration: T.planet * k, delay: T.arrive * k, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            // 3. The emblem.
            Animated.sequence([Animated.delay(T.emblemAt * k), emblem]),
          ]),
          Animated.timing(sweep, { toValue: 1, duration: T.sweep * k, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.delay(hold),
          // 4. Fly into the emblem through the light ribbons.
          Animated.timing(burst, { toValue: 1, duration: T.burst * k, easing: Easing.bezier(0.55, 0, 0.35, 1), useNativeDriver: true }),
        ]);
        // The "ta-dum" lands when the ribbons open up.
        const toBurst = (BEFORE_SWEEP + T.sweep) * k + hold + T.burst * k * 0.4;
        hapticTimer = setTimeout(() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {}); }, toBurst);
      }
      sequence.start(({ finished }) => { tw?.stop(); if (finished) setStage(first ? "tour" : "done"); });
    });
    return () => {
      disposed = true;
      sequence?.stop();
      tw?.stop();
      if (hapticTimer) clearTimeout(hapticTimer);
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

  const cx = width / 2;
  const cy = height / 2;
  const planetR = width * 1.25;
  const planetCy = height + planetR * 0.8;
  // The whole scene flies into the emblem (which sits exactly at the centre).
  const sceneScale = burst.interpolate({ inputRange: [0, 0.55, 1], outputRange: [1, 3.2, 14] });
  const sceneOpacity = burst.interpolate({ inputRange: [0, 0.5, 0.7], outputRange: [1, 1, 0] });
  // Later launches dissolve into the map; the first one goes straight into
  // the story tour, so the map must not show through in between.
  const coverOpacity = onboardingComplete ? burst.interpolate({ inputRange: [0, 0.78, 1], outputRange: [1, 1, 0] }) : 1;
  const flash = burst.interpolate({ inputRange: [0, 0.5, 0.62, 0.9], outputRange: [0, 0, 0.75, 0] });
  const emblemScale = rise.interpolate({ inputRange: [0, 1], outputRange: [0.78, 1] });
  const sweepX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-120, 260] });
  const starGroups = [
    Animated.multiply(nebula, twinkle.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] })),
    Animated.multiply(nebula, twinkle.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] })),
  ];

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.cover, { opacity: coverOpacity }]} pointerEvents="auto">
      <StatusBar barStyle="light-content" />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: sceneOpacity, transform: [{ scale: sceneScale }] }]}>
        {/* Nebula */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: nebula }]}>
          <Svg width={width} height={height}>
            <Defs>
              <RadialGradient id="nebA" cx="0.2" cy="0.28" r="0.6">
                <Stop offset="0" stopColor="#5B3FD8" stopOpacity={0.55} />
                <Stop offset="1" stopColor="#5B3FD8" stopOpacity={0} />
              </RadialGradient>
              <RadialGradient id="nebB" cx="0.85" cy="0.45" r="0.55">
                <Stop offset="0" stopColor="#12B3AD" stopOpacity={0.4} />
                <Stop offset="1" stopColor="#12B3AD" stopOpacity={0} />
              </RadialGradient>
              <RadialGradient id="nebC" cx="0.5" cy="0.5" r="0.35">
                <Stop offset="0" stopColor="#1FB5FF" stopOpacity={0.22} />
                <Stop offset="1" stopColor="#1FB5FF" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect x="0" y="0" width={width} height={height} fill="url(#nebA)" />
            <Rect x="0" y="0" width={width} height={height} fill="url(#nebB)" />
            <Rect x="0" y="0" width={width} height={height} fill="url(#nebC)" />
          </Svg>
        </Animated.View>
        {/* Resting stars, two groups twinkling out of phase */}
        {starGroups.map((opacity, g) => (
          <Animated.View key={g} style={[StyleSheet.absoluteFill, { opacity }]}>
            {stars.filter((s) => s.group === g).map((s, i) => (
              <View key={i} style={[styles.star, { left: s.x, top: s.y, width: s.size, height: s.size, borderRadius: s.size / 2 }]} />
            ))}
          </Animated.View>
        ))}
        {/* Planet with a lit rim, rising from below */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: planet, transform: [{ translateY: planet.interpolate({ inputRange: [0, 1], outputRange: [height * 0.18, 0] }) }] }]}>
          <Svg width={width} height={height}>
            <Defs>
              <RadialGradient id="planetFill" cx="0.5" cy="0.1" r="0.7">
                <Stop offset="0" stopColor="#10284A" />
                <Stop offset="1" stopColor="#040A16" />
              </RadialGradient>
              <RadialGradient id="atmo" cx="0.5" cy="1" r="0.5">
                <Stop offset="0" stopColor="#3FE0DA" stopOpacity={0.28} />
                <Stop offset="1" stopColor="#3FE0DA" stopOpacity={0} />
              </RadialGradient>
              <LinearGradient id="rim" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#FF9A3D" stopOpacity={0} />
                <Stop offset="0.35" stopColor="#FF9A3D" stopOpacity={0.9} />
                <Stop offset="0.55" stopColor="#3FE0DA" stopOpacity={1} />
                <Stop offset="1" stopColor="#3FE0DA" stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y={height * 0.55} width={width} height={height * 0.45} fill="url(#atmo)" />
            <Circle cx={cx} cy={planetCy} r={planetR} fill="url(#planetFill)" />
            <Circle cx={cx} cy={planetCy} r={planetR} fill="none" stroke="url(#rim)" strokeWidth={14} strokeOpacity={0.18} />
            <Circle cx={cx} cy={planetCy} r={planetR} fill="none" stroke="url(#rim)" strokeWidth={2.2} />
          </Svg>
        </Animated.View>
        {/* Hyperspace streaks */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: warp.interpolate({ inputRange: [0, 0.08, 0.85, 1], outputRange: [0, 1, 1, 0] }) }]} pointerEvents="none">
          {streaks.map((s, i) => (
            <Animated.View key={i} style={[styles.streak, {
              left: cx - 1, top: cy - s.len / 2, height: s.len, backgroundColor: s.color,
              transform: [
                { rotate: `${s.angle}rad` },
                { translateY: warp.interpolate({ inputRange: [0, 1], outputRange: [-s.from, -s.from - s.reach] }) },
                { scaleY: warp.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.08, 1.6, 5] }) },
              ],
            }]} />
          ))}
        </Animated.View>
        {/* Emblem exactly at the centre, the wordmark below it */}
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Animated.View style={{ opacity: rise, transform: [{ scale: emblemScale }] }}>
            <NaviaEmblem size={EMBLEM} progress={draw} glow={glow} />
          </Animated.View>
          <View style={[styles.wordmark, { top: cy + EMBLEM / 2 + space.md }]} accessibilityLabel="NAVIA">
            {LETTERS.map((letter, i) => (
              <Animated.Text key={i} style={[typography.display, styles.letter, {
                opacity: letters[i],
                transform: [{ translateY: letters[i]!.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
              }]}>{letter}</Animated.Text>
            ))}
            <Animated.View pointerEvents="none" style={[styles.sweep, { transform: [{ translateX: sweepX }, { skewX: "-18deg" }] }]} />
          </View>
        </View>
      </Animated.View>
      {/* Light ribbons: born inside the emblem, they spread and rush past */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {ribbons.map((r, i) => (
          <Animated.View key={i} style={[styles.ribbon, {
            left: cx - r.width / 2, width: r.width, top: -height * 0.2, height: height * 1.4,
            opacity: burst.interpolate({ inputRange: [0, 0.3 + r.delay, 0.42 + r.delay, 0.8, 1], outputRange: [0, 0, 1, 0.9, 0] }),
            transform: [
              { translateX: burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [r.base * 0.1, r.base * 0.3, r.base * r.spread] }) },
              { scaleX: burst.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.3, 1, 3.2] }) },
              { scaleY: burst.interpolate({ inputRange: [0, 0.3, 0.55], outputRange: [0.02, 0.05, 1], extrapolate: "clamp" }) },
            ],
          }]}>
            <Svg width={r.width} height={height * 1.4}>
              <Defs>
                <LinearGradient id={`rib${i}`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={r.color} stopOpacity={0} />
                  <Stop offset="0.5" stopColor={r.color} stopOpacity={1} />
                  <Stop offset="1" stopColor={r.color} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width={r.width} height={height * 1.4} fill={`url(#rib${i})`} />
              <Rect x={r.width * 0.4} y={height * 0.3} width={r.width * 0.2} height={height * 0.8} fill="#FFFFFF" opacity={0.55} />
            </Svg>
          </Animated.View>
        ))}
        <Animated.View style={[StyleSheet.absoluteFill, styles.flash, { opacity: flash }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: { zIndex: 100, backgroundColor: "#02050C" },
  center: { alignItems: "center", justifyContent: "center" },
  star: { position: "absolute", backgroundColor: "#DDEBFF" },
  streak: { position: "absolute", width: 2, borderRadius: 1 },
  wordmark: { position: "absolute", flexDirection: "row", overflow: "hidden", paddingHorizontal: space.xs },
  letter: { marginHorizontal: space.xs, letterSpacing: 2, color: BRAND.textPrimary, textShadowColor: "rgba(63,224,218,0.6)", textShadowRadius: 12 },
  sweep: { position: "absolute", top: 0, bottom: 0, width: 36, backgroundColor: "rgba(255,255,255,0.35)" },
  ribbon: { position: "absolute" },
  flash: { backgroundColor: "#FFFFFF" },
});
