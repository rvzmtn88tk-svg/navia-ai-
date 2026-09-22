// Home screen — spec section 16's minimal, driver-oriented list ("Куди
// едем? / Поиск адреса / Домой / Последние маршруты / Диагностика / Demo
// Mode"), explicitly NOT a marketing landing page. UNBUILT/UNTESTED (see
// App.tsx).
import React from "react";
import { View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useNaviaStore } from "../engine/naviaController";
import { DEMO_DESTINATION } from "@navia/core";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export function HomeScreen({ navigation }: Props): JSX.Element {
  const { recentDestinations, setDemoMode } = useNaviaStore();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>NAVIA</Text>

      <Pressable style={styles.primaryButton} onPress={() => navigation.navigate("Search")}>
        <Text style={styles.primaryButtonText}>Куди їдемо?</Text>
      </Pressable>

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
              >
                <Text style={styles.recentText}>{item.label}</Text>
              </Pressable>
            )}
          />
        </>
      )}

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
  secondaryButton: { flex: 1, backgroundColor: "#1a2233", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  secondaryButtonText: { color: "#8892a6", fontSize: 14, fontWeight: "600" },
});
