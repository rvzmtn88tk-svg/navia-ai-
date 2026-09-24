// NAVIA co-pilot: a calm human-like helper, by voice or text. Opens with the
// situation right now (alert, GPS, trip), answers with distance + direction
// and action buttons (walk to the shelter, call 112, "I've turned", "I'm
// here"). On-device answers work without network; the Claude co-pilot is used
// for the wording when the NAVIA server is connected, with the same actions.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";
import { useAppSettings } from "../settings/AppSettings";
import { askRemote, remoteCopilotAvailable, type CopilotTurn } from "../ai/copilotClient";
import { stateFromWorld } from "../ai/copilotState";
import { answer, detectIntent, detectKind, directionWords, greeting, suggestions, walkMinutes, type CopilotAction, type CopilotReply, type CopilotWorld, type WorldPlace } from "../ai/copilotBrain";
import { useCopilotWorld } from "../ai/useCopilotWorld";
import { useCopilotActions } from "../ai/useCopilotActions";
import { useNearbyStore } from "../store/nearbyStore";
import { speak, stopSpeaking } from "../voice/VoiceGuide";
import { formatDistance, useT } from "../i18n";
import { CATEGORY_META } from "../places/categories";
import { Icon, type IconName } from "../components/Icon";
import { Chip, IconButton, StatusPill, Text, TextField, Touchable, useColors } from "../components/ui";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { radius, space } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Assistant">;
type Message = { id: number; role: "assistant" | "user"; text: string; actions?: CopilotAction[]; places?: WorldPlace[] };
const listener = new ExpoSpeechVoiceProvider();

/** Plain sentences for speech: no bullets, numbering or line breaks. */
function forSpeech(text: string): string {
  return text.replace(/^\s*(\d+\.|•)\s*/gm, "").replace(/\n+/g, ". ").replace(/\.\s*\./g, ".").replace(/«|»/g, "");
}

export function AssistantScreen({ route: navRoute, navigation }: Props): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { voiceGender } = useAppSettings();
  const world = useCopilotWorld();
  const worldRef = useRef<CopilotWorld>(world);
  worldRef.current = world;
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => {
    const g = greeting(world);
    return [{ id: 1, role: "assistant", text: g.text, actions: g.actions }];
  });
  const seq = useRef(1);
  const list = useRef<FlatList<Message>>(null);
  const handled = useRef(false);
  const remote = remoteCopilotAvailable();

  // Keep shelters ready for the most important question.
  useEffect(() => { void useNearbyStore.getState().load("shelter"); }, []);

  const say = useCallback(async (text: string) => {
    setSpeaking(true);
    try { await speak(forSpeech(text), { lang, gender: voiceGender }); } finally { setSpeaking(false); }
  }, [lang, voiceGender]);

  const send = useCallback(async (raw: string, spoken = false) => {
    const text = raw.trim();
    if (!text || busy) return;
    const history: CopilotTurn[] = messages.slice(1).map((m) => ({ role: m.role, text: m.text }));
    setMessages((old) => [...old, { id: ++seq.current, role: "user", text }]);
    setQuestion("");
    setBusy(true);
    // Make sure the data the question needs is loaded (e.g. pharmacies).
    const kind = detectKind(text);
    const intent = detectIntent(text);
    const needs = kind ? [kind] : intent === "whereAmI" || intent === "lost" ? (["shop", "pharmacy"] as const) : intent === "emergency" ? (["hospital"] as const) : [];
    if (needs.length) {
      await Promise.race([
        Promise.all(needs.map((k) => useNearbyStore.getState().load(k))),
        new Promise<void>((resolve) => { setTimeout(() => resolve(), 9_000); }),
      ]);
      await new Promise<void>((resolve) => { setTimeout(() => resolve(), 30); }); // let the world re-render
    }
    const w = worldRef.current;
    const local: CopilotReply = answer(text, w);
    let reply: Message = { id: ++seq.current, role: "assistant", text: local.text, actions: local.actions, ...(local.places ? { places: local.places } : {}) };
    if (remote) {
      try {
        const r = await askRemote(text, stateFromWorld(w), history);
        // Claude words the answer; the buttons stay NAVIA's own.
        reply = { ...reply, text: r.answer };
      } catch { /* on-device answer already prepared */ }
    }
    setMessages((old) => [...old, reply]);
    setBusy(false);
    if (spoken) void say(reply.text);
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60);
  }, [busy, messages, remote, say]);

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

  const run = useCopilotActions(useCallback((q: string) => {
    // "Бачу …" is a prompt to type, not a finished question.
    if (/\s$/.test(q)) setQuestion(q);
    else void send(q);
  }, [send]));

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const q = navRoute.params?.initialQuestion?.trim();
    if (q) void send(q);
    else if (navRoute.params?.voice) {
      // Say the situation first, then listen.
      void say(messages[0]!.text).then(() => listen());
    }
    navigation.setParams({ initialQuestion: undefined, voice: undefined });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = suggestions(world);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { backgroundColor: c.background }]} keyboardVerticalOffset={insets.top + 44}>
      <View style={styles.badgeRow}>
        <NaviaAiMark size={56} active={busy || listening || speaking} />
        <View style={styles.flex}>
          <Text variant="headline">{t("copilot.title")}</Text>
          <Text variant="caption" color="muted">{listening ? t("copilot.listening") : speaking ? t("copilot.speaking") : busy ? t("copilot.thinking") : t("copilot.ready")}</Text>
        </View>
        <StatusPill tone={remote ? "success" : "neutral"} icon="sparkle" label={remote ? "Claude" : t("copilot.onDevice")} />
      </View>
      <FlatList
        ref={list}
        style={styles.flex}
        contentContainerStyle={styles.messages}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => item.role === "user" ? (
          <View style={[styles.bubble, styles.user, { backgroundColor: c.accent }]}>
            <Text variant="callout" color="onAccent">{item.text}</Text>
          </View>
        ) : (
          <View style={styles.botBlock}>
            <View style={[styles.bubble, styles.bot, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text variant="callout">{item.text}</Text>
            </View>
            {item.places?.map((p) => <PlaceCard key={p.id} place={p} lang={lang} onRoute={(mode) => run({ kind: "route", label: "", mode, place: { name: p.name, lat: p.location.lat, lon: p.location.lon } })} t={t} />)}
            {item.actions && item.actions.length > 0 && (
              <View style={styles.actions}>
                {item.actions.map((a, i) => <ActionButton key={`${a.kind}-${i}`} action={a} onPress={() => run(a)} />)}
              </View>
            )}
          </View>
        )}
        ListFooterComponent={busy ? <ActivityIndicator color={c.accent} style={styles.busy} /> : null}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts} style={styles.promptsScroll} keyboardShouldPersistTaps="handled">
        {chips.map((a) => a.kind === "ask" && <Chip key={a.question} label={a.label} onPress={() => void send(a.question)} />)}
        <Chip label={t("copilot.iSee")} icon="eye" onPress={() => setQuestion(t("copilot.iSeePrefix"))} />
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

function PlaceCard({ place, lang, onRoute, t }: { place: WorldPlace; lang: "uk" | "en"; onRoute: (mode: "walk" | "car") => void; t: ReturnType<typeof useT>["t"] }): JSX.Element {
  const c = useColors();
  const meta = CATEGORY_META[place.kind];
  const dir = directionWords(place.bearingDeg, lang);
  const walk = place.distanceM <= 3000 ? ` · ≈${walkMinutes(place.distanceM)} ${t("copilot.minWalk")}` : "";
  return (
    <View style={[styles.placeCard, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
      <View style={[styles.placeIcon, { backgroundColor: meta.color }]}><Icon name={meta.icon} size={18} color={c.onMarker} /></View>
      <View style={styles.flex}>
        <Text variant="bodyStrong" numberOfLines={1}>{place.name}</Text>
        <Text variant="caption" color="secondary" numberOfLines={1}>{`${formatDistance(place.distanceM, lang)}${dir ? ` ${dir}` : ""}${walk}`}</Text>
      </View>
      <Touchable accessibilityRole="button" accessibilityLabel={t("route.walk")} onPress={() => onRoute("walk")} style={[styles.miniBtn, { backgroundColor: c.accentSoft }]}>
        <Icon name="walk" size={18} color={c.accent} />
      </Touchable>
      <Touchable accessibilityRole="button" accessibilityLabel={t("route.car")} onPress={() => onRoute("car")} style={[styles.miniBtn, { backgroundColor: c.accentSoft }]}>
        <Icon name="car" size={18} color={c.accent} />
      </Touchable>
    </View>
  );
}

const ACTION_ICON: Record<CopilotAction["kind"], IconName> = {
  route: "route", call: "phone", open: "globe", search: "search", confirmTurn: "check", correctPosition: "pin", safety: "shield", ask: "sparkle",
};

function ActionButton({ action, onPress }: { action: CopilotAction; onPress: () => void }): JSX.Element {
  const c = useColors();
  const strong = action.kind === "route" || action.kind === "call" || action.kind === "confirmTurn" || action.kind === "correctPosition";
  const danger = action.kind === "call";
  const bg = danger ? c.critical : strong ? c.accent : c.surfaceMuted;
  const fg = danger ? c.onCritical : strong ? c.onAccent : c.textPrimary;
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={action.label} onPress={onPress} style={[styles.action, { backgroundColor: bg }]}>
      <Icon name={action.kind === "route" && action.mode === "walk" ? "walk" : action.kind === "route" ? "car" : ACTION_ICON[action.kind]} size={16} color={fg} />
      <Text variant="subhead" color={{ custom: fg }} numberOfLines={1}>{action.label.trim()}</Text>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.md },
  flex: { flex: 1, minWidth: 0 },
  badgeRow: { paddingTop: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  messages: { paddingVertical: space.md, gap: space.sm },
  bubble: { maxWidth: "88%", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg },
  user: { alignSelf: "flex-end", borderBottomRightRadius: radius.sm / 2 },
  bot: { alignSelf: "flex-start", borderWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: radius.sm / 2 },
  botBlock: { gap: space.xs, alignItems: "flex-start" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  action: { flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.sm, minHeight: 36, borderRadius: radius.pill, maxWidth: "100%" },
  placeCard: { alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  placeIcon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  miniBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  busy: { alignSelf: "flex-start", marginTop: space.xs },
  promptsScroll: { flexGrow: 0 },
  prompts: { gap: space.xs, paddingVertical: space.xs },
  composer: { flexDirection: "row", alignItems: "center", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, paddingLeft: space.md, paddingRight: space.xxs, minHeight: 52 },
});
