// React Navigation stack. Feature screens load only when opened so the home
// view is not delayed by route-only sensor and speech modules.
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAppSettings } from "../settings/AppSettings";
import { useT } from "../i18n";
import { typography } from "../theme/tokens";
import type { PlaceRef, SavedSlot } from "../store/placesStore";

export type RouteMode = "car" | "walk";

export type RootStackParamList = {
  Home: { focusPlace?: PlaceRef; category?: string; openSafety?: boolean } | undefined;
  Search: { pickFor?: SavedSlot; initialQuery?: string } | undefined;
  Navigation: { destinationLat: number; destinationLon: number; destinationLabel: string; mode?: RouteMode };
  Diagnostics: undefined;
  Settings: undefined;
  Sources: undefined;
  Assistant: { initialQuestion?: string; voice?: boolean } | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): JSX.Element {
  const { colors } = useAppSettings();
  const { t } = useT();
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{
      headerShown: true,
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.accent,
      headerTitleStyle: { ...typography.headline, color: colors.textPrimary },
      headerShadowVisible: false,
      headerBackTitle: t("common.back"),
      contentStyle: { backgroundColor: colors.background },
    }}>
      {/* Defer each feature tree until it is opened. In particular, do not
          initialize native sensor, speech and map screens while the app is
          still entering its home screen. */}
      <Stack.Screen name="Home" getComponent={() => require("../screens/HomeScreen").HomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Search" getComponent={() => require("../screens/SearchScreen").SearchScreen} options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="Navigation" getComponent={() => require("../screens/NavigationScreen").NavigationScreen} options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="Assistant" getComponent={() => require("../screens/AssistantScreen").AssistantScreen} options={{ title: t("copilot.title"), presentation: "modal" }} />
      <Stack.Screen name="Settings" getComponent={() => require("../screens/SettingsScreen").SettingsScreen} options={{ title: t("settings.title") }} />
      <Stack.Screen name="Sources" getComponent={() => require("../screens/SourcesScreen").SourcesScreen} options={{ title: t("sources.title"), presentation: "modal" }} />
      <Stack.Screen name="Diagnostics" getComponent={() => require("../screens/DiagnosticsScreen").DiagnosticsScreen} options={{ title: t("settings.diagnostics") }} />
    </Stack.Navigator>
  );
}
