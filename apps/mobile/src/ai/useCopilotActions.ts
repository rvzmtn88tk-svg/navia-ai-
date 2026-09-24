// Executes the co-pilot's action buttons: build a route, call 112/103, open
// an official link, confirm a turn or correct the position without GPS.
import { useCallback } from "react";
import { Linking } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { navigationEngine, useNaviaStore } from "../engine/naviaController";
import { usePlacesStore } from "../store/placesStore";
import { useT } from "../i18n";
import type { CopilotAction } from "./copilotBrain";

export function useCopilotActions(onAsk?: (question: string) => void): (action: CopilotAction) => void {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { lang } = useT();
  return useCallback((a: CopilotAction) => {
    switch (a.kind) {
      case "route":
        useNaviaStore.getState().setDemoMode(false);
        usePlacesStore.getState().addRecent({ id: `${a.place.lat.toFixed(5)},${a.place.lon.toFixed(5)}`, label: a.place.name, lat: a.place.lat, lon: a.place.lon });
        navigation.navigate("Navigation", { destinationLat: a.place.lat, destinationLon: a.place.lon, destinationLabel: a.place.name, mode: a.mode });
        return;
      case "call":
        void Linking.openURL(`tel:${a.number}`).catch(() => {});
        return;
      case "open":
        void Linking.openURL(a.url).catch(() => {});
        return;
      case "search":
        navigation.navigate("Search", a.query ? { initialQuery: a.query } : undefined);
        return;
      case "confirmTurn":
        navigationEngine.confirmManeuverReached();
        useNaviaStore.getState().refresh();
        return;
      case "correctPosition":
        navigationEngine.setManualPosition({ lat: a.place.lat, lon: a.place.lon });
        useNaviaStore.getState().refresh();
        return;
      case "safety": {
        // During a trip, going "Home" would end the navigation: answer here instead.
        const inTrip = (navigation.getState()?.routes ?? []).some((r) => r.name === "Navigation");
        if (inTrip && onAsk) { onAsk(lang === "uk" ? "Де найближче укриття?" : "Where is the nearest shelter?"); return; }
        navigation.navigate("Home", { openSafety: true });
        return;
      }
      case "ask":
        onAsk?.(a.question);
        return;
    }
  }, [lang, navigation, onAsk]);
}
