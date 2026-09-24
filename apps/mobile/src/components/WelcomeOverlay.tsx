import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text as NativeText, View } from "react-native";
import { APP_FONT_FAMILY, AppText as Text } from "./AppText";
import { Audio } from "expo-av";
import { useAppSettings } from "../settings/AppSettings";
import { BrandMark } from "./BrandMark";

const INTRO = {
  background: "#0b1220",
  surface: "#101d2a",
  border: "#26394c",
  text: "#f4f8fb",
  muted: "#9aaabd",
  subtle: "#71869b",
  accent: "#62e2d3",
  accentText: "#07201f",
  danger: "#ff9e9e",
};

export function WelcomeOverlay(): JSX.Element | null {
  const { ready, onboardingComplete, completeOnboarding, language, introSoundEnabled } = useAppSettings();
  const [visible, setVisible] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const scale = useRef(new Animated.Value(0.88)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const haloScale = useRef(new Animated.Value(1)).current;
  const haloOpacity = useRef(new Animated.Value(0.16)).current;
  const welcomeOpacity = useRef(new Animated.Value(0)).current;
  const welcomeOffset = useRef(new Animated.Value(8)).current;
  const guideOpacity = useRef(new Animated.Value(0)).current;
  const guideOffset = useRef(new Animated.Value(10)).current;
  const sloganMotion = useRef([
    { opacity: new Animated.Value(0), offset: new Animated.Value(10) },
    { opacity: new Animated.Value(0), offset: new Animated.Value(10) },
    { opacity: new Animated.Value(0), offset: new Animated.Value(10) },
  ]).current;
  const preferences = useRef({ onboardingComplete, introSoundEnabled });
  preferences.current = { onboardingComplete, introSoundEnabled };

  useEffect(() => {
    if (!ready) return;
    setVisible(true);
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.parallel([
        Animated.timing(haloScale, { toValue: 1.36, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(haloOpacity, { toValue: 0, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(280),
        Animated.parallel([
          Animated.timing(welcomeOpacity, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(welcomeOffset, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]),
      ]),
    ]).start();
    Animated.sequence([
      Animated.delay(520),
      Animated.stagger(120, sloganMotion.map((line) => Animated.parallel([
        Animated.timing(line.opacity, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(line.offset, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]))),
    ]).start();

    let sound: Audio.Sound | null = null;
    let disposed = false;
    let guideTimer: ReturnType<typeof setTimeout> | null = null;
    // Keep the brand line on screen long enough to read on repeat launches too,
    // then fade the whole welcome card into the live app.
    const duration = preferences.current.onboardingComplete ? 6500 : 12000;
    const hideTimer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    }, duration - 450);
    if (!preferences.current.onboardingComplete) {
      guideTimer = setTimeout(() => {
        setShowGuide(true);
        requestAnimationFrame(() => Animated.parallel([
          Animated.timing(guideOpacity, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(guideOffset, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]).start());
      }, 800);
    }
    if (preferences.current.introSoundEnabled) {
      void Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: true }).then(async () => {
        const loaded = await Audio.Sound.createAsync(require("../../assets/navia-intro.wav"), { shouldPlay: true, volume: 0.5 });
        if (disposed) void loaded.sound.unloadAsync().catch(() => {});
        else sound = loaded.sound;
      }).catch(() => {});
    }
    return () => {
      disposed = true;
      clearTimeout(hideTimer);
      if (guideTimer) clearTimeout(guideTimer);
      if (sound) void sound.unloadAsync().catch(() => {});
    };
  }, [ready, opacity, scale, haloOpacity, haloScale, welcomeOpacity, welcomeOffset, guideOpacity, guideOffset, sloganMotion]);

  if (!visible) return null;
  const en = language === "en";
  const slogan = en ? ["NAVIGATE", "ACT", "STAY SAFE"] : ["НАВІГУЙ", "ДІЙ", "БУДЬ У БЕЗПЕЦІ"];
  return (
    <View style={[styles.cover, { backgroundColor: INTRO.background }]}>
      <Animated.View style={[styles.body, { opacity }]}>
        <View style={styles.markStage}>
          <View style={[styles.logoGlow, { backgroundColor: INTRO.accent }]} />
          <Animated.View style={[styles.halo, { borderColor: INTRO.accent, opacity: haloOpacity, transform: [{ scale: haloScale }] }]} />
          <Animated.View style={{ transform: [{ scale }] }}><BrandMark size={210} /></Animated.View>
        </View>
        <NativeText allowFontScaling={false} style={[styles.brand, { color: INTRO.text }]}>NAVIA</NativeText>
        <Animated.View style={{ opacity: welcomeOpacity, transform: [{ translateY: welcomeOffset }] }}>
          <NativeText allowFontScaling={false} style={[styles.greeting, { color: INTRO.accent }]}>{en ? "WELCOME" : "ЛАСКАВО ПРОСИМО"}</NativeText>
        </Animated.View>
        <View style={styles.sloganStack}>
          {slogan.map((line, index) => {
            const motion = sloganMotion[index];
            if (!motion) return null;
            return <Animated.View key={line} style={{ opacity: motion.opacity, transform: [{ translateY: motion.offset }] }}>
              <NativeText allowFontScaling={false} style={[styles.sloganLine, { color: INTRO.text }]}>{line}</NativeText>
            </Animated.View>;
          })}
        </View>
        {showGuide && (
          <Animated.View style={[styles.guide, { backgroundColor: INTRO.surface, borderColor: INTRO.border, opacity: guideOpacity, transform: [{ translateY: guideOffset }] }]}>
            <Text style={[styles.title, { color: INTRO.text }]}>{en ? "Your route. Your co-pilot." : "Твій маршрут. Твій штурман."}</Text>
            <Text style={[styles.subtitle, { color: INTRO.muted }]}>{en ? "Live maps, GPS guidance, alerts and essential places — together in one navigator." : "Жива мапа, GPS-навігація, тривоги й потрібні місця поруч — в одному навігаторі."}</Text>
            <View style={styles.featureRow}><Text style={[styles.featureIcon, { color: INTRO.accent }]}>⌖</Text><Text style={[styles.featureText, { color: INTRO.text }]}>{en ? "Live map and position" : "Жива мапа й місце перебування"}</Text></View>
            <View style={styles.featureRow}><Text style={[styles.featureIcon, { color: INTRO.danger }]}>!</Text><Text style={[styles.featureText, { color: INTRO.text }]}>{en ? "Regional alerts with source and time" : "Тривоги з указаним джерелом і часом"}</Text></View>
            <View style={styles.featureRow}><Text style={[styles.featureIcon, { color: INTRO.accent }]}>✦</Text><Text style={[styles.featureText, { color: INTRO.text }]}>{en ? "Ask NAVIA about your route and nearby places" : "Запитуй NAVIA про шлях і місця поруч"}</Text></View>
            <Text style={[styles.small, { color: INTRO.subtle }]}>{en ? "NAVIA's reports are informational. Follow official alerts and emergency-service instructions." : "Повідомлення NAVIA мають інформаційний характер. Дотримуйся офіційних тривог та вказівок служб."}</Text>
            <Pressable style={[styles.button, { backgroundColor: INTRO.accent }]} onPress={() => { completeOnboarding(); setVisible(false); }}><Text style={[styles.buttonText, { color: INTRO.accentText }]}>{en ? "Let's go" : "Почати"}　→</Text></Pressable>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFillObject, zIndex: 100, justifyContent: "center", paddingHorizontal: 24 },
  body: { alignItems: "center", maxWidth: 440, width: "100%", alignSelf: "center" },
  markStage: { width: 282, height: 282, alignItems: "center", justifyContent: "center" },
  logoGlow: { position: "absolute", width: 270, height: 270, borderRadius: 135, opacity: 0.035, shadowColor: "#62e2d3", shadowOpacity: 0.6, shadowRadius: 100, shadowOffset: { width: 0, height: 0 }, elevation: 14 },
  halo: { position: "absolute", width: 258, height: 258, borderWidth: 1.5, borderRadius: 129 },
  brand: { fontFamily: APP_FONT_FAMILY, fontSize: 22, fontWeight: "700", letterSpacing: 4.7, marginTop: 2 },
  greeting: { fontFamily: APP_FONT_FAMILY, fontSize: 14, fontWeight: "700", letterSpacing: 1.2, textAlign: "center", marginTop: 9 },
  sloganStack: { alignItems: "center", gap: 8, marginTop: 20 },
  sloganLine: { fontFamily: APP_FONT_FAMILY, fontSize: 18, lineHeight: 24, fontWeight: "700", letterSpacing: 1.2, textAlign: "center" },
  guide: { width: "100%", borderWidth: 1, borderRadius: 23, paddingHorizontal: 19, paddingVertical: 18, marginTop: 23 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "800", textAlign: "center" },
  subtitle: { fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7, marginBottom: 12 },
  featureRow: { minHeight: 37, flexDirection: "row", alignItems: "center" },
  featureIcon: { fontSize: 17, fontWeight: "900", width: 28, textAlign: "center", marginRight: 5 },
  featureText: { fontSize: 11, fontWeight: "600", flex: 1 },
  small: { fontSize: 9, lineHeight: 14, textAlign: "center", marginTop: 10, paddingHorizontal: 3 },
  button: { width: "100%", minHeight: 49, borderRadius: 16, alignItems: "center", justifyContent: "center", marginTop: 15 },
  buttonText: { fontSize: 14, fontWeight: "800" },
});
