// React Navigation stack: Home -> Search -> Navigation (active drive), plus
// Diagnostics (developer screen, spec section 31). UNBUILT/UNTESTED — see
// App.tsx. Home is the real first screen (spec section 16's "minimalistic,
// driver-oriented home screen" list); Search is a distinct address-input
// screen, matching the user's exact required flow (Open NAVIA -> Search ->
// enter address -> pick -> route -> navigate).
import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { HomeScreen } from "../screens/HomeScreen";
import { SearchScreen } from "../screens/SearchScreen";
import { NavigationScreen } from "../screens/NavigationScreen";
import { DiagnosticsScreen } from "../screens/DiagnosticsScreen";

export type RootStackParamList = {
  Home: undefined;
  Search: undefined;
  Navigation: { destinationLat: number; destinationLon: number; destinationLabel: string };
  Diagnostics: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): JSX.Element {
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{ headerShown: true }}>
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: "NAVIA" }} />
      <Stack.Screen name="Search" component={SearchScreen} options={{ title: "Куди їдемо?" }} />
      <Stack.Screen name="Navigation" component={NavigationScreen} options={{ title: "Навігація", headerShown: false }} />
      <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} options={{ title: "Diagnostics (dev)" }} />
    </Stack.Navigator>
  );
}
