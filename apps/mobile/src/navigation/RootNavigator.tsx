// React Navigation stack. Feature screens load only when opened so the home
// view is not delayed by route-only sensor and speech modules.
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAppSettings } from "../settings/AppSettings";
import { APP_FONT_FAMILY } from "../components/AppText";

export type RootStackParamList = {
  Home: undefined;
  Search: undefined;
  Navigation: { destinationLat: number; destinationLon: number; destinationLabel: string };
  Diagnostics: undefined;
  Settings: undefined;
  Assistant: { initialQuestion?: string } | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{ headerShown: true, headerStyle: { backgroundColor: p.surface }, headerTintColor: p.text, headerTitleStyle: { fontFamily: APP_FONT_FAMILY, fontWeight: "600", fontSize: 18 }, headerShadowVisible: false, contentStyle: { backgroundColor: p.background } }}>
      {/* Defer each feature tree until it is opened. In particular, do not
          initialize native sensor, speech and map screens while the app is
          still entering its home screen. */}
      <Stack.Screen name="Home" getComponent={() => require("../screens/HomeScreen").HomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Search" getComponent={() => require("../screens/SearchScreen").SearchScreen} options={{ title: en ? "Choose destination" : "Куди їдемо?" }} />
      <Stack.Screen name="Navigation" getComponent={() => require("../screens/NavigationScreen").NavigationScreen} options={{ title: en ? "Navigation" : "Навігація", headerShown: false }} />
      <Stack.Screen name="Assistant" getComponent={() => require("../screens/AssistantScreen").AssistantScreen} options={{ title: en ? "NAVIA co-pilot" : "Штурман NAVIA" }} />
      <Stack.Screen name="Settings" getComponent={() => require("../screens/SettingsScreen").SettingsScreen} options={{ title: en ? "Settings" : "Налаштування" }} />
      <Stack.Screen name="Diagnostics" getComponent={() => require("../screens/DiagnosticsScreen").DiagnosticsScreen} options={{ title: en ? "Device diagnostics" : "Діагностика" }} />
    </Stack.Navigator>
  );
}
