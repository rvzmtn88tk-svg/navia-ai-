// Voice/co-pilot interaction panel — spec sections 16/17. UNBUILT/UNTESTED
// on a device (see App.tsx); the co-pilot logic it calls is tested in
// packages/core (copilot-*.test.ts).
//
// Every question goes to the active NaviaCopilot (naviaController), which
// answers from the live navigation engine + tools, through the NAVIA AI
// backend when configured and the driver has AI context sharing on, or with
// on-device deterministic answers otherwise. Actions the co-pilot proposes
// (add a stop, change destination, switch route) appear as a Yes/No card:
// the driver can confirm by voice or tap — tapping executes directly, with
// no extra LLM round-trip.
//
// The mic button runs real on-device speech recognition (uk-UA,
// expo-speech-recognition): tap, speak one question, the transcript goes to
// the co-pilot and the answer is spoken back. Tap again while listening to
// stop. The text field lets a passenger (or a tester) type the same
// questions. Canned-phrase buttons are Demo-Mode-only, per the user's
// instruction.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Switch } from "react-native";
import { VoiceConversation, type CopilotReply } from "@navia/core";
import { ExpoSpeechVoiceProvider, type ListeningHandle } from "../providers/ExpoSpeechVoiceProvider";
import { activeCopilot, activeProactive, isSmartCopilotConfigured, useNaviaStore } from "../engine/naviaController";

const DEMO_INTENTS = [
  "Куди далі?",
  "Я на правильній дорозі?",
  "Що з GPS?",
  "Знайди заправку по дорозі, щоб гак був не більше 5 хвилин",
  "Хочу кави по дорозі",
  "Знайди McDonald's по дорозі, щоб додав не більше 10 хвилин, і додай як зупинку",
  "Знайди парковку біля місця призначення",
  "Чому саме цей маршрут?",
  "Є попереду затори?",
];

const voice = new ExpoSpeechVoiceProvider();
let lastAnswer = "";
const ROUTE_TOOLS = ["add_stop", "remove_stop", "set_destination", "set_route_preferences", "switch_route", "reorder_stops"];

export function VoicePanel({ isDemoMode, onRouteChanged }: { isDemoMode: boolean; onRouteChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<CopilotReply | null>(null);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const listeningHandle = useRef<ListeningHandle | null>(null);
  const { aiContextConsent, aiConsentAsked, setAiContextConsent } = useNaviaStore();

  /** Show a reply and apply its side effects; `speak` false when the voice loop speaks it itself. */
  function show(r: CopilotReply) {
    setReply(r);
    lastAnswer = r.text;
    if (r.trace.some((t) => !t.isError && ROUTE_TOOLS.includes(t.tool))) onRouteChanged();
  }

  async function deliver(r: CopilotReply) {
    show(r);
    if (conversation.current.getState() !== "off") await conversation.current.announce(r.text);
    else await voice.speak(r.text).catch(() => {});
  }

  // Hands-free: "Навіа, …" — the same co-pilot, driven by the voice loop
  // (speech-to-text → co-pilot → tools → text-to-speech), no taps needed.
  const conversation = useRef(new VoiceConversation(
    { ask: async (text) => { setDraft(text); const r = await activeCopilot().ask(text); show(r); return r; } },
    { listen: (onResult, onError) => voice.startListening(onResult, onError) },
    { speak: (text) => voice.speak(text), stop: () => voice.stopSpeaking() },
    { onState: (st) => setListening(st === "listening" || st === "waiting_for_wake") },
  ));

  function toggleHandsFree(on: boolean) {
    setHandsFree(on);
    if (on) void conversation.current.startHandsFree();
    else conversation.current.stop();
  }
  useEffect(() => () => conversation.current.stop(), []);

  // Proactive messages (a reminder the driver asked for, a big traffic delay):
  // checked every few seconds; the engine itself rate-limits and stays quiet near maneuvers.
  useEffect(() => {
    let running = false;
    const h = setInterval(() => {
      if (running || busy) return;
      running = true;
      void activeProactive().tick().then((m) => { if (m) void deliver(m.reply); }).catch(() => {}).finally(() => { running = false; });
    }, 3_000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy("Думаю…");
    try {
      await deliver(await activeCopilot().ask(q));
    } catch (err) {
      await deliver({
        text: "Голосовий штурман тимчасово недоступний.", mode: "local", pendingAction: null, trace: [], tiers: [], models: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, latencyMs: 0,
        degradedReason: (err as Error).message,
      });
    } finally {
      setBusy(null);
      setDraft("");
    }
  }

  async function confirm(yes: boolean) {
    setBusy(yes ? "Виконую…" : null);
    try {
      await deliver(yes ? await activeCopilot().confirmPendingAction() : activeCopilot().declinePendingAction());
    } finally {
      setBusy(null);
    }
  }

  async function onMicPress() {
    if (listening) {
      listeningHandle.current?.stop();
      return;
    }
    setListening(true);
    try {
      listeningHandle.current = await voice.startListening(
        (text) => { setListening(false); setDraft(text); void ask(text); },
        (message) => { setListening(false); void voice.speak(message).catch(() => {}); },
      );
    } catch (err) {
      setListening(false);
      Alert.alert("Голосове розпізнавання", (err as Error).message);
    }
  }

  const pending = reply?.pendingAction ?? activeCopilot().getPendingAction();

  return (
    <View style={styles.container} pointerEvents="box-none">
      {isSmartCopilotConfigured() && !aiContextConsent && !aiConsentAsked && (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingText}>Увімкнути розумного штурмана?</Text>
          <Text style={styles.consentSub}>
            Щоб розуміти вільні запити, штурман надсилає на сервер NAVIA ваше запитання і стислий стан поїздки
            (маршрут, відстані, знайдені місця) — без координат. Без цього працюють лише базові локальні відповіді.
          </Text>
          <View style={styles.pendingRow}>
            <Pressable style={[styles.pendingButton, styles.yes]} onPress={() => setAiContextConsent(true)}>
              <Text style={styles.pendingButtonText}>Увімкнути</Text>
            </Pressable>
            <Pressable style={[styles.pendingButton, styles.no]} onPress={() => setAiContextConsent(false)}>
              <Text style={styles.pendingButtonText}>Не зараз</Text>
            </Pressable>
          </View>
        </View>
      )}
      {reply && (
        <View style={styles.bubble}>
          <Text style={styles.bubbleText}>{reply.text}</Text>
          {reply.mode === "local" && reply.degradedReason ? <Text style={styles.bubbleMeta}>локальний режим</Text> : null}
        </View>
      )}
      {pending && (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingText}>{pending.summary}?</Text>
          <View style={styles.pendingRow}>
            <Pressable style={[styles.pendingButton, styles.yes]} onPress={() => void confirm(true)} disabled={busy != null}>
              <Text style={styles.pendingButtonText}>Так</Text>
            </Pressable>
            <Pressable style={[styles.pendingButton, styles.no]} onPress={() => void confirm(false)} disabled={busy != null}>
              <Text style={styles.pendingButtonText}>Ні</Text>
            </Pressable>
          </View>
        </View>
      )}
      {listening && <Text style={styles.busy}>{handsFree ? "Скажіть «Навіа…»" : "Слухаю…"}</Text>}
      <View style={styles.handsFreeRow}>
        <Text style={styles.handsFreeText}>Руки вільні («Навіа, …»)</Text>
        <Switch value={handsFree} onValueChange={toggleHandsFree} />
      </View>
      {busy && <Text style={styles.busy}>{busy}</Text>}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Запитати NAVIA (пасажир)"
          placeholderTextColor="#8892a6"
          onSubmitEditing={() => void ask(draft)}
          returnKeyType="send"
          editable={busy == null}
        />
        <Pressable style={styles.repeatButton} onPress={() => void voice.speak(lastAnswer || "Ще нічого не було сказано.").catch(() => {})}>
          <Text style={styles.repeatText}>↻</Text>
        </Pressable>
        <Pressable style={[styles.micButton, listening && styles.micListening]} onPress={() => void onMicPress()} disabled={busy != null}>
          <Text style={styles.micButtonText}>🎤</Text>
        </Pressable>
      </View>
      {isDemoMode && (
        <View style={styles.demoIntents}>
          {DEMO_INTENTS.map((intent) => (
            <Pressable key={intent} style={styles.intentButton} onPress={() => void ask(intent)} disabled={busy != null}>
              <Text style={styles.intentButtonText}>{intent}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", left: 16, right: 16, bottom: 160, alignItems: "flex-end" },
  bubble: { alignSelf: "stretch", backgroundColor: "rgba(11,18,32,0.95)", borderRadius: 12, padding: 12, marginBottom: 8 },
  bubbleText: { color: "#fff", fontSize: 15 },
  bubbleMeta: { color: "#8892a6", fontSize: 11, marginTop: 4 },
  pendingCard: { alignSelf: "stretch", backgroundColor: "#13233d", borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "#2dd4bf" },
  pendingText: { color: "#fff", fontSize: 15, fontWeight: "600", marginBottom: 8 },
  pendingRow: { flexDirection: "row", gap: 12 },
  pendingButton: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  yes: { backgroundColor: "#2dd4bf" },
  no: { backgroundColor: "#334155" },
  pendingButtonText: { color: "#0b1220", fontSize: 16, fontWeight: "700" },
  busy: { color: "#2dd4bf", fontSize: 13, marginBottom: 6 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch" },
  input: { flex: 1, backgroundColor: "rgba(26,34,51,0.95)", color: "#fff", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  repeatButton: { backgroundColor: "#1a2233", width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  repeatText: { color: "#8892a6", fontSize: 20 },
  micButton: { backgroundColor: "#2dd4bf", width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  micButtonText: { fontSize: 24 },
  micListening: { backgroundColor: "#f87171" },
  consentSub: { color: "#cbd5e1", fontSize: 12, marginBottom: 10 },
  handsFreeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  handsFreeText: { color: "#8892a6", fontSize: 12 },
  demoIntents: { alignItems: "flex-end", gap: 6, marginTop: 8 },
  intentButton: { backgroundColor: "#2a1f55", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  intentButtonText: { color: "#c4b5fd", fontSize: 11 },
});
