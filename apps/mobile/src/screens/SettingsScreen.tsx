import { useAuth } from "../auth/AuthProvider";
import React, { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useAppSettings, type AppLanguage, type ThemePreference, type VoiceGender } from "../settings/AppSettings";
import { useT } from "../i18n";
import { Button, Card, Divider, ListRow, SectionLabel, Segmented, Text, TextField, useColors } from "../components/ui";
import { hasGenderVoice, speak } from "../voice/VoiceGuide";
import { cloudVoiceOnServer } from "../voice/cloudVoice";
import { deleteAllTrips, listTrips, recordingEnabled, setRecordingEnabled, shareTrip, type SavedTrip } from "../trips/tripLog";
import { navigationEngine } from "../engine/naviaController";
import { obdEnabled, setObdEnabled, startObd, stopObd, useObdStore } from "../vehicle/obdService";
import { OfflinePackageCard } from "../components/OfflinePackageCard";
import { isSmartCopilotConfigured, useNaviaStore } from "../engine/naviaController";
import { radius, space } from "../theme/tokens";

export function SettingsScreen(): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const auth = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    language, setLanguage, themePreference, setThemePreference, displayName, setDisplayName,
    introSoundEnabled, setIntroSoundEnabled, briefingEnabled, setBriefingEnabled, voiceGender, setVoiceGender, resetOnboarding,
  } = useAppSettings();
  const aiConsent = useNaviaStore((s) => s.aiContextConsent);
  const setAiConsent = useNaviaStore((s) => s.setAiContextConsent);
  const [maleOnDevice, setMaleOnDevice] = useState(true);
  const [neural, setNeural] = useState<boolean | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [recordTrips, setRecordTrips] = useState(recordingEnabled);
  const [obdOn, setObdOn] = useState(obdEnabled);
  const obd = useObdStore((s) => s.status);
  const obdLine = !obdOn ? t("obd.hint")
    : obd.state === "connected" ? t("obd.connected", { device: obd.device ?? "OBD", speed: obd.speedKmh != null ? `${obd.speedKmh} км/год` : "—" })
    : obd.state === "scanning" ? t("obd.scanning") : obd.state === "connecting" ? t("obd.connecting", { device: obd.device ?? "OBD" })
    : obd.state === "bluetooth_off" ? t("obd.bluetoothOff") : obd.state === "not_found" ? t("obd.notFound")
    : obd.state === "error" ? t("obd.error", { message: obd.message ?? "" }) : t("obd.hint");
  const [trips, setTrips] = useState<SavedTrip[]>([]);
  useEffect(() => { void listTrips().then(setTrips); }, []);

  useEffect(() => { void hasGenderVoice(lang, "male").then(setMaleOnDevice); }, [lang]);
  useEffect(() => { void cloudVoiceOnServer().then(setNeural); }, []);
  const maleAvailable = maleOnDevice || neural === true;

  async function preview() {
    setPreviewing(true);
    try { await speak(t("settings.voice.sample"), { lang, gender: voiceGender, cloudWaitMs: 4000 }); } finally { setPreviewing(false); }
  }

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <SectionLabel>{t("settings.profile")}</SectionLabel>
      <Card>
        <Text variant="subhead" color="secondary">{t("settings.name")}</Text>
        <View style={[styles.field, { backgroundColor: c.surfaceMuted }]}>
          <TextField value={displayName} onChangeText={setDisplayName} placeholder={t("settings.namePlaceholder")} autoCapitalize="words" returnKeyType="done" maxLength={40} accessibilityLabel={t("settings.name")} />
        </View>
      </Card>

      <SectionLabel style={styles.sectionGap}>{t("settings.account")}</SectionLabel>
      <Card style={styles.stack}>
        {auth.user ? <>
          <Text variant="bodyStrong">{t("settings.signedInAs", { name: auth.user.displayName ?? auth.user.email ?? (auth.user.provider === "apple" ? "Apple" : "Google") })}</Text>
          <Text variant="caption" color="muted">{t("settings.signedInHint")}</Text>
          <Button label={t("settings.signOut")} variant="secondary" onPress={() => void auth.signOut()} />
        </> : <>
          <Button label={t("settings.signInApple")} icon="user" variant="secondary" disabled={!auth.appleAvailable || auth.busy} onPress={() => void auth.signInWithApple()} />
          <Button label={t("settings.signInGoogle")} icon="globe" variant="secondary" disabled={!auth.googleAvailable || auth.busy} loading={auth.busy} onPress={() => void auth.signInWithGoogle()} />
          {(!auth.appleAvailable || !auth.googleAvailable) && <Text variant="caption" color="muted">{t("settings.accountUnavailable")}</Text>}
          {auth.error && <Text variant="caption" color="critical">{t("settings.signInFailed")}</Text>}
        </>}
      </Card>

      <SectionLabel style={styles.sectionGap}>{t("settings.appearance")}</SectionLabel>
      <Segmented<ThemePreference>
        value={themePreference} onChange={setThemePreference}
        options={[{ value: "system", label: t("settings.theme.system") }, { value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }]}
      />

      <SectionLabel style={styles.sectionGap}>{t("settings.language")}</SectionLabel>
      <Segmented<AppLanguage> value={language} onChange={setLanguage} options={[{ value: "uk", label: "Українська" }, { value: "en", label: "English" }]} />

      <SectionLabel style={styles.sectionGap}>{t("settings.voice")}</SectionLabel>
      <Card style={styles.stack}>
        <Segmented<VoiceGender>
          value={voiceGender} onChange={setVoiceGender}
          options={[{ value: "female", label: t("settings.voice.female") }, { value: "male", label: t("settings.voice.male") + (maleAvailable ? "" : " *") }]}
        />
        {neural !== null && <Text variant="caption" color="muted">{t(neural ? "settings.voice.neural" : voiceGender === "male" && !maleOnDevice ? "settings.voice.maleInterim" : "settings.voice.deviceOnly")}</Text>}
        <Button label={t("settings.voice.preview")} icon="volume" variant="secondary" loading={previewing} onPress={() => void preview()} />
      </Card>

      <SectionLabel style={styles.sectionGap}>{t("offline.section")}</SectionLabel>
      <OfflinePackageCard />

      <SectionLabel style={styles.sectionGap}>{t("obd.title")}</SectionLabel>
      <Card style={styles.list}>
        <ListRow icon="car" title={t("obd.enable")} subtitle={obdLine}
          trailing={<Switch value={obdOn} onValueChange={(v) => { setObdEnabled(v); setObdOn(v); if (v) void startObd((mps) => navigationEngine.setVehicleSpeed(mps, Date.now())); else void stopObd(); }} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("obd.enable")} />} />
      </Card>

      <SectionLabel style={styles.sectionGap}>{t("trips.title")}</SectionLabel>
      <Card style={styles.list}>
        <ListRow icon="route" title={t("trips.record")} subtitle={t("trips.recordHint")}
          trailing={<Switch value={recordTrips} onValueChange={(v) => { setRecordingEnabled(v); setRecordTrips(v); }} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("trips.record")} />} />
        {trips.slice(0, 5).map((trip) => <View key={trip.id}>
          <Divider inset={52} />
          <ListRow icon="send" title={trip.label} subtitle={t("trips.share")} onPress={() => void shareTrip(trip.id)} />
        </View>)}
        {trips.length > 0 && <>
          <Divider inset={52} />
          <ListRow icon="close" title={t("trips.deleteAll", { count: trips.length })} onPress={() => void deleteAllTrips().then(() => setTrips([]))} />
        </>}
      </Card>

      <SectionLabel style={styles.sectionGap}>NAVIA</SectionLabel>
      <Card style={styles.list}>
        <ListRow icon="volume" title={t("settings.sound")} trailing={<Switch value={introSoundEnabled} onValueChange={setIntroSoundEnabled} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("settings.sound")} />} />
        <Divider inset={52} />
        <ListRow icon="route" title={t("settings.briefing")} subtitle={t("settings.briefingHint")} trailing={<Switch value={briefingEnabled} onValueChange={setBriefingEnabled} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("settings.briefing")} />} />
        <Divider inset={52} />
        <ListRow icon="sparkle" title={t("settings.smartCopilot")} subtitle={isSmartCopilotConfigured() ? t("settings.smartCopilotHint") : t("settings.smartCopilotOff")}
          trailing={<Switch value={aiConsent} onValueChange={setAiConsent} disabled={!isSmartCopilotConfigured()} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("settings.smartCopilot")} />} />
        <Divider inset={52} />
        <ListRow icon="sparkle" title={t("settings.replayOnboarding")} onPress={() => { resetOnboarding(); navigation.popTo("Home"); }} />
        <Divider inset={52} />
        <ListRow icon="info" title={t("settings.sources")} onPress={() => navigation.navigate("Sources")} />
        <Divider inset={52} />
        <ListRow icon="shield" title={t("settings.system")} onPress={() => void Linking.openSettings()} />
        <Divider inset={52} />
        <ListRow icon="satellite" title={t("settings.diagnostics")} onPress={() => navigation.navigate("Diagnostics")} />
      </Card>
      {/* Data sources in one place only: small print at the very bottom. */}
      <Text variant="caption" color="muted" style={styles.footer} onPress={() => navigation.navigate("Sources")}>{t("settings.footer")}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, paddingBottom: space.xxl },
  sectionGap: { marginTop: space.lg },
  field: { marginTop: space.xs, borderRadius: radius.md, paddingHorizontal: space.sm, flexDirection: "row" },
  stack: { gap: space.sm },
  list: { paddingVertical: space.xxs },
  footer: { marginTop: space.lg, textAlign: "center", fontSize: 11, lineHeight: 15 },
});
