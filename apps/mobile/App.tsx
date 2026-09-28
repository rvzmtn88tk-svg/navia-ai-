import React from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { AppSettingsProvider, useAppSettings } from "./src/settings/AppSettings";
import { IntroOverlay } from "./src/components/IntroOverlay";
import { AuthProvider } from "./src/auth/AuthProvider";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";
// Loaded at start: when NAVIA was launched in "no internet" test mode, the
// app's own requests must fail from the first one, like the map's.
import "./src/offline/network";

export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <AppSettingsProvider><AuthProvider><AppContent /></AuthProvider></AppSettingsProvider>
    </SafeAreaProvider>
  );
}

function AppContent(): JSX.Element {
  const { colors: c, isDark } = useAppSettings();
  const navigationTheme = {
    ...DefaultTheme,
    dark: isDark,
    colors: { ...DefaultTheme.colors, primary: c.accent, background: c.background, card: c.surface, text: c.textPrimary, border: c.border, notification: c.critical },
  };
  return <>
    <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={c.background} />
    <NavigationContainer theme={navigationTheme}><AppErrorBoundary><RootNavigator /></AppErrorBoundary></NavigationContainer>
    <IntroOverlay />
  </>;
}
