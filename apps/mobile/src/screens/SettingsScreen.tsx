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
import { OfflinePackageCard } from "../components/OfflinePackageCard";
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
  const [maleAvailable, setMaleAvailable] = useState(true);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => { void hasGenderVoice(lang, "male").then(setMaleAvailable); }, [lang]);

  async function preview() {
    setPreviewing(true);
    try { await speak(t("settings.voice.sample"), { lang, gender: voiceGender }); } finally { setPreviewing(false); }
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
        {voiceGender === "male" && !maleAvailable && <Text variant="caption" color="muted">{t("settings.voice.maleInterim")}</Text>}
        <Button label={t("settings.voice.preview")} icon="volume" variant="secondary" loading={previewing} onPress={() => void preview()} />
      </Card>

      <SectionLabel style={styles.sectionGap}>{t("offline.section")}</SectionLabel>
      <OfflinePackageCard />

      <SectionLabel style={styles.sectionGap}>NAVIA</SectionLabel>
      <Card style={styles.list}>
        <ListRow icon="volume" title={t("settings.sound")} trailing={<Switch value={introSoundEnabled} onValueChange={setIntroSoundEnabled} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("settings.sound")} />} />
        <Divider inset={52} />
        <ListRow icon="route" title={t("settings.briefing")} subtitle={t("settings.briefingHint")} trailing={<Switch value={briefingEnabled} onValueChange={setBriefingEnabled} trackColor={{ false: c.border, true: c.accent }} accessibilityLabel={t("settings.briefing")} />} />
        <Divider inset={52} />
        <ListRow icon="sparkle" title={t("settings.replayOnboarding")} onPress={() => { resetOnboarding(); navigation.navigate("Home"); }} />
        <Divider inset={52} />
        <ListRow icon="info" title={t("settings.sources")} onPress={() => navigation.navigate("Sources")} />
        <Divider inset={52} />
        <ListRow icon="shield" title={t("settings.system")} onPress={() => void Linking.openSettings()} />
        <Divider inset={52} />
        <ListRow icon="satellite" title={t("settings.diagnostics")} onPress={() => navigation.navigate("Diagnostics")} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, paddingBottom: space.xxl },
  sectionGap: { marginTop: space.lg },
  field: { marginTop: space.xs, borderRadius: radius.md, paddingHorizontal: space.sm, flexDirection: "row" },
  stack: { gap: space.sm },
  list: { paddingVertical: space.xxs },
});
