import React, { useState } from "react";
import { View, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { AppText as Text } from "./AppText";
import { DeterministicDemoAIProvider, type NavigationContext } from "@navia/core";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";
import { useAppSettings } from "../settings/AppSettings";

const DEMO_INTENTS = ["Куди далі?", "Через скільки поворот?", "Я на правильній дорозі?", "Де я?", "Статус GPS?", "Повтори."];

const aiProvider = new DeterministicDemoAIProvider();
const voice = new ExpoSpeechVoiceProvider();
let lastAnswer = "";

function answerInEnglish(context: NavigationContext, question: string): string {
  const q = question.toLowerCase();
  if (/gps|gnss|signal/.test(q)) {
    if (context.state.gnss === "NORMAL") return "GPS signal is stable.";
    if (context.state.gnss === "DEGRADED") return "GPS signal is weak; position accuracy may be reduced.";
    return "GPS signal is lost. I can't confirm your current position.";
  }
  if (/where|position/.test(q)) {
    const fix = context.state.trustedPosition?.position ?? context.state.position?.position;
    return fix ? `Your last position estimate is ${context.state.confidenceBand.toLowerCase()} confidence.` : "I don't have a current position fix.";
  }
  if (/turn|next|maneuver/.test(q)) {
    const step = context.state.nextStep;
    return step ? `In about ${Math.round(step.distanceM)} meters, ${step.maneuver}${step.roadName ? ` onto ${step.roadName}` : ""}.` : "There is no active route guidance yet.";
  }
  if (/route|how far|arrival/.test(q)) {
    return context.route ? `About ${(context.state.routeRemainingM / 1000).toFixed(1)} kilometers remain.` : "There is no active route yet.";
  }
  return "I can answer about GPS, your position, route progress and the next turn.";
}

export function VoicePanel({ isDemoMode, context, compact = false }: { isDemoMode: boolean; context: NavigationContext; compact?: boolean }): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  const styles = makeStyles(p.accent, p.accentText, compact);
  const [busy, setBusy] = useState(false);

  async function answer(text: string) {
    const response = en
      ? (/repeat/i.test(text) ? lastAnswer || "Nothing has been said yet." : answerInEnglish(context, text))
      : text === "Повтори." ? lastAnswer || "Ще нічого не було сказано." : await aiProvider.answer(context, text);
    lastAnswer = response;
    await voice.speak(response, { language: en ? "en-US" : "uk-UA" });
  }

  async function ask(text: string) {
    setBusy(true);
    try {
      await answer(text);
    } finally {
      setBusy(false);
    }
  }

  async function onMicPress() {
    setBusy(true);
    try {
      await voice.startListening(answer, { language: en ? "en-US" : "uk-UA" });
    } catch (err) {
      Alert.alert("Голосова команда", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      {isDemoMode && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.demoIntents} contentContainerStyle={styles.demoIntentsContent}>
          {(en ? ["Where am I?", "Next turn?", "Am I on route?", "GPS status?", "Repeat."] : DEMO_INTENTS).map((intent) => (
            <Pressable key={intent} style={styles.intentButton} onPress={() => void ask(intent)} disabled={busy}>
              <Text style={styles.intentButtonText}>{intent}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Pressable style={[styles.micButton, busy && styles.micButtonBusy]} onPress={() => void onMicPress()} disabled={busy} accessibilityLabel={busy ? (en ? "Listening" : "Слухаю команду") : (en ? "Voice command" : "Голосова команда")}>
        <Text style={styles.micButtonText}>{busy ? "…" : "🎤"}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(accent: string, foreground: string, compact: boolean) {
  return StyleSheet.create({
    container: { width: compact ? "auto" : "100%", flexDirection: "row", alignItems: "center", marginTop: compact ? 0 : 10 },
    micButton: { backgroundColor: accent, width: 46, height: 46, borderRadius: 16, alignItems: "center", justifyContent: "center", marginLeft: compact ? 0 : 8 },
    micButtonBusy: { backgroundColor: "#b197fa" }, micButtonText: { fontSize: 18 }, demoIntents: { flex: 1, minWidth: 0 }, demoIntentsContent: { alignItems: "center" },
    intentButton: { backgroundColor: accent, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, marginRight: 7 }, intentButtonText: { color: foreground, fontSize: 10, fontWeight: "600" },
  });
}
