// NAVIA mobile app root. UNBUILT/UNTESTED in this sandbox — see
// package.json's description, BUILD.md and LIMITATIONS.md. Structurally
// mirrors the standard Expo + React Navigation shell; wires the app to the
// real @navia/core engines via src/providers (no mock navigation logic here
// — the mobile layer's only job is sensors-in, UI-out; all navigation
// decisions live in @navia/core, same as the section 26 "don't build a
// separate fake UI engine" rule for Demo Mode).
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./src/navigation/RootNavigator";

export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
