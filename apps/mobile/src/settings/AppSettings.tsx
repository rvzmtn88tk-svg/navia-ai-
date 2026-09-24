import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { palettes, type ColorScheme, type ThemeColors } from "../theme/tokens";

export type ThemePreference = "system" | "light" | "dark";
export type AppLanguage = "uk" | "en";
export type MapLayer = "standard" | "satellite" | "terrain";
export type VoiceGender = "female" | "male";

export type AppPalette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  accentText: string;
  danger: string;
  warning: string;
  field: string;
};

// Legacy palette shape for screens not yet moved to `colors`; derived from the
// design tokens so both stay in sync.
function legacyPalette(c: ThemeColors): AppPalette {
  return {
    background: c.background, surface: c.surface, surfaceRaised: c.surfaceMuted, border: c.border,
    text: c.textPrimary, muted: c.textSecondary, subtle: c.textMuted, accent: c.accent, accentText: c.onAccent,
    danger: c.critical, warning: c.warning, field: c.surfaceMuted,
  };
}
const darkPalette = legacyPalette(palettes.dark);
const lightPalette = legacyPalette(palettes.light);

type SettingsContextValue = {
  themePreference: ThemePreference;
  isDark: boolean;
  scheme: ColorScheme;
  colors: ThemeColors;
  /** @deprecated use `colors` */
  palette: AppPalette;
  language: AppLanguage;
  displayName: string;
  introSoundEnabled: boolean;
  briefingEnabled: boolean;
  ready: boolean;
  onboardingComplete: boolean;
  mapLayer: MapLayer;
  voiceGender: VoiceGender;
  setMapLayer: (value: MapLayer) => void;
  setVoiceGender: (value: VoiceGender) => void;
  setThemePreference: (value: ThemePreference) => void;
  setLanguage: (value: AppLanguage) => void;
  setDisplayName: (value: string) => void;
  setIntroSoundEnabled: (value: boolean) => void;
  setBriefingEnabled: (value: boolean) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);
const THEME_KEY = "navia.preference.theme.v1";
const LANGUAGE_KEY = "navia.preference.language.v1";
const DISPLAY_NAME_KEY = "navia.profile.display-name.v1";
const INTRO_SOUND_KEY = "navia.preference.intro-sound.v1";
const BRIEFING_KEY = "navia.preference.briefing.v1";
const ONBOARDING_KEY = "navia.onboarding.complete.v1";
const MAP_LAYER_KEY = "navia.preference.map-layer.v1";
const VOICE_GENDER_KEY = "navia.preference.voice-gender.v1";

export function AppSettingsProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const systemScheme = useColorScheme();
  const [themePreference, setTheme] = useState<ThemePreference>("system");
  const [language, setAppLanguage] = useState<AppLanguage>("uk");
  const [displayName, setDisplayNameState] = useState("");
  const [introSoundEnabled, setIntroSoundState] = useState(true);
  const [briefingEnabled, setBriefingState] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [ready, setReady] = useState(false);
  const [mapLayer, setMapLayerState] = useState<MapLayer>("standard");
  const [voiceGender, setVoiceGenderState] = useState<VoiceGender>("female");

  useEffect(() => {
    let active = true;
    void Promise.all([
      Storage.getItemAsync(THEME_KEY).catch(() => null),
      Storage.getItemAsync(LANGUAGE_KEY).catch(() => null),
      Storage.getItemAsync(DISPLAY_NAME_KEY).catch(() => null),
      Storage.getItemAsync(INTRO_SOUND_KEY).catch(() => null),
      Storage.getItemAsync(ONBOARDING_KEY).catch(() => null),
      Storage.getItemAsync(MAP_LAYER_KEY).catch(() => null),
      Storage.getItemAsync(VOICE_GENDER_KEY).catch(() => null),
      Storage.getItemAsync(BRIEFING_KEY).catch(() => null),
    ]).then(([storedTheme, storedLanguage, storedName, storedSound, storedOnboarding, storedLayer, storedVoice, storedBriefing]) => {
      if (!active) return;
      if (storedTheme === "system" || storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
      if (storedLanguage === "uk" || storedLanguage === "en") setAppLanguage(storedLanguage);
      setDisplayNameState(storedName?.slice(0, 40) ?? "");
      if (storedSound === "no" || storedSound === "yes") setIntroSoundState(storedSound === "yes");
      setOnboardingComplete(storedOnboarding === "yes");
      if (storedLayer === "standard" || storedLayer === "satellite" || storedLayer === "terrain") setMapLayerState(storedLayer);
      if (storedVoice === "female" || storedVoice === "male") setVoiceGenderState(storedVoice);
      if (storedBriefing === "no") setBriefingState(false);
      setReady(true);
    });
    return () => { active = false; };
  }, []);

  const isDark = themePreference === "system" ? systemScheme === "dark" : themePreference === "dark";
  const value = useMemo<SettingsContextValue>(() => ({
    themePreference,
    isDark,
    // Day = "Lunar" (light chrome + light map), night = "Deep Space".
    scheme: isDark ? "dark" : "light",
    colors: isDark ? palettes.dark : palettes.light,
    palette: isDark ? darkPalette : lightPalette,
    language,
    displayName,
    introSoundEnabled,
    briefingEnabled,
    ready,
    onboardingComplete,
    mapLayer,
    voiceGender,
    setMapLayer: (next) => {
      setMapLayerState(next);
      void Storage.setItemAsync(MAP_LAYER_KEY, next).catch(() => {});
    },
    setVoiceGender: (next) => {
      setVoiceGenderState(next);
      void Storage.setItemAsync(VOICE_GENDER_KEY, next).catch(() => {});
    },
    setThemePreference: (next) => {
      setTheme(next);
      void Storage.setItemAsync(THEME_KEY, next).catch(() => {});
    },
    setLanguage: (next) => {
      setAppLanguage(next);
      void Storage.setItemAsync(LANGUAGE_KEY, next).catch(() => {});
    },
    setDisplayName: (next) => {
      const normalized = next.slice(0, 40);
      setDisplayNameState(normalized);
      void Storage.setItemAsync(DISPLAY_NAME_KEY, normalized).catch(() => {});
    },
    setBriefingEnabled: (next) => {
      setBriefingState(next);
      void Storage.setItemAsync(BRIEFING_KEY, next ? "yes" : "no").catch(() => {});
    },
    setIntroSoundEnabled: (next) => {
      setIntroSoundState(next);
      void Storage.setItemAsync(INTRO_SOUND_KEY, next ? "yes" : "no").catch(() => {});
    },
    completeOnboarding: () => {
      setOnboardingComplete(true);
      void Storage.setItemAsync(ONBOARDING_KEY, "yes").catch(() => {});
    },
    resetOnboarding: () => {
      setOnboardingComplete(false);
      void Storage.setItemAsync(ONBOARDING_KEY, "no").catch(() => {});
    },
  }), [briefingEnabled, displayName, introSoundEnabled, isDark, language, mapLayer, onboardingComplete, ready, themePreference, voiceGender]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useAppSettings must be used inside AppSettingsProvider");
  return value;
}
