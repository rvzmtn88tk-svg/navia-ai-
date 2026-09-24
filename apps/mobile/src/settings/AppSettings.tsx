import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import Storage from "expo-sqlite/kv-store";

export type ThemePreference = "system" | "light" | "dark";
export type AppLanguage = "uk" | "en";

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

const darkPalette: AppPalette = {
  background: "#08111d", surface: "#101d2a", surfaceRaised: "#162637", border: "#26394c",
  text: "#f4f8fb", muted: "#9aaabd", subtle: "#71869b", accent: "#62e2d3", accentText: "#07201f",
  danger: "#ff9e9e", warning: "#e3b565", field: "#132131",
};
const lightPalette: AppPalette = {
  background: "#f3f6f8", surface: "#ffffff", surfaceRaised: "#e8eff2", border: "#d7e1e6",
  text: "#10212d", muted: "#526775", subtle: "#738591", accent: "#087f78", accentText: "#ffffff",
  danger: "#b42335", warning: "#8a6214", field: "#edf2f4",
};

type SettingsContextValue = {
  themePreference: ThemePreference;
  isDark: boolean;
  palette: AppPalette;
  language: AppLanguage;
  displayName: string;
  introSoundEnabled: boolean;
  ready: boolean;
  onboardingComplete: boolean;
  setThemePreference: (value: ThemePreference) => void;
  setLanguage: (value: AppLanguage) => void;
  setDisplayName: (value: string) => void;
  setIntroSoundEnabled: (value: boolean) => void;
  completeOnboarding: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);
const THEME_KEY = "navia.preference.theme.v1";
const LANGUAGE_KEY = "navia.preference.language.v1";
const DISPLAY_NAME_KEY = "navia.profile.display-name.v1";
const INTRO_SOUND_KEY = "navia.preference.intro-sound.v1";
const ONBOARDING_KEY = "navia.onboarding.complete.v1";

export function AppSettingsProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const systemScheme = useColorScheme();
  const [themePreference, setTheme] = useState<ThemePreference>("system");
  const [language, setAppLanguage] = useState<AppLanguage>("uk");
  const [displayName, setDisplayNameState] = useState("");
  const [introSoundEnabled, setIntroSoundState] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      Storage.getItemAsync(THEME_KEY).catch(() => null),
      Storage.getItemAsync(LANGUAGE_KEY).catch(() => null),
      Storage.getItemAsync(DISPLAY_NAME_KEY).catch(() => null),
      Storage.getItemAsync(INTRO_SOUND_KEY).catch(() => null),
      Storage.getItemAsync(ONBOARDING_KEY).catch(() => null),
    ]).then(([storedTheme, storedLanguage, storedName, storedSound, storedOnboarding]) => {
      if (!active) return;
      if (storedTheme === "system" || storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
      if (storedLanguage === "uk" || storedLanguage === "en") setAppLanguage(storedLanguage);
      setDisplayNameState(storedName?.slice(0, 40) ?? "");
      if (storedSound === "no" || storedSound === "yes") setIntroSoundState(storedSound === "yes");
      setOnboardingComplete(storedOnboarding === "yes");
      setReady(true);
    });
    return () => { active = false; };
  }, []);

  const isDark = themePreference === "system" ? systemScheme !== "light" : themePreference === "dark";
  const value = useMemo<SettingsContextValue>(() => ({
    themePreference,
    isDark,
    palette: isDark ? darkPalette : lightPalette,
    language,
    displayName,
    introSoundEnabled,
    ready,
    onboardingComplete,
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
    setIntroSoundEnabled: (next) => {
      setIntroSoundState(next);
      void Storage.setItemAsync(INTRO_SOUND_KEY, next ? "yes" : "no").catch(() => {});
    },
    completeOnboarding: () => {
      setOnboardingComplete(true);
      void Storage.setItemAsync(ONBOARDING_KEY, "yes").catch(() => {});
    },
  }), [displayName, introSoundEnabled, isDark, language, onboardingComplete, ready, themePreference]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useAppSettings must be used inside AppSettingsProvider");
  return value;
}
