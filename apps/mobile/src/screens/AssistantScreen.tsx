// NAVIA co-pilot: a calm human-like helper, by voice or text. Opens with the
// situation right now (alert, GPS, trip), answers with distance + direction
// and action buttons (walk to the shelter, call 112, "I've turned", "I'm
// here"). On-device answers work without network; the Claude co-pilot is used
// for the wording when the NAVIA server is connected, with the same actions.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { recordRender } from "../perf/perf";
import { benchHooks } from "../perf/bench";
import * as Haptics from "expo-haptics";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { ExpoSpeechVoiceProvider } from "../providers/ExpoSpeechVoiceProvider";
import { useAppSettings } from "../settings/AppSettings";
import { understand, type NavigatorIntent } from "../ai/navigator/intents";
import { detectIntent, detectKind, directionWords, greeting, suggestions, walkMinutes, type CopilotAction, type CopilotReply, type CopilotWorld, type PlaceKind, type WorldPlace } from "../ai/copilotBrain";
import { useCopilotWorld } from "../ai/useCopilotWorld";
import { askSmart, Navigator, wantsModel, type NavigatorReply } from "../ai/navigator/navigator";
import { languageLevel, remoteLanguageAvailable } from "../ai/navigator/languageEngine";
import { wantsTripCopilot, yesNo } from "../ai/tripCopilot";
import { activeCopilot, useNaviaStore } from "../engine/naviaController";
import { useNavigatorSnapshot } from "../ai/navigator/useSnapshot";
import { useCopilotActions } from "../ai/useCopilotActions";
import { useNearbyStore } from "../store/nearbyStore";
import { clearSpeechQueue, nextTtsStart, say as sayQueued, stopSpeaking } from "../voice/VoiceGuide";
import { PRIORITY } from "../voice/speechQueue";
import { recordVoiceLatency } from "../perf/voiceLatency";
import { formatDistance, useT } from "../i18n";
import { CATEGORY_META } from "../places/categories";
import { Icon, type IconName } from "../components/Icon";
import { Chip, IconButton, StatusPill, Text, TextField, Touchable, useColors } from "../components/ui";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { radius, space } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Assistant">;
type Message = { id: number; role: "assistant" | "user"; text: string; actions?: CopilotAction[]; places?: WorldPlace[] };
const listener = new ExpoSpeechVoiceProvider();
/** High-resolution clock when available (RN provides performance.now). */
const nowMs = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** Plain sentences for speech: no bullets, numbering or line breaks. */
function forSpeech(text: string): string {
  return text.replace(/^\s*(\d+\.|•)\s*/gm, "").replace(/\n+/g, ". ").replace(/\.\s*\./g, ".").replace(/«|»/g, "");
}

export function AssistantScreen({ route: navRoute, navigation }: Props): JSX.Element {
  // Render → commit time of every update (works in release builds; bench + perf log).
  const renderStart = nowMs();
  useLayoutEffect(() => { recordRender("assistant", "commit", nowMs() - renderStart); });
  const c = useColors();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const { voiceGender } = useAppSettings();
  const world = useCopilotWorld();
  const worldRef = useRef<CopilotWorld>(world);
  worldRef.current = world;
  // The navigator (5 layers): every answer from the live snapshot.
  const snapshot = useNavigatorSnapshot();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const navigatorRef = useRef(new Navigator());
  // The text field lives in <Composer> (typing does not re-render the screen).
  const composer = useRef<ComposerHandle>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  /** The microphone really records (audiostart): only then "Говоріть". */
  const [micReady, setMicReady] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => {
    const g = greeting(world);
    return [{ id: 1, role: "assistant", text: g.text, actions: g.actions }];
  });
  const seq = useRef(1);
  const list = useRef<FlatList<Message>>(null);
  const handled = useRef(false);
  const remote = remoteLanguageAvailable();

  // Keep shelters ready for the most important question.
  useEffect(() => {
    for (const k of ["shelter", "pharmacy", "fuel", "shop", "hospital", "atm"] as const) void useNearbyStore.getState().load(k);
  }, []);

  // Answers go through the shared queue: a proactive message being spoken is
  // finished first (programme 2.4).
  const say = useCallback(async (text: string) => {
    setSpeaking(true);
    try { await sayQueued(forSpeech(text), PRIORITY.answer, { lang, gender: voiceGender }); } finally { setSpeaking(false); }
  }, [lang, voiceGender]);

  // Instant replies: the answer is computed from what NAVIA knows right now
  // (≈1–6 ms) and shown immediately — never after waiting for the network.
  // If the question needs places that are still loading, that first reply
  // says so, and the SAME message is updated when the data lands.
  const [followUps, setFollowUps] = useState<{ id: number; text: string; kind: PlaceKind; spoken: boolean }[]>([]);
  const timing = useRef<{ id: number; t0: number; computeMs: number; question: string } | null>(null);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);

  /** A question waiting for the one-time consent answer; asked again after it. */
  const pendingQuestion = useRef<{ text: string; spoken: boolean } | null>(null);
  const sendRef = useRef<((raw: string, spoken?: boolean) => void) | null>(null);

  const send = useCallback((raw: string, spoken = false) => {
    const text = raw.trim();
    if (!text) return;
    const store = useNaviaStore.getState();
    const addPair = (assistant: Omit<Message, "id" | "role">): number => {
      const userId = ++seq.current;
      const replyId = ++seq.current;
      setMessages((old) => [...old, { id: userId, role: "user", text }, { id: replyId, role: "assistant", ...assistant }]);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60);
      return replyId;
    };

    // The one-time answer about sending questions to the NAVIA server (spec section 30).
    if (text === t("copilot.consentYes") || text === t("copilot.consentNo")) {
      const on = text === t("copilot.consentYes");
      store.setAiContextConsent(on);
      addPair({ text: on ? t("copilot.consentOn") : t("copilot.consentOff") });
      const again = pendingQuestion.current;
      pendingQuestion.current = null;
      if (again) setTimeout(() => sendRef.current?.(again.text, again.spoken), 50);
      return;
    }

    // Doing something with the trip (a stop on the way, no toll roads, home,
    // a reminder, undo) or answering the co-pilot's yes/no proposal: the
    // tool-calling trip co-pilot (packages/core/src/copilot).
    const copilot = activeCopilot();
    const yn = copilot.getPendingAction() ? yesNo(text) : null;
    const tripAction = yn != null || wantsTripCopilot(text, store.route != null);
    const needsModel = tripAction || (remote && wantsModel(text, understand(text)));
    if (needsModel && remote && !store.aiConsentAsked) {
      pendingQuestion.current = { text, spoken };
      addPair({
        text: t("copilot.consentQuestion"),
        actions: [{ kind: "ask", label: t("copilot.consentYes"), question: t("copilot.consentYes") }, { kind: "ask", label: t("copilot.consentNo"), question: t("copilot.consentNo") }],
      });
      if (spoken) void say(t("copilot.consentQuestion"));
      return;
    }
    if (tripAction) {
      const replyId = addPair({ text: t("copilot.thinking") });
      setBusy(true);
      const job = yn === "yes" ? copilot.confirmPendingAction() : yn === "no" ? Promise.resolve(copilot.declinePendingAction()) : copilot.ask(text);
      void job
        .then((r) => {
          const actions: CopilotAction[] = r.pendingAction
            ? [{ kind: "ask", label: t("copilot.yes"), question: t("copilot.yes") }, { kind: "ask", label: t("copilot.no"), question: t("copilot.no") }]
            : [];
          setMessages((old) => old.map((m) => (m.id === replyId ? { ...m, text: r.text, actions } : m)));
          // A route the co-pilot changed (stop added, preferences, new destination) shows at once.
          useNaviaStore.getState().refresh();
          if (spoken) void say(r.text);
        })
        .catch(() => setMessages((old) => old.map((m) => (m.id === replyId ? { ...m, text: t("copilot.tripUnavailable") } : m))))
        .finally(() => setBusy(false));
      return;
    }

    const t0 = nowMs();
    const w = worldRef.current;
    const reply = navigatorRef.current.ask(text, snapshotRef.current);
    const local: CopilotReply = { intent: detectIntent(text), text: reply.text, actions: reply.actions, ...(reply.places ? { places: reply.places } : {}) };
    const computeMs = nowMs() - t0;
    if (__DEV__) console.log(`[navigator] «${text}» → ${reply.intent} (${reply.used.join(", ")}${reply.missing.length ? `; missing ${reply.missing.join(", ")}` : ""}) ${reply.computeMs.toFixed(1)} ms`);
    const userId = ++seq.current;
    const replyId = ++seq.current;
    timing.current = { id: replyId, t0, computeMs, question: text };
    // Not sure on the phone (or not understood): the language model (NAVIA
    // proxy, or the signed-in server) decides what is asked; answers about the
    // situation still come from the snapshot (askSmart). Otherwise the rules.
    const needRemote = remote && store.aiContextConsent && wantsModel(text, reply);
    // While the model is asked, the bubble says so (not the rules' refusal).
    const first = needRemote ? { text: t("copilot.thinking"), actions: [] } : { text: local.text, actions: local.actions, ...(local.places ? { places: local.places } : {}) };
    setMessages((old) => [...old, { id: userId, role: "user", text }, { id: replyId, role: "assistant", ...first }]);
    const speakReply = (r: NavigatorReply) => {
      if (!spoken) return;
      const stt = listener.lastTiming.sttMs;
      void nextTtsStart().then((tts) => recordVoiceLatency({ question: text, sttMs: stt, understandMs: r.computeMs, ttsStartMs: tts, totalMs: stt != null ? stt + r.computeMs + tts : null, at: Date.now() }));
      void say(r.speech).then(() => {
        // Natural loop (3.3): a question back is answered by voice without a tap.
        if (r.intent === "clarify") void listenRef.current?.();
      });
    };
    if (!needRemote) speakReply(reply);
    else {
      setBusy(true);
      const t1 = nowMs();
      void askSmart(navigatorRef.current, text, snapshotRef.current)
        .catch((): NavigatorReply => ({ ...reply, engine: "rules" }))
        .then((r) => {
          const fin = { ...r, computeMs: nowMs() - t1 };
          setMessages((old) => old.map((m) => (m.id === replyId ? { ...m, text: fin.text, actions: fin.actions, ...(fin.places ? { places: fin.places } : {}) } : m)));
          speakReply(fin);
        })
        .finally(() => setBusy(false));
    }
    const kind = detectKind(text);
    const intent = detectIntent(text);
    if (kind && intent === "place" && w.placeStates?.[kind] !== "ready") {
      setFollowUps((f) => [...f, { id: replyId, text, kind, spoken }]);
      void useNearbyStore.getState().load(kind);
    }
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60);
  }, [messages, remote, say, t]);
  sendRef.current = send;

  // When a place search that a reply was waiting for finishes, update that reply.
  useEffect(() => {
    if (followUps.length === 0) return;
    const doneNow = followUps.filter((f) => { const st = world.placeStates?.[f.kind]; return st === "ready" || st === "error"; });
    if (doneNow.length === 0) return;
    setFollowUps((f) => f.filter((x) => !doneNow.includes(x)));
    setMessages((old) => old.map((m) => {
      const f = doneNow.find((x) => x.id === m.id);
      if (!f) return m;
      const r = navigatorRef.current.ask(f.text, snapshotRef.current);
      if (f.spoken) void say(r.speech);
      return { ...m, text: r.text, actions: r.actions, ...(r.places ? { places: r.places } : {}) };
    }));
  }, [world, followUps, say]);

  // Stopwatch: tap/voice → reply on screen (committed).
  useEffect(() => {
    const tm = timing.current;
    if (!tm || !messages.some((m) => m.id === tm.id)) return;
    const shownMs = nowMs() - tm.t0;
    timing.current = null;
    setLastLatencyMs(Math.round(shownMs));
    if (__DEV__) console.log(`[copilot-timing] "${tm.question}" compute ${tm.computeMs.toFixed(1)} ms, on screen ${shownMs.toFixed(1)} ms`);
  }, [messages]);

  const listenRef = useRef<(() => Promise<void>) | null>(null);
  const listen = useCallback(async (hold = false) => {
    const wasSpeaking = speaking;
    stopSpeaking();
    clearSpeechQueue();
    setMicReady(false);
    setListening(true);
    // Let the audio session switch from speaking to recording first.
    if (wasSpeaking) await new Promise<void>((r) => setTimeout(r, 250));
    try {
      await listener.startListening((heard) => send(heard, true), {
        language: lang === "uk" ? "uk-UA" : "en-US", hold,
        onReady: () => { setMicReady(true); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); },
      });
    } catch (err) {
      if ((err as Error).name !== "VoiceCancelled") setMessages((old) => [...old, { id: ++seq.current, role: "assistant", text: (err as Error).message || t("copilot.error") }]);
    } finally {
      setListening(false);
      setMicReady(false);
    }
  }, [lang, send, t, speaking]);

  listenRef.current = () => listen(false);
  // Hold-to-talk: pressing starts listening, releasing ends the phrase; a
  // short tap listens until a pause.
  const pressedAt = useRef<number | null>(null);
  const onMicIn = useCallback(() => { pressedAt.current = Date.now(); void listen(true); }, [listen]);
  const onMicOut = useCallback(() => {
    const held = pressedAt.current != null ? Date.now() - pressedAt.current : 0;
    pressedAt.current = null;
    if (held > 400) listener.stopListening();
  }, []);

  const run = useCopilotActions(useCallback((q: string) => {
    // "Бачу …" is a prompt to type, not a finished question.
    if (/\s$/.test(q)) composer.current?.setText(q);
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

  // Benchmark hook (perf/bench.ts): ask as a person would.
  useEffect(() => {
    benchHooks.assistantAsk = (q) => send(q);
    return () => { benchHooks.assistantAsk = undefined; };
  });

  // Only what the chips depend on — not every GPS update.
  const chipKey = `${world.alert?.active}|${world.gps.state}|${world.gps.mode}|${!!world.route}|${world.route?.offRoute}|${lang}`;
  const chips = useMemo(() => suggestions(worldRef.current), [chipKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const runRef = useRef(run);
  runRef.current = run;
  const onAction = useCallback((a: CopilotAction) => runRef.current(a), []);
  const renderItem = useCallback(({ item }: { item: Message }) => <MessageRow item={item} lang={lang} onAction={onAction} />, [lang, onAction]);
  const onSend = useCallback((q: string) => { void sendRef.current?.(q); }, []);
  const level = languageLevel();

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { backgroundColor: c.background }]} keyboardVerticalOffset={insets.top + 44}>
      <Header active={busy || listening || speaking} status={listening ? (micReady ? t("copilot.speakNow") : t("copilot.micPreparing")) : speaking ? t("copilot.speaking") : busy ? t("copilot.thinking") : t("copilot.ready")}
        llm={level.mode === "llm"} />
      <FlatList
        ref={list}
        style={styles.flex}
        contentContainerStyle={styles.messages}
        data={messages}
        keyExtractor={keyOf}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={renderItem}
        removeClippedSubviews
        windowSize={7}
        ListFooterComponent={busy ? <ActivityIndicator color={c.accent} style={styles.busy} /> : null}
      />
      <Chips chips={chips} onSend={onSend} onISee={() => composer.current?.setText(t("copilot.iSeePrefix"))} />
      <Composer ref={composer} listening={listening} micReady={micReady} onSend={onSend} onMicIn={onMicIn} onMicOut={onMicOut} bottom={insets.bottom} />
    </KeyboardAvoidingView>
  );
}

const keyOf = (m: Message) => String(m.id);

const Header = React.memo(function Header({ active, status, llm }: { active: boolean; status: string; llm: boolean }): JSX.Element {
  const { t } = useT();
  return (
    <View style={styles.badgeRow}>
      <NaviaAiMark size={64} active={active} />
      <View style={styles.flex}>
        <Text variant="headline">{t("copilot.title")}</Text>
        <Text variant="caption" color="muted">{status}</Text>
      </View>
      <View style={styles.pillSlot}><StatusPill tone={llm ? "success" : "neutral"} icon="sparkle" label={llm ? t("copilot.levelLlm") : t("copilot.levelBasic")} /></View>
    </View>
  );
});

const MessageRow = React.memo(function MessageRow({ item, lang, onAction }: { item: Message; lang: "uk" | "en"; onAction: (a: CopilotAction) => void }): JSX.Element {
  const c = useColors();
  const { t } = useT();
  if (item.role === "user") {
    return (
      <View style={[styles.bubble, styles.user, { backgroundColor: c.accent }]}>
        <Text variant="callout" color="onAccent">{item.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.botBlock}>
      <View style={[styles.bubble, styles.bot, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text variant="callout">{item.text}</Text>
      </View>
      {item.places?.map((p) => <PlaceCard key={p.id} place={p} lang={lang} onRoute={(mode) => onAction({ kind: "route", label: "", mode, place: { name: p.name, lat: p.location.lat, lon: p.location.lon } })} t={t} />)}
      {item.actions && item.actions.length > 0 && (
        <View style={styles.actions}>
          {item.actions.map((a, i) => <ActionButton key={`${a.kind}-${i}`} action={a} onPress={() => onAction(a)} />)}
        </View>
      )}
    </View>
  );
});

const Chips = React.memo(function Chips({ chips, onSend, onISee }: { chips: CopilotAction[]; onSend: (q: string) => void; onISee: () => void }): JSX.Element {
  const { t } = useT();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts} style={styles.promptsScroll} keyboardShouldPersistTaps="handled">
      {chips.map((a) => a.kind === "ask" && <Chip key={a.question} label={a.label} onPress={() => onSend(a.question)} />)}
      <Chip label={t("copilot.iSee")} icon="eye" onPress={onISee} />
    </ScrollView>
  );
});

type ComposerHandle = { setText: (text: string) => void };
/** The text field keeps its own state: typing re-renders only this bar. */
const Composer = React.memo(React.forwardRef<ComposerHandle, { listening: boolean; micReady: boolean; onSend: (q: string) => void; onMicIn: () => void; onMicOut: () => void; bottom: number }>(function Composer({ listening, micReady, onSend, onMicIn, onMicOut, bottom }, ref) {
  const c = useColors();
  const { t } = useT();
  const [text, setText] = useState("");
  React.useImperativeHandle(ref, () => ({ setText }), []);
  useEffect(() => {
    benchHooks.assistantType = setText;
    return () => { benchHooks.assistantType = undefined; };
  }, []);
  const submit = () => { const q = text.trim(); if (!q) return; setText(""); onSend(q); };
  return (
    <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border, marginBottom: bottom + space.xs }]}>
      <TextField value={text} onChangeText={setText} placeholder={listening ? (micReady ? t("copilot.speakNow") : t("copilot.micPreparing")) : t("copilot.placeholder")} returnKeyType="send" onSubmitEditing={submit} accessibilityLabel={t("copilot.placeholder")} />
      {text.trim()
        ? <IconButton icon="send" tone="accent" size={40} label={t("copilot.send")} onPress={submit} />
        : <Touchable accessibilityRole="button" accessibilityLabel={t("copilot.mic")} accessibilityHint={t("copilot.micHold")} onPressIn={onMicIn} onPressOut={onMicOut} hitSlop={space.xxs}
            style={[styles.mic, { backgroundColor: listening ? c.critical : c.accent }]}>
            <Icon name="mic" size={22} color={c.onAccent} />
          </Touchable>}
    </View>
  );
}));

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
  mic: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  screen: { flex: 1, paddingHorizontal: space.md },
  flex: { flex: 1, minWidth: 0 },
  badgeRow: { paddingTop: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  pillSlot: { alignSelf: "center" },
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
