// Full-screen search, Google-Maps style: saved and recent places first,
// live suggestions as you type, picking a result opens its card on the map.
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { GeocodeResult } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { PhotonGeocoderProvider } from "../providers/PhotonGeocoderProvider";
import { detectKind } from "../ai/copilotBrain";
import { CATEGORY_META, CHIP_CATEGORIES, type ChipCategory } from "../places/categories";
import { placeId, usePlacesStore, type PlaceRef } from "../store/placesStore";
import { useT } from "../i18n";
import { Divider, IconButton, ListRow, SectionLabel, Text, TextField, useColors } from "../components/ui";
import { Icon } from "../components/Icon";
import { elevation, iconSize, radius, space } from "../theme/tokens";
import { useNaviaStore } from "../engine/naviaController";
import { gazetteerMeta, searchOffline, warmOfflineSearch, type OfflineHit } from "../offline/offlineGazetteer";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 350;
const geocoder = new PhotonGeocoderProvider();
/** Online search this slow: show what the offline package has meanwhile. */
const OFFLINE_AFTER_MS = 3500;
type OfflineState = null | "results" | "none" | "noPackage";

export function toPlaceRef(result: GeocodeResult): PlaceRef {
  const [title, ...rest] = result.label.split(",").map((part) => part.trim()).filter(Boolean);
  return { id: placeId(result.location.lat, result.location.lon), label: title ?? result.label, subtitle: rest.join(", ") || undefined, lat: result.location.lat, lon: result.location.lon };
}

export function SearchScreen({ navigation, route }: Props): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const pickFor = route.params?.pickFor;
  const { home, work, recents, load, addRecent, setSlot } = usePlacesStore();
  const [query, setQuery] = useState(route.params?.initialQuery ?? "");
  const [results, setResults] = useState<PlaceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [offline, setOffline] = useState<OfflineState>(null);
  const seq = useRef(0);

  useEffect(() => { void load(); warmOfflineSearch(); }, [load]);

  function offlineRef(h: OfflineHit): PlaceRef {
    const cat = h.category && h.category in CATEGORY_META ? t(CATEGORY_META[h.category as keyof typeof CATEGORY_META].label) : null;
    const kind = h.kind === "poi" ? cat ?? t("search.kind.poi") : t(`search.kind.${h.kind}` as "search.kind.city");
    return { id: placeId(h.location.lat, h.location.lon), label: h.name, subtitle: [kind, h.area, t("search.offlineTag")].filter(Boolean).join(" · "), lat: h.location.lat, lon: h.location.lon };
  }

  useEffect(() => {
    const id = ++seq.current;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) { setResults([]); setLoading(false); setError(false); return; }
    setLoading(true);
    setError(false);
    setOffline(null);
    const handle = setTimeout(() => {
      // The offline directory is searched alongside: its results show when
      // the network fails or is too slow; online results replace them.
      const nav = useNaviaStore.getState();
      const here = nav.state.position?.position ?? (nav.currentFix ? { lat: nav.currentFix.lat, lon: nav.currentFix.lon } : null);
      const local = searchOffline(trimmed, here, 8).catch(() => [] as OfflineHit[]);
      let answered = false;
      const showOffline = async (final: boolean) => {
        const hits = await local;
        if (id !== seq.current || answered) return;
        if (hits.length > 0) { setResults(hits.map(offlineRef)); setOffline("results"); if (final) setLoading(false); return; }
        if (!final) return;
        setOffline((await gazetteerMeta().catch(() => null)) ? "none" : "noPackage");
        setError(true);
        setResults([]);
        setLoading(false);
      };
      const slow = setTimeout(() => void showOffline(false), OFFLINE_AFTER_MS);
      geocoder.search(trimmed, { limit: 8, language: lang })
        .then((found) => { if (id === seq.current) { answered = true; setOffline(null); setResults(dedupe(found.map(toPlaceRef))); setLoading(false); } })
        .catch(() => void showOffline(true))
        .finally(() => clearTimeout(slow));
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, retry, lang]);

  function pick(place: PlaceRef) {
    Keyboard.dismiss();
    if (pickFor) {
      setSlot(pickFor, place);
      navigation.goBack();
      return;
    }
    addRecent(place);
    navigation.popTo("Home", { focusPlace: place });
  }

  const typing = query.trim().length > 0;
  // "пункт незламності", "укриття", "аптека"…: a category, not an address —
  // offer the same nearby search as the map chips.
  const kind = typing && !pickFor ? detectKind(query) : null;
  const nearbyCategory = kind && (CHIP_CATEGORIES as string[]).includes(kind) ? (kind as ChipCategory) : null;
  const shortcuts: { key: string; icon: "home" | "work"; title: string; place: PlaceRef | null }[] = [
    { key: "home", icon: "home", title: t("saved.home"), place: home },
    { key: "work", icon: "work", title: t("saved.work"), place: work },
  ];

  return (
    <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space.xs }]}>
      <View style={[styles.bar, { backgroundColor: c.surfaceElevated }, elevation(1, c)]}>
        <IconButton icon="back" tone="plain" label={t("common.back")} onPress={() => navigation.goBack()} size={40} />
        <TextField
          autoFocus value={query} onChangeText={setQuery} placeholder={t("search.placeholder")}
          returnKeyType="search" autoCorrect={false} accessibilityLabel={t("search.placeholder")}
        />
        {loading ? <ActivityIndicator color={c.accent} style={styles.trailing} /> : query.length > 0
          ? <IconButton icon="close" tone="plain" label={t("common.close")} onPress={() => setQuery("")} size={40} />
          : <View style={styles.trailing} />}
      </View>

      {!typing && (
        <FlatList
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          data={recents}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<>
            {!pickFor && <>
              <SectionLabel>{t("saved.title")}</SectionLabel>
              {shortcuts.map((s) => (
                <ListRow key={s.key} icon={s.icon} title={s.title} subtitle={s.place?.label ?? t("saved.add")}
                  onPress={() => s.place ? pick(s.place) : navigation.push("Search", { pickFor: s.key as "home" | "work" })} />
              ))}
            </>}
            {recents.length > 0 && <SectionLabel style={{ marginTop: space.lg }}>{t("recent.title")}</SectionLabel>}
          </>}
          ItemSeparatorComponent={() => <Divider inset={52} />}
          renderItem={({ item }) => <ListRow icon="clock" iconTint={c.textSecondary} title={item.label} subtitle={item.subtitle} onPress={() => pick(item)} />}
        />
      )}

      {typing && (
        <FlatList
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          data={results}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => <Divider inset={52} />}
          ListHeaderComponent={<>
            {nearbyCategory && (
              <ListRow icon={CATEGORY_META[nearbyCategory].icon} iconTint={CATEGORY_META[nearbyCategory].color}
                title={t("search.nearby", { category: t(CATEGORY_META[nearbyCategory].label) })} subtitle={t("search.nearbyHint")}
                onPress={() => { Keyboard.dismiss(); navigation.popTo("Home", { category: nearbyCategory }); }} />
            )}
            {offline === "results" && (
              <View style={styles.offlineNote}>
                <Icon name="globe" size={iconSize.sm} color={c.warning} />
                <Text variant="caption" color="secondary" style={{ flex: 1 }}>
                  {t("search.offlineBanner")}{/\d/.test(query) ? ` ${t("search.offlineHouse")}` : ""}
                </Text>
              </View>
            )}
          </>}
          ListEmptyComponent={nearbyCategory ? null :
            <View style={styles.state}>
              {error ? <>
                <Text variant="callout" color="secondary">{offline === "none" ? t("search.offlineNone") : offline === "noPackage" ? t("search.offlineNoPackage") : t("search.error")}</Text>
                <Text variant="bodyStrong" color="accent" onPress={() => setRetry((n) => n + 1)} style={styles.retry}>{t("common.retry")}</Text>
              </> : query.trim().length < MIN_QUERY_LENGTH ? <Text variant="callout" color="secondary">{t("search.typeMore")}</Text>
                : loading ? <Text variant="callout" color="secondary">{t("search.searching")}</Text>
                  : <Text variant="callout" color="secondary">{t("search.empty")}</Text>}
            </View>
          }
          renderItem={({ item }) => <ListRow icon="pin" title={item.label} subtitle={item.subtitle} onPress={() => pick(item)} />}
        />
      )}
      {!typing && <View style={[styles.hint, { paddingBottom: insets.bottom + space.sm }]}>
        <Icon name="globe" size={iconSize.sm} color={c.textMuted} />
        <Text variant="caption" color="muted">{t("search.hint")}</Text>
      </View>}
    </View>
  );
}

function dedupe(items: PlaceRef[]): PlaceRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}|${item.subtitle ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { marginHorizontal: space.md, minHeight: 52, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xxs, gap: space.xxs },
  trailing: { width: 40 },
  offlineNote: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs },
  list: { paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xl },
  state: { paddingVertical: space.lg, alignItems: "flex-start" },
  retry: { marginTop: space.sm },
  hint: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs },
});
