// Voice interaction panel — spec section 17 ("VOICE") + the user's exact
// intent list ("Куда дальше?", "Через сколько поворот?", "Я на правильной
// дороге?", "Где я?", "Статус GPS?", "Повтори."). UNBUILT/UNTESTED (see
// App.tsx).
//
// The mic button attempts REAL speech recognition and is shown in both
// modes — it's honest either way: ExpoSpeechVoiceProvider.startListening
// throws a documented not-implemented error (no STT module is wired up in
// this pass; needs a native module choice validated on a real device — see
// ExpoSpeechVoiceProvider.ts), so pressing it in real mode shows that real
// limitation rather than faking recognition.
//
// The six canned-phrase buttons are Demo-Mode-only, per the user's explicit
// instruction ("Кнопки Demo Voice можно оставить только в Demo Mode") —
// they exist to demonstrate the real AIEngine + real TTS pipeline
// end-to-end without pretending a microphone heard anything.
import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { DeterministicDemoAIProvider, type NavigationContext } from "@navia/core";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";

const DEMO_INTENTS = ["Куди далі?", "Через скільки поворот?", "Я на правильній дорозі?", "Де я?", "Статус GPS?", "Повтори."];

const aiProvider = new DeterministicDemoAIProvider();
const voice = new ExpoSpeechVoiceProvider();
let lastAnswer = "";

export function VoicePanel({ isDemoMode, context }: { isDemoMode: boolean; context: NavigationContext }): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function ask(text: string) {
    setBusy(true);
    try {
      const answer = text === "Повтори." ? lastAnswer || "Ще нічого не було сказано." : await aiProvider.answer(context, text);
      lastAnswer = answer;
      await voice.speak(answer);
    } finally {
      setBusy(false);
    }
  }

  async function onMicPress() {
    try {
      voice.startListening(() => {});
    } catch (err) {
      Alert.alert("Голосове розпізнавання", (err as Error).message);
    }
  }

  return (
    <View style={styles.container}>
      <Pressable style={styles.micButton} onPress={onMicPress} disabled={busy}>
        <Text style={styles.micButtonText}>🎤</Text>
      </Pressable>
      {isDemoMode && (
        <View style={styles.demoIntents}>
          {DEMO_INTENTS.map((intent) => (
            <Pressable key={intent} style={styles.intentButton} onPress={() => ask(intent)} disabled={busy}>
              <Text style={styles.intentButtonText}>{intent}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", right: 16, bottom: 160, alignItems: "flex-end" },
  micButton: { backgroundColor: "#2dd4bf", width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  micButtonText: { fontSize: 24 },
  demoIntents: { alignItems: "flex-end", gap: 6 },
  intentButton: { backgroundColor: "#2a1f55", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  intentButtonText: { color: "#c4b5fd", fontSize: 11 },
});
