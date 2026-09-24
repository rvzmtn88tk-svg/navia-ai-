import React from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useAppSettings, type AppLanguage, type ThemePreference } from "../settings/AppSettings";
import { AppText as Text, AppTextInput as TextInput } from "../components/AppText";

export function SettingsScreen(): JSX.Element {
  const { palette: p, language, setLanguage, themePreference, setThemePreference, displayName, setDisplayName, introSoundEnabled, setIntroSoundEnabled } = useAppSettings();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const en = language === "en";
  const themes: { value: ThemePreference; label: string }[] = [
    { value: "system", label: en ? "System" : "За системою" },
    { value: "light", label: en ? "Light" : "Світла" },
    { value: "dark", label: en ? "Dark" : "Темна" },
  ];
  const languages: { value: AppLanguage; label: string }[] = [
    { value: "uk", label: "Українська" },
    { value: "en", label: "English" },
  ];
  return (
    <ScrollView style={[styles.screen, { backgroundColor: p.background }]} contentContainerStyle={styles.content}>
      <Text style={[styles.intro, { color: p.muted }]}>{en ? "Set NAVIA up for the way you use it." : "Налаштуйте NAVIA так, як вам зручно."}</Text>
      <Text style={[styles.label, { color: p.subtle }]}>{en ? "YOUR PROFILE · THIS PHONE" : "ВАШ ПРОФІЛЬ · ЦЕЙ ТЕЛЕФОН"}</Text>
      <View style={[styles.profile, { backgroundColor: p.surface, borderColor: p.border }]}>
        <View style={[styles.avatar, { backgroundColor: p.accent }]}><Text style={[styles.avatarText, { color: p.accentText }]}>{displayName.trim().slice(0, 1).toLocaleUpperCase() || "N"}</Text></View>
        <View style={styles.profileBody}>
          <Text style={[styles.profileTitle, { color: p.text }]}>{en ? "How should NAVIA address you?" : "Як NAVIA має до вас звертатися?"}</Text>
          <TextInput value={displayName} onChangeText={setDisplayName} placeholder={en ? "Your name (optional)" : "Ваше ім’я (необов’язково)"} placeholderTextColor={p.subtle} autoCapitalize="words" returnKeyType="done" maxLength={40} style={[styles.nameInput, { color: p.text, backgroundColor: p.field, borderColor: p.border }]} />
        </View>
      </View>
      <Text style={[styles.help, { color: p.subtle }]}>{en ? "This profile is stored only on this phone. NAVIA does not create an online account or upload your route." : "Цей профіль зберігається лише на телефоні. NAVIA не створює обліковий запис онлайн і не передає ваш маршрут на сервер."}</Text>

      <Text style={[styles.label, { color: p.subtle }]}>{en ? "APPEARANCE" : "ВИГЛЯД"}</Text>
      <View style={[styles.group, { backgroundColor: p.surface, borderColor: p.border }]}>
        {themes.map((item) => <Choice key={item.value} label={item.label} selected={themePreference === item.value} onPress={() => setThemePreference(item.value)} p={p} />)}
      </View>
      <Text style={[styles.help, { color: p.subtle }]}>{en ? "System mode follows your iPhone's appearance automatically." : "Режим «За системою» автоматично повторює тему iPhone."}</Text>

      <Text style={[styles.label, { color: p.subtle, marginTop: 28 }]}>{en ? "LANGUAGE" : "МОВА"}</Text>
      <View style={[styles.group, { backgroundColor: p.surface, borderColor: p.border }]}>
        {languages.map((item) => <Choice key={item.value} label={item.label} selected={language === item.value} onPress={() => setLanguage(item.value)} p={p} />)}
      </View>

      <Text style={[styles.label, { color: p.subtle, marginTop: 28 }]}>{en ? "SOUND AND LAUNCH" : "ЗВУК І ЗАПУСК"}</Text>
      <View style={[styles.group, { backgroundColor: p.surface, borderColor: p.border }]}>
        <View style={styles.soundRow}><View style={{ flex: 1, paddingRight: 12 }}><Text style={[styles.choiceLabel, { color: p.text }]}>{en ? "NAVIA startup sound" : "Фірмовий звук NAVIA"}</Text><Text style={[styles.help, { color: p.subtle }]}>{en ? "A short, original three-note chime on launch." : "Коротка оригінальна мелодія з трьох нот під час запуску."}</Text></View><Switch value={introSoundEnabled} onValueChange={setIntroSoundEnabled} trackColor={{ false: p.border, true: p.accent }} thumbColor="#ffffff" accessibilityLabel={en ? "Startup sound" : "Звук під час запуску"} /></View>
      </View>

      <Text style={[styles.label, { color: p.subtle, marginTop: 28 }]}>{en ? "DATA AND SAFETY" : "ДАНІ ТА БЕЗПЕКА"}</Text>
      <View style={[styles.note, { backgroundColor: p.surface, borderColor: p.border }]}>
        <Text style={[styles.noteTitle, { color: p.text }]}>{en ? "Live services" : "Онлайн-сервіси"}</Text>
        <Text style={[styles.noteText, { color: p.muted }]}>{en ? "Routes, map places and regional alert information need an internet connection. For official emergency notifications, keep Ukraine's official alert app enabled." : "Маршрути, точки на мапі та регіональний статус тривог потребують інтернету. Для офіційних сповіщень залиште увімкненим державний застосунок «Повітряна тривога»."}</Text>
      </View>
      <View style={[styles.note, { backgroundColor: p.surface, borderColor: p.border, marginTop: 10 }]}>
        <Text style={[styles.noteTitle, { color: p.text }]}>{en ? "Safety-place coverage" : "Покриття точок безпеки"}</Text>
        <Text style={[styles.noteText, { color: p.muted }]}>{en ? "Kyiv uses municipal open shelter and resilience-point data when available. Elsewhere, map markers come from OpenStreetMap and may be incomplete. Keep an official map available: nezlamnist.gov.ua." : "У Києві NAVIA використовує міські відкриті дані про укриття та пункти незламності, якщо GIS-сервер доступний. В інших регіонах позначки беруться з OpenStreetMap і можуть бути неповними. Офіційна мапа Пунктів незламності: nezlamnist.gov.ua."}</Text>
      </View>
      <View style={[styles.note, { backgroundColor: p.surface, borderColor: p.border, marginTop: 10 }]}>
        <Text style={[styles.noteTitle, { color: p.text }]}>{en ? "NAVIA co-pilot" : "Штурман NAVIA"}</Text>
        <Text style={[styles.noteText, { color: p.muted }]}>{en ? "The co-pilot answers from NAVIA's live GPS, route, alert and nearby-place data. Generative cloud AI needs a secure backend; no key is embedded in this app." : "Штурман відповідає за актуальними даними GPS, маршруту, тривог і місць поблизу. Для генеративного хмарного ШІ потрібен захищений сервер; ключ у застосунок не вшитий."}</Text>
      </View>
      <Pressable style={[styles.diagnostics, { backgroundColor: p.surface, borderColor: p.border }]} onPress={() => void Linking.openSettings()}>
        <Text style={[styles.diagnosticsText, { color: p.text }]}>{en ? "iPhone system settings and permissions" : "Системні налаштування iPhone та дозволи"}</Text>
        <Text style={{ color: p.accent, fontSize: 21 }}>›</Text>
      </Pressable>
      <Pressable style={[styles.diagnostics, { backgroundColor: p.surface, borderColor: p.border }]} onPress={() => navigation.navigate("Diagnostics")}>
        <Text style={[styles.diagnosticsText, { color: p.text }]}>{en ? "Device diagnostics" : "Діагностика пристрою"}</Text>
        <Text style={{ color: p.accent, fontSize: 21 }}>›</Text>
      </Pressable>
    </ScrollView>
  );
}

function Choice({ label, selected, onPress, p }: { label: string; selected: boolean; onPress: () => void; p: ReturnType<typeof useAppSettings>["palette"] }): JSX.Element {
  return <Pressable onPress={onPress} style={[styles.choice, { borderBottomColor: p.border }]}><Text style={[styles.choiceLabel, { color: p.text }]}>{label}</Text><Text style={[styles.radio, { color: selected ? p.accent : p.subtle }]}>{selected ? "●" : "○"}</Text></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, content: { padding: 20, paddingBottom: 36 }, intro: { fontSize: 15, lineHeight: 22, marginBottom: 25 },
  label: { fontSize: 10, fontWeight: "800", letterSpacing: 1.3, marginBottom: 9 },
  group: { borderWidth: 1, borderRadius: 16, overflow: "hidden", paddingHorizontal: 14 },
  choice: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth },
  choiceLabel: { fontSize: 15, fontWeight: "600" }, radio: { fontSize: 21, marginRight: 4 },
  help: { fontSize: 12, lineHeight: 18, marginTop: 9 },
  profile: { borderWidth: 1, borderRadius: 17, flexDirection: "row", alignItems: "center", padding: 13, gap: 12 }, avatar: { width: 43, height: 43, borderRadius: 15, alignItems: "center", justifyContent: "center" }, avatarText: { fontSize: 22, fontWeight: "900" }, profileBody: { flex: 1 }, profileTitle: { fontSize: 12, fontWeight: "700", marginBottom: 8 }, nameInput: { minHeight: 42, borderWidth: 1, borderRadius: 12, paddingHorizontal: 11, fontSize: 14 },
  soundRow: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  note: { borderWidth: 1, borderRadius: 16, padding: 15 }, noteTitle: { fontSize: 14, fontWeight: "700", marginBottom: 6 }, noteText: { fontSize: 12, lineHeight: 18 },
  diagnostics: { minHeight: 52, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, marginTop: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, diagnosticsText: { fontSize: 13, fontWeight: "700" },
});
