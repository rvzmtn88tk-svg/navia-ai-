import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { NavigationContext } from "@navia/core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { DEMO_POIS } from "@navia/core";
import { activeEngine, useNaviaStore } from "../engine/naviaController";
import { DeterministicDemoAIProvider } from "@navia/core";
import { NearbyPlacesProvider, type NearbyPlace } from "../providers/NearbyPlacesProvider";
import { useAppSettings } from "../settings/AppSettings";
import { NaviaAiMark } from "../components/NaviaAiMark";
import { AppText as Text, AppTextInput as TextInput } from "../components/AppText";

type Props = NativeStackScreenProps<RootStackParamList, "Assistant">;
type Message = { id: number; role: "assistant" | "user"; text: string };
const localAssistant = new DeterministicDemoAIProvider();
const placesProvider = new NearbyPlacesProvider();

export function AssistantScreen({ route: navRoute, navigation }: Props): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  const { state, route, currentFix, alert } = useNaviaStore();
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [loadingPlaces, setLoadingPlaces] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([{ id: 1, role: "assistant", text: en ? "I'm NAVIA, your navigation co-pilot. Ask me about your route, GPS, nearby fuel or safety places." : "Я NAVIA, ваш навігаційний штурман. Запитайте про маршрут, GPS, заправки чи безпечні місця поруч." }]);
  const sequence = useRef(1);
  const handledQuestion = useRef<string | undefined>(undefined);
  const list = useRef<FlatList<Message>>(null);
  const styles = makeStyles(p);

  useEffect(() => {
    setMessages([{ id: 1, role: "assistant", text: en ? "I'm NAVIA, your navigation co-pilot. Ask me about your route, GPS, nearby fuel or safety places." : "Я NAVIA, ваш навігаційний штурман. Запитайте про маршрут, GPS, заправки чи безпечні місця поруч." }]);
  }, [en]);

  const loadPlaces = useCallback(async () => {
    if (!currentFix) return;
    setLoadingPlaces(true);
    try {
      const found = await placesProvider.fetchNearby({ lat: currentFix.lat, lon: currentFix.lon }, { includeKyivOfficialData: alert?.region === "м. Київ" });
      setPlaces(found);
    } catch {
      setPlaces([]);
    } finally { setLoadingPlaces(false); }
  }, [alert?.region, currentFix]);

  useEffect(() => { void loadPlaces(); }, [loadPlaces]);

  useEffect(() => {
    const initialQuestion = navRoute.params?.initialQuestion?.trim();
    if (!initialQuestion || handledQuestion.current === initialQuestion) return;
    handledQuestion.current = initialQuestion;
    void send(initialQuestion);
    navigation.setParams({ initialQuestion: undefined });
  }, [navigation, navRoute.params?.initialQuestion]);

  async function answerLocal(text: string): Promise<string> {
    const q = text.toLocaleLowerCase(en ? "en-US" : "uk-UA");
    const fix = currentFix;
    if (/(gps|gnss|signal|сигнал|точність)/i.test(q)) {
      if (!fix) return en ? "I don't have a current GPS fix. Allow location access on the home screen first." : "Поки немає актуального GPS-заміру. Дозвольте геолокацію на головному екрані.";
      const age = Math.max(0, Date.now() - fix.timestamp);
      if (age > 15000) return en ? "The last GPS fix is stale. I can't confirm your current position." : "Останній GPS-замі́р застарів. Я не можу підтвердити ваше теперішнє місце.";
      return en ? `GPS fix received${fix.accuracyM != null ? `, accuracy about ${Math.round(fix.accuracyM)} m` : ""}.` : `GPS-сигнал є${fix.accuracyM != null ? `, точність близько ${Math.round(fix.accuracyM)} м` : ""}.`;
    }
    if (/(де я|місцезнаходж|координат)/i.test(q) && !en) {
      return fix ? `Ваші останні координати: ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}. Точність GPS ${fix.accuracyM != null ? `близько ${Math.round(fix.accuracyM)} м` : "невідома"}.` : "Поки немає актуального GPS-заміру.";
    }
    if (/(shelter|укрит|бомбосхов|незламност|warming)/i.test(q)) {
      const nearest = places.filter((item) => item.category === "shelter" || item.category === "resilience").sort((a, b) => a.distanceM - b.distanceM)[0];
      if (nearest) return en ? `Closest listed place: ${nearest.name}, about ${Math.round(nearest.distanceM)} m away. Source: ${nearest.source}. Check access on arrival.` : `Найближча точка у доступних даних: ${nearest.name}, приблизно ${Math.round(nearest.distanceM)} м. Джерело: ${nearest.source}. Перевірте доступність на місці.`;
      return en ? "I couldn't load nearby safety places right now. Use the official Kyiv shelter map or the Diia Unbreakability map, and follow emergency-service instructions." : "Не вдалося завантажити точки безпеки. Скористайтеся офіційною мапою укриттів Києва або мапою Пунктів незламності в Дії та дотримуйтеся вказівок служб.";
    }
    if (/(fuel|gas station|petrol|заправ|пальн)/i.test(q)) {
      const nearest = places.filter((item) => item.category === "fuel").sort((a, b) => a.distanceM - b.distanceM)[0];
      return nearest ? (en ? `Nearest fuel station in the map data: ${nearest.name}, ${Math.round(nearest.distanceM)} m away.` : `Найближча АЗС у даних мапи: ${nearest.name}, ${Math.round(nearest.distanceM)} м.`) : (en ? "I don't have nearby fuel-station data yet. Check your internet connection and refresh nearby places." : "Поки немає даних про АЗС поруч. Перевірте інтернет і повторіть пошук місць.");
    }
    if (/(shop|store|магазин|супермаркет)/i.test(q)) {
      const nearest = places.filter((item) => item.category === "shop").sort((a, b) => a.distanceM - b.distanceM)[0];
      return nearest ? (en ? `Nearest shop in the map data: ${nearest.name}, ${Math.round(nearest.distanceM)} m away.` : `Найближчий магазин у даних мапи: ${nearest.name}, ${Math.round(nearest.distanceM)} м.`) : (en ? "No nearby shops were returned by the map source." : "Джерело мапи не повернуло магазинів поблизу.");
    }
    if (/(alert|тривог)/i.test(q)) {
      if (!alert || alert.active == null) return en ? "The location-based alert status is unavailable. Keep official notifications enabled." : "Статус тривоги за місцем зараз невідомий. Не вимикайте офіційні сповіщення.";
      return en ? `${alert.active ? "An alert is active" : "No alert is listed"} for ${alert.locationLabel}. This is informational; follow official alerts.` : `${alert.active ? "Зафіксована тривога" : "Тривогу не зафіксовано"} для району ${alert.locationLabel}. Це інформаційні дані — перевіряйте офіційні сповіщення.`;
    }

    const context: NavigationContext = {
      state,
      route,
      nearbyLandmarks: state.nearbyLandmarks,
      nearbyPOI: [
        ...places.map((item) => ({ id: item.id, name: item.name, category: item.category === "fuel" ? "fuel" as const : item.category === "pharmacy" ? "pharmacy" as const : item.category === "hospital" ? "hospital" as const : item.category === "shop" ? "supermarket" as const : "recognizable_landmark" as const, location: item.location })),
        ...(useNaviaStore.getState().isDemoMode ? DEMO_POIS : []),
      ],
      recentEvents: [...activeEngine().getTelemetry().getEvents()],
    };
    if (en) {
      if (/(turn|next|route|where|position|далі)/i.test(q) && !route) return "There is no active route yet. Search for a destination to start navigation.";
      if (/(route|how far|arrival|destination)/i.test(q) && route) return `About ${(state.routeRemainingM / 1000).toFixed(1)} km remain${state.speedMps && state.speedMps > 0.5 ? `, roughly ${Math.round(state.routeRemainingM / state.speedMps / 60)} min at the current speed` : ""}.`;
      if (/(turn|next|maneuver)/i.test(q) && state.nextStep) return `In about ${Math.round(state.nextStep.distanceM)} m, ${state.nextStep.maneuver}${state.nextStep.roadName ? ` onto ${state.nextStep.roadName}` : ""}.`;
      if (/(where|position)/i.test(q)) return fix ? `Your last GPS fix is ${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}. Accuracy ${fix.accuracyM != null ? `about ${Math.round(fix.accuracyM)} m` : "unknown"}.` : "I don't have a current GPS fix yet.";
      return "I'm an on-device route assistant and answer from NAVIA's GPS, route and nearby map data. A cloud AI model is not connected in this build.";
    }
    return localAssistant.answer(context, text);
  }

  async function send(text = question) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const userMessage: Message = { id: ++sequence.current, role: "user", text: trimmed };
    setMessages((old) => [...old, userMessage]);
    setQuestion("");
    setBusy(true);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const response = await answerLocal(trimmed);
      setMessages((old) => [...old, { id: ++sequence.current, role: "assistant", text: response }]);
    } catch {
      setMessages((old) => [...old, { id: ++sequence.current, role: "assistant", text: en ? "I couldn't prepare an answer from the available NAVIA data. Please try again." : "Не вдалося підготувати відповідь із доступних даних NAVIA. Спробуйте ще раз." }]);
    } finally {
      setBusy(false);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 30);
    }
  }

  const prompts = en ? ["Next turn?", "GPS status?", "Nearest shelter?", "Nearest fuel?"] : ["Який наступний поворот?", "Стан GPS?", "Найближче укриття?", "Де заправка?"];
  return (
    <View style={[styles.screen, { backgroundColor: p.background }]}>
      <View style={[styles.header, { backgroundColor: p.surface, borderColor: p.border }]}>
        <NaviaAiMark size={46} />
        <View style={{ flex: 1 }}><Text style={[styles.heading, { color: p.text }]}>{en ? "Your co-pilot" : "Ваш штурман"}</Text><Text style={[styles.caption, { color: p.subtle }]}>{en ? "Local navigation assistant" : "Локальний помічник навігації"}</Text></View>
        {loadingPlaces && <ActivityIndicator color={p.accent} />}
      </View>
      <View style={[styles.notice, { backgroundColor: p.surfaceRaised }]}><Text style={[styles.noticeText, { color: p.muted }]}>{en ? "Answers use NAVIA's current route, GPS and map data. Cloud AI isn't connected yet." : "Відповіді враховують маршрут, GPS і дані мапи NAVIA. Хмарна мовна модель поки не підключена."}</Text></View>
      <FlatList ref={list} style={styles.list} contentContainerStyle={styles.messageList} data={messages} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <View style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble, { backgroundColor: item.role === "user" ? p.accent : p.surface, borderColor: p.border }]}><Text style={[styles.messageText, { color: item.role === "user" ? p.accentText : p.text }]}>{item.text}</Text></View>} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prompts}>{prompts.map((prompt) => <Pressable key={prompt} style={[styles.prompt, { backgroundColor: p.surface, borderColor: p.border }]} onPress={() => void send(prompt)}><Text style={[styles.promptText, { color: p.text }]}>{prompt}</Text></Pressable>)}</ScrollView>
      <View style={[styles.composer, { backgroundColor: p.surface, borderColor: p.border }]}><TextInput style={[styles.input, { color: p.text }]} value={question} onChangeText={setQuestion} placeholder={en ? "Ask NAVIA…" : "Запитайте NAVIA…"} placeholderTextColor={p.subtle} returnKeyType="send" onSubmitEditing={() => void send()} /><Pressable style={[styles.sendButton, { backgroundColor: p.accent }]} onPress={() => void send()}><Text style={[styles.sendText, { color: p.accentText }]}>{busy ? "···" : "↑"}</Text></Pressable></View>
    </View>
  );
}

function makeStyles(_p: ReturnType<typeof useAppSettings>["palette"]) {
  return StyleSheet.create({
    screen: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
    header: { flexDirection: "row", alignItems: "center", gap: 11, padding: 12, borderWidth: 1, borderRadius: 17 },
    avatar: { width: 40, height: 40, borderRadius: 14, alignItems: "center", justifyContent: "center" }, avatarText: { fontSize: 22, fontWeight: "900" },
    heading: { fontSize: 14, fontWeight: "800" }, caption: { fontSize: 10, marginTop: 3 },
    notice: { marginTop: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 }, noticeText: { fontSize: 10, lineHeight: 15 },
    list: { flex: 1, marginTop: 8 }, messageList: { paddingVertical: 8, gap: 10 },
    bubble: { maxWidth: "88%", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 16, borderWidth: 1 }, userBubble: { alignSelf: "flex-end", borderBottomRightRadius: 5 }, assistantBubble: { alignSelf: "flex-start", borderBottomLeftRadius: 5 }, messageText: { fontSize: 13, lineHeight: 19 },
    prompts: { gap: 7, paddingVertical: 8 }, prompt: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 8 }, promptText: { fontSize: 10, fontWeight: "600" },
    composer: { minHeight: 52, borderWidth: 1, borderRadius: 16, paddingLeft: 13, paddingRight: 6, flexDirection: "row", alignItems: "center" }, input: { flex: 1, minWidth: 0, fontSize: 14, paddingVertical: 11 }, sendButton: { width: 39, height: 39, borderRadius: 13, alignItems: "center", justifyContent: "center" }, sendText: { fontSize: 21, fontWeight: "800" },
  });
}
