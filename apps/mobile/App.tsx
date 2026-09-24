import React from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { AppSettingsProvider, useAppSettings } from "./src/settings/AppSettings";
import { IntroOverlay } from "./src/components/IntroOverlay";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";

export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <AppSettingsProvider><AppContent /></AppSettingsProvider>
    </SafeAreaProvider>
  );
}

function AppContent(): JSX.Element {
  const { isDark, colors: c } = useAppSettings();
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
