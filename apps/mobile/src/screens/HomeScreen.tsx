// Home screen — spec section 16's minimal, driver-oriented list ("Куди
// едем? / Поиск адреса / Домой / Последние маршруты / Диагностика / Demo
// Mode"), explicitly NOT a marketing landing page. UNBUILT/UNTESTED (see
// App.tsx).
import React from "react";
import { View, Text, Pressable, FlatList, Switch, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useNaviaStore, isSmartCopilotConfigured } from "../engine/naviaController";
import { DEMO_DESTINATION } from "@navia/core";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export function HomeScreen({ navigation }: Props): JSX.Element {
  const { recentDestinations, setDemoMode, savedPlaces, savePlace, aiContextConsent, setAiContextConsent } = useNaviaStore();
  const home = savedPlaces.find((p) => p.kind === "home");

  return (
    <View style={styles.container}>
      <Text style={styles.title}>NAVIA</Text>

      <Pressable style={styles.primaryButton} onPress={() => navigation.navigate("Search")}>
        <Text style={styles.primaryButtonText}>Куди їдемо?</Text>
      </Pressable>

      {home && (
        <Pressable
          style={styles.homeButton}
          onPress={() => {
            setDemoMode(false);
            navigation.navigate("Navigation", { destinationLat: home.location.lat, destinationLon: home.location.lon, destinationLabel: home.label });
          }}
        >
          <Text style={styles.homeButtonText}>Додому</Text>
        </Pressable>
      )}

      {recentDestinations.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Останні маршрути</Text>
          <FlatList
            data={recentDestinations}
            keyExtractor={(item) => `${item.lat},${item.lon},${item.visitedAt}`}
            renderItem={({ item }) => (
              <Pressable
                style={styles.recentRow}
                onPress={() => navigation.navigate("Navigation", { destinationLat: item.lat, destinationLon: item.lon, destinationLabel: item.label })}
                onLongPress={() => savePlace({ kind: "home", label: item.label, location: { lat: item.lat, lon: item.lon } })}
              >
                <Text style={styles.recentText}>{item.label}</Text>
              </Pressable>
            )}
          />
        </>
      )}

      {recentDestinations.length > 0 && <Text style={styles.hint}>Утримуйте адресу, щоб зберегти її як «Дім».</Text>}

      {/* Spec section 30: location context goes to the AI backend only with explicit consent (default OFF). */}
      <View style={styles.consentRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.consentTitle}>Надсилати контекст поїздки ШІ</Text>
          <Text style={styles.consentSub}>
            {isSmartCopilotConfigured()
              ? "Розумний штурман отримує дорогу, маршрут і знайдені місця (без координат). Вимкнено — лише локальні відповіді."
              : "Сервер ШІ не налаштований у цій збірці — працюють лише локальні відповіді."}
          </Text>
        </View>
        <Switch value={aiContextConsent} onValueChange={setAiContextConsent} disabled={!isSmartCopilotConfigured()} />
      </View>

      <View style={styles.secondaryRow}>
        <Pressable style={styles.secondaryButton} onPress={() => navigation.navigate("Diagnostics")}>
          <Text style={styles.secondaryButtonText}>Діагностика</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            setDemoMode(true);
            navigation.navigate("Navigation", {
              destinationLat: DEMO_DESTINATION.lat,
              destinationLon: DEMO_DESTINATION.lon,
              destinationLabel: "Бориспіль (demo)",
            });
          }}
        >
          <Text style={styles.secondaryButtonText}>Demo Mode</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220", padding: 24, justifyContent: "center" },
  title: { color: "#fff", fontSize: 34, fontWeight: "800", marginBottom: 32, textAlign: "center" },
  primaryButton: { backgroundColor: "#2dd4bf", borderRadius: 14, paddingVertical: 18, alignItems: "center", marginBottom: 24 },
  primaryButtonText: { color: "#0b1220", fontSize: 18, fontWeight: "700" },
  sectionLabel: { color: "#8892a6", fontSize: 13, marginBottom: 8, textTransform: "uppercase" },
  recentRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#1a2233" },
  recentText: { color: "#fff", fontSize: 15 },
  secondaryRow: { flexDirection: "row", gap: 12, marginTop: 32 },
  homeButton: { backgroundColor: "#1a2233", borderRadius: 14, paddingVertical: 14, alignItems: "center", marginBottom: 24 },
  homeButtonText: { color: "#2dd4bf", fontSize: 16, fontWeight: "700" },
  hint: { color: "#5b6478", fontSize: 11, marginTop: 6 },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 24, backgroundColor: "#111a2b", borderRadius: 12, padding: 12 },
  consentTitle: { color: "#fff", fontSize: 14, fontWeight: "600" },
  consentSub: { color: "#8892a6", fontSize: 11, marginTop: 2 },
  secondaryButton: { flex: 1, backgroundColor: "#1a2233", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  secondaryButtonText: { color: "#8892a6", fontSize: 14, fontWeight: "600" },
});
