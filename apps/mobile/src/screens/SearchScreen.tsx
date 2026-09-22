// Search/destination-picker screen — spec section 14 ("ADDRESS SEARCH").
// UNBUILT/UNTESTED (see App.tsx). Real, debounced search against
// OnlineGeocoderProvider (@navia/core's GeocoderProvider interface, so an
// OfflineGeocoder can be swapped in later with no change here) — no
// hardcoded result arrays, no invented coordinates.
import React, { useEffect, useRef, useState } from "react";
import { View, TextInput, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GeocodeResult } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { OnlineGeocoderProvider } from "../providers/OnlineGeocoderProvider";
import { useNaviaStore } from "../engine/naviaController";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;

const DEBOUNCE_MS = 400;
const geocoder = new OnlineGeocoderProvider();

export function SearchScreen({ navigation }: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const addRecentDestination = useNaviaStore((s) => s.addRecentDestination);

  useEffect(() => {
    if (debounceHandle.current) clearTimeout(debounceHandle.current);
    if (query.trim().length < 3) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    debounceHandle.current = setTimeout(async () => {
      const seq = ++requestSeq.current;
      try {
        const found = await geocoder.search(query, { limit: 8 });
        if (seq === requestSeq.current) setResults(found);
      } catch (err) {
        if (seq === requestSeq.current) {
          setError((err as Error).message);
          setResults([]);
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (debounceHandle.current) clearTimeout(debounceHandle.current); };
  }, [query]);

  function pick(item: GeocodeResult) {
    addRecentDestination({ label: item.label, lat: item.location.lat, lon: item.location.lon, visitedAt: Date.now() });
    navigation.navigate("Navigation", { destinationLat: item.location.lat, destinationLon: item.location.lon, destinationLabel: item.label });
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Куди їдемо? (мінімум 3 символи)"
        placeholderTextColor="#8892a6"
        value={query}
        onChangeText={setQuery}
        autoFocus
      />
      {loading && <ActivityIndicator style={styles.spinner} color="#2dd4bf" />}
      {error && <Text style={styles.errorText}>Помилка пошуку: {error}</Text>}
      {!loading && !error && query.trim().length >= 3 && results.length === 0 && (
        <Text style={styles.hint}>Нічого не знайдено.</Text>
      )}
      <FlatList
        data={results}
        keyExtractor={(item, i) => `${item.location.lat},${item.location.lon},${i}`}
        renderItem={({ item }) => (
          <Pressable style={styles.resultRow} onPress={() => pick(item)}>
            <Text style={styles.resultLabel}>{item.label}</Text>
            {item.confidence != null && <Text style={styles.resultConfidence}>{Math.round(item.confidence * 100)}%</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#0b1220" },
  input: { backgroundColor: "#1a2233", color: "#fff", borderRadius: 10, padding: 12, fontSize: 16 },
  spinner: { marginTop: 16 },
  errorText: { color: "#f87171", marginTop: 12, fontSize: 13 },
  hint: { color: "#8892a6", marginTop: 12, fontSize: 13 },
  resultRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#1a2233", flexDirection: "row", justifyContent: "space-between" },
  resultLabel: { color: "#fff", flex: 1, fontSize: 14 },
  resultConfidence: { color: "#8892a6", fontSize: 12 },
});
