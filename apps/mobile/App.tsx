import React from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { benchHooks } from "./src/perf/bench";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { AppSettingsProvider, useAppSettings } from "./src/settings/AppSettings";
import { IntroOverlay } from "./src/components/IntroOverlay";
import { AuthProvider } from "./src/auth/AuthProvider";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";
// Loaded at start: when NAVIA was launched in "no internet" test mode, the
// app's own requests must fail from the first one, like the map's.
import "./src/offline/network";
import { installNetLog, runNetSelfTest, selfTestRequestedAtLaunch } from "./src/net/netLog";
import { startVehicleSpeed } from "./src/engine/naviaController";

// Every failed request is kept (host, status/error, time) for Diagnostics and
// for reading back from the phone; `-NaviaNetTest YES` repeats a service check.
installNetLog();
// The car's speed from an OBD adapter, when the driver switched it on in Settings.
startVehicleSpeed();
if (selfTestRequestedAtLaunch()) {
  setTimeout(() => void runNetSelfTest(), 3000);
  setInterval(() => void runNetSelfTest(), 30_000);
}

const navigationRef = createNavigationContainerRef();
// Benchmark only: open the co-pilot screen (perf/bench.ts).
benchHooks.openAssistant = () => { if (navigationRef.isReady()) (navigationRef.navigate as (name: string) => void)("Assistant"); };

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
    <NavigationContainer ref={navigationRef} theme={navigationTheme}><AppErrorBoundary><RootNavigator /></AppErrorBoundary></NavigationContainer>
    <IntroOverlay />
  </>;
}
