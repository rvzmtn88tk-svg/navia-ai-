import React, { useEffect, useRef, useState } from "react";
import { View, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GeocodeResult } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { PhotonGeocoderProvider } from "../providers/PhotonGeocoderProvider";
import { useNaviaStore } from "../engine/naviaController";
import { useAppSettings } from "../settings/AppSettings";
import { AppText as Text, AppTextInput as TextInput } from "../components/AppText";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 500;
const geocoder = new PhotonGeocoderProvider();

export function SearchScreen({ navigation }: Props): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  const styles = makeStyles(p);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const debounceHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const addRecentDestination = useNaviaStore((s) => s.addRecentDestination);
  const setDemoMode = useNaviaStore((s) => s.setDemoMode);

  useEffect(() => {
    if (debounceHandle.current) clearTimeout(debounceHandle.current);
    const seq = ++requestSeq.current;
    if (query.trim().length < MIN_QUERY_LENGTH) { setResults([]); setError(false); setLoading(false); return () => { requestSeq.current++; }; }
    setLoading(true); setError(false); setResults([]);
    debounceHandle.current = setTimeout(async () => {
      try { const found = await geocoder.search(query, { limit: 8, language: en ? "en" : "uk" }); if (seq === requestSeq.current) setResults(found); }
      catch { if (seq === requestSeq.current) { setError(true); setResults([]); } }
      finally { if (seq === requestSeq.current) setLoading(false); }
    }, DEBOUNCE_MS);
    return () => { if (debounceHandle.current) clearTimeout(debounceHandle.current); requestSeq.current++; };
  }, [query, retryNonce, en]);

  function pick(item: GeocodeResult) {
    setDemoMode(false);
    addRecentDestination({ label: item.label, lat: item.location.lat, lon: item.location.lon, visitedAt: Date.now() });
    navigation.navigate("Navigation", { destinationLat: item.location.lat, destinationLon: item.location.lon, destinationLabel: item.label });
  }

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>{en ? "Enter an address or a place name." : "Введіть адресу або назву місця."}</Text>
      <Text style={styles.regionHint}>{en ? "SUGGESTIONS FROM 3 CHARACTERS · KYIV AND OBLAST" : "ПІДКАЗКИ З 3 СИМВОЛІВ · КИЇВ ТА ОБЛАСТЬ"}</Text>
      <View style={styles.searchBox}><Text style={styles.searchIcon}>⌕</Text><TextInput style={styles.input} placeholder={en ? "Try Khreshchatyk 22" : "Наприклад, Хрещатик, 22"} placeholderTextColor={p.subtle} value={query} onChangeText={setQuery} autoFocus returnKeyType="search" autoCorrect={false} />{query.length > 0 && <Pressable style={styles.clearButton} onPress={() => setQuery("")} accessibilityLabel={en ? "Clear search" : "Очистити пошук"}><Text style={styles.clearText}>×</Text></Pressable>}</View>
      {loading && <View style={styles.statusRow}><ActivityIndicator color={p.accent} /><Text style={styles.statusText}>{en ? "Searching…" : "Шукаємо адресу…"}</Text></View>}
      {error && <View style={styles.errorCard}><Text style={styles.errorText}>{en ? "Search failed. Check your internet connection." : "Не вдалося виконати пошук. Перевірте інтернет."}</Text><Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => setRetryNonce((value) => value + 1)}><Text style={styles.retryText}>{en ? "Try again" : "Повторити"}</Text></Pressable></View>}
      {!loading && !error && query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && <Text style={styles.hint}>{en ? `Type ${MIN_QUERY_LENGTH - query.trim().length} more ${MIN_QUERY_LENGTH - query.trim().length === 1 ? "character" : "characters"} to see suggestions.` : `Введіть ще ${MIN_QUERY_LENGTH - query.trim().length} ${MIN_QUERY_LENGTH - query.trim().length === 1 ? "символ" : "символи"} — покажу підказки.`}</Text>}
      {!loading && !error && query.trim().length >= MIN_QUERY_LENGTH && results.length === 0 && <Text style={styles.hint}>{en ? "No suggestions yet. Keep typing a place name or street." : "Підказок поки немає. Продовжуйте вводити назву місця чи вулиці."}</Text>}
      {!loading && results.length > 0 && <Text style={styles.suggestionHeading}>{en ? "Suggestions" : "Підказки"}</Text>}
      <FlatList contentContainerStyle={styles.resultsContent} data={results} keyExtractor={(item, i) => `${item.location.lat},${item.location.lon},${i}`} renderItem={({ item }) => <Pressable style={styles.resultRow} onPress={() => pick(item)}><View style={styles.resultPin}><Text style={styles.resultPinText}>⌖</Text></View><View style={styles.resultCopy}><Text style={styles.resultLabel} numberOfLines={2}>{item.label}</Text><Text style={styles.resultMeta}>{en ? "OpenStreetMap place" : "Місце з OpenStreetMap"}</Text></View><Text style={styles.resultChevron}>›</Text></Pressable>} />
      <Text style={styles.attribution}>{en ? "Search by Photon · © OpenStreetMap contributors" : "Пошук Photon · © учасники OpenStreetMap"}</Text>
    </View>
  );
}

function makeStyles(p: ReturnType<typeof useAppSettings>["palette"]) {
  return StyleSheet.create({
    container: { flex: 1, paddingHorizontal: 20, paddingTop: 22, backgroundColor: p.background }, intro: { color: p.text, fontSize: 19, lineHeight: 25, fontWeight: "700", marginBottom: 7 },
    regionHint: { color: p.subtle, fontSize: 10, fontWeight: "700", letterSpacing: 0.6, marginBottom: 16 }, searchBox: { minHeight: 55, flexDirection: "row", alignItems: "center", paddingHorizontal: 13, borderRadius: 16, backgroundColor: p.field, borderWidth: 1, borderColor: p.border },
    searchIcon: { color: p.accent, fontSize: 26, marginRight: 8, lineHeight: 30 }, input: { flex: 1, minWidth: 0, color: p.text, paddingVertical: 13, fontSize: 15 }, clearButton: { width: 31, height: 31, borderRadius: 11, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center" }, clearText: { color: p.muted, fontSize: 22, lineHeight: 25 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 17 }, statusText: { color: p.muted, fontSize: 12 }, errorCard: { marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: p.surfaceRaised, alignItems: "flex-start" }, errorText: { color: p.danger, fontSize: 13, lineHeight: 19 }, retryButton: { minHeight: 40, paddingHorizontal: 13, borderRadius: 11, backgroundColor: p.surface, justifyContent: "center", marginTop: 7 }, retryText: { color: p.accent, fontSize: 12, fontWeight: "800" }, hint: { color: p.muted, marginTop: 15, fontSize: 13, lineHeight: 19 },
    suggestionHeading: { color: p.muted, fontSize: 12, fontWeight: "700", marginTop: 17 }, attribution: { color: p.subtle, fontSize: 11, textAlign: "center", paddingVertical: 10 },
    resultsContent: { paddingTop: 4, paddingBottom: 10 }, resultRow: { minHeight: 68, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border, flexDirection: "row", alignItems: "center" }, resultPin: { width: 37, height: 37, borderRadius: 13, backgroundColor: p.surfaceRaised, alignItems: "center", justifyContent: "center", marginRight: 11 }, resultPinText: { color: p.accent, fontSize: 21 }, resultCopy: { flex: 1 }, resultLabel: { color: p.text, fontSize: 13, lineHeight: 18 }, resultMeta: { color: p.subtle, fontSize: 11, marginTop: 4 }, resultChevron: { color: p.subtle, fontSize: 23, paddingHorizontal: 6 },
  });
}
