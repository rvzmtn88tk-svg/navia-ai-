// NAVIA co-pilot chat: text or voice. Answers come from Claude (server) when
// signed in, otherwise from on-device logic; both see the same structured
// state and never receive coordinates.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { DEMO_POIS, type NavigationContext } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { activeEngine, useNaviaStore } from "../engine/naviaController";
import { NearbyPlacesProvider, type NearbyPlace } from "../providers/NearbyPlacesProvider";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";
import { useAppSettings } from "../settings/AppSettings";
import { buildCopilotState } from "../ai/copilotState";
import { askRemote, remoteCopilotAvailable, type CopilotTurn } from "../ai/copilotClient";
import { answerLocally } from "../ai/localCopilot";
import { speak, stopSpeaking } from "../voice/VoiceGuide";
import { useT } from "../i18n";
import { Chip, IconButton, StatusPill, Text, TextField, useColors } from "../components/ui";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { radius, space } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Assistant">;
type Message = { id: number; role: "assistant" | "user"; text: string };
const placesProvider = new NearbyPlacesProvider();
const listener = new ExpoSpeechVoiceProvider();

export function AssistantScreen({ route: navRoute, navigation }: Props): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { voiceGender } = useAppSettings();
  const state = useNaviaStore((s) => s.state);
  const route = useNaviaStore((s) => s.route);
  const fix = useNaviaStore((s) => s.currentFix);
  const alert = useNaviaStore((s) => s.alert);
  const threat = useNaviaStore((s) => s.airThreatSummary);
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [messages, setMessages] = useState<Message[]>([{ id: 1, role: "assistant", text: t("copilot.greeting") }]);
  const seq = useRef(1);
  const list = useRef<FlatList<Message>>(null);
  const handled = useRef(false);
  const remote = remoteCopilotAvailable();

  useEffect(() => {
    if (!fix) return;
    placesProvider.fetchNearby({ lat: fix.lat, lon: fix.lon }, { includeKyivOfficialData: alert?.region === "м. Київ" }).then(setPlaces).catch(() => setPlaces([]));
  }, [fix?.lat, fix?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (raw: string, spoken = false) => {
    const text = raw.trim();
    if (!text || busy) return;
    const history: CopilotTurn[] = messages.slice(1).map((m) => ({ role: m.role, text: m.text }));
    setMessages((old) => [...old, { id: ++seq.current, role: "user", text }]);
    setQuestion("");
    setBusy(true);
    const copilotState = buildCopilotState({
      lang, gnss: state.gnss, confidenceBand: state.confidenceBand,
      destinationLabel: null, nextStep: state.nextStep, nextStepDistanceM: state.nextStepDistanceM,
      routeRemainingM: route ? state.routeRemainingM : null, etaSeconds: route ? state.etaSeconds : null, offRoute: state.offRoute,
      alert, regionSummary: threat && alert && threat.region === alert.region ? `${threat.state}: ${threat.threatKinds.join(", ")}` : null,
      places: places.map((p) => ({ name: p.name, category: p.category, distanceM: p.distanceM })),
    });
    let answer: string;
    try {
      answer = remote ? (await askRemote(text, copilotState, history)).answer : await answerLocally(text, copilotState, localContext());
    } catch {
      try { answer = await answerLocally(text, copilotState, localContext()); } catch { answer = t("copilot.error"); }
    }
    setMessages((old) => [...old, { id: ++seq.current, role: "assistant", text: answer }]);
    setBusy(false);
    if (spoken) void speak(answer, { lang, gender: voiceGender });
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);

    function localContext(): NavigationContext {
      return {
        state, route, nearbyLandmarks: state.nearbyLandmarks,
        nearbyPOI: [
          ...places.map((p) => ({ id: p.id, name: p.name, category: p.category === "fuel" ? "fuel" as const : p.category === "pharmacy" ? "pharmacy" as const : p.category === "hospital" ? "hospital" as const : p.category === "shop" ? "supermarket" as const : "recognizable_landmark" as const, location: p.location })),
          ...(useNaviaStore.getState().isDemoMode ? DEMO_POIS : []),
        ],
        recentEvents: [...activeEngine().getTelemetry().getEvents()],
      };
    }
  }, [alert, busy, lang, messages, places, remote, route, state, t, threat, voiceGender]);

  const listen = useCallback(async () => {
    stopSpeaking();
    setListening(true);
    try {
      await listener.startListening((heard) => send(heard, true), { language: lang === "uk" ? "uk-UA" : "en-US" });
    } catch (err) {
      setMessages((old) => [...old, { id: ++seq.current, role: "assistant", text: (err as Error).message || t("copilot.error") }]);
    } finally {
      setListening(false);
    }
  }, [lang, send, t]);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const q = navRoute.params?.initialQuestion?.trim();
    if (q) void send(q);
    else if (navRoute.params?.voice) void listen();
    navigation.setParams({ initialQuestion: undefined, voice: undefined });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const prompts = [t("copilot.prompt.next"), t("copilot.prompt.gps"), t("copilot.prompt.shelter"), t("copilot.prompt.fuel")];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { backgroundColor: c.background }]} keyboardVerticalOffset={insets.top + 44}>
      <View style={styles.badgeRow}>
        <NaviaAiMark size={56} active={busy || listening} />
        <StatusPill tone={remote ? "success" : "neutral"} icon="sparkle" label={remote ? "Claude" : lang === "uk" ? "Локальний режим" : "On-device mode"} />
      </View>
      <FlatList
        ref={list}
        style={styles.flex}
        contentContainerStyle={styles.messages}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === "user" ? [styles.user, { backgroundColor: c.accent }] : [styles.bot, { backgroundColor: c.surface, borderColor: c.border }]]}>
            <Text variant="callout" color={item.role === "user" ? "onAccent" : "primary"}>{item.text}</Text>
          </View>
        )}
        ListFooterComponent={busy ? <ActivityIndicator color={c.accent} style={styles.busy} /> : null}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts} style={styles.promptsScroll} keyboardShouldPersistTaps="handled">
        {prompts.map((p) => <Chip key={p} label={p} onPress={() => void send(p)} />)}
      </ScrollView>
      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border, marginBottom: insets.bottom + space.xs }]}>
        <TextField value={question} onChangeText={setQuestion} placeholder={listening ? t("copilot.listening") : t("copilot.placeholder")} returnKeyType="send" onSubmitEditing={() => void send(question)} accessibilityLabel={t("copilot.placeholder")} />
        {question.trim()
          ? <IconButton icon="send" tone="accent" size={40} label={t("copilot.send")} onPress={() => void send(question)} />
          : <IconButton icon="mic" tone="accent" active={listening} size={40} label={t("copilot.mic")} onPress={() => void listen()} />}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.md },
  flex: { flex: 1 },
  badgeRow: { paddingTop: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  messages: { paddingVertical: space.md, gap: space.xs },
  bubble: { maxWidth: "86%", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg },
  user: { alignSelf: "flex-end", borderBottomRightRadius: radius.sm / 2 },
  bot: { alignSelf: "flex-start", borderWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: radius.sm / 2 },
  busy: { alignSelf: "flex-start", marginTop: space.xs },
  promptsScroll: { flexGrow: 0 },
  prompts: { gap: space.xs, paddingVertical: space.xs },
  composer: { flexDirection: "row", alignItems: "center", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, paddingLeft: space.md, paddingRight: space.xxs, minHeight: 52 },
});
