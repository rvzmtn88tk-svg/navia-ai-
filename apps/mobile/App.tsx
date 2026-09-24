import React from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { AppSettingsProvider, useAppSettings } from "./src/settings/AppSettings";
import { WelcomeOverlay } from "./src/components/WelcomeOverlay";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";

export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <AppSettingsProvider><AppContent /></AppSettingsProvider>
    </SafeAreaProvider>
  );
}

function AppContent(): JSX.Element {
  const { isDark, palette: p } = useAppSettings();
  const navigationTheme = {
    ...DefaultTheme,
    dark: isDark,
    colors: { ...DefaultTheme.colors, primary: p.accent, background: p.background, card: p.surface, text: p.text, border: p.border, notification: p.danger },
  };
  return <>
    <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={p.background} />
    <NavigationContainer theme={navigationTheme}><AppErrorBoundary><RootNavigator /></AppErrorBoundary></NavigationContainer>
    <WelcomeOverlay />
  </>;
}
