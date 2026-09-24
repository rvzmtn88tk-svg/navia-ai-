// On-device co-pilot answers, built only from NAVIA's own data. Used when the
// Claude-backed server is not available (no sign-in / no network).
import { DeterministicDemoAIProvider, type NavigationContext } from "@navia/core";
import type { CopilotState } from "./copilotState";
import { formatDistance } from "../i18n/format";

const deterministic = new DeterministicDemoAIProvider();

export async function answerLocally(question: string, s: CopilotState, context: NavigationContext): Promise<string> {
  const q = question.toLocaleLowerCase(s.lang === "en" ? "en-US" : "uk-UA");
  const uk = s.lang === "uk";
  if (/(gps|gnss|сигнал|точніст|signal)/i.test(q)) {
    if (s.gnss === "NORMAL") return uk ? "GPS стабільний, позиція підтверджена." : "GPS is stable and your position is confirmed.";
    if (s.gnss === "DEGRADED") return uk ? "GPS нестабільний. Точність знижена, NAVIA перевіряє позицію за картою." : "GPS is unstable. Accuracy is reduced; NAVIA is checking your position against the map.";
    return uk ? "GPS втрачено. Я не можу підтвердити вашу поточну позицію." : "GPS is lost. I can't confirm your current position.";
  }
  if (/(укрит|бомбосхов|незламн|shelter)/i.test(q)) {
    const nearest = (s.nearbyPlaces ?? []).filter((p) => p.category === "shelter" || p.category === "resilience").sort((a, b) => a.distanceM - b.distanceM)[0];
    if (nearest) return uk ? `Найближче в даних NAVIA: ${nearest.name}, приблизно ${formatDistance(nearest.distanceM, "uk")}. Доступність перевірте на місці.` : `Nearest listed: ${nearest.name}, about ${formatDistance(nearest.distanceM, "en")}. Check access on arrival.`;
    return uk ? "Поки немає даних про укриття поруч. Скористайтеся офіційною мапою укриттів." : "I don't have nearby shelter data yet. Use the official shelter map.";
  }
  if (/(заправ|азс|пальн|fuel|petrol)/i.test(q)) {
    const nearest = (s.nearbyPlaces ?? []).filter((p) => p.category === "fuel").sort((a, b) => a.distanceM - b.distanceM)[0];
    return nearest ? (uk ? `Найближча АЗС: ${nearest.name}, ${formatDistance(nearest.distanceM, "uk")}.` : `Nearest fuel: ${nearest.name}, ${formatDistance(nearest.distanceM, "en")}.`)
      : (uk ? "Поки немає даних про АЗС поруч." : "No nearby fuel data yet.");
  }
  if (/(тривог|alert)/i.test(q)) {
    if (!s.alert || s.alert.active == null) return uk ? "Статус тривоги зараз невідомий. Не вимикайте офіційні сповіщення." : "Alert status is unknown. Keep official alerts on.";
    return uk ? `${s.alert.active ? "Тривога" : "Тривоги немає"}${s.alert.area ? ` · ${s.alert.area}` : ""}. Це інформаційні дані — стежте за офіційними сповіщеннями.`
      : `${s.alert.active ? "Alert active" : "No alert"}${s.alert.area ? ` · ${s.alert.area}` : ""}. Informational only — follow official alerts.`;
  }
  if (uk) return deterministic.answer(context, question);
  if (/(next|turn|where)/i.test(q) && s.nextManeuver) {
    return s.confidence === "LOW" || s.confidence === "UNKNOWN"
      ? `Position is uncertain right now; the next maneuver is ${s.nextManeuver.maneuver}${s.nextManeuver.roadName ? ` onto ${s.nextManeuver.roadName}` : ""}.`
      : `In ${formatDistance(s.nextManeuver.distanceM ?? 0, "en")}, ${s.nextManeuver.maneuver}${s.nextManeuver.roadName ? ` onto ${s.nextManeuver.roadName}` : ""}.`;
  }
  return "I can answer about GPS, your route, alerts and places nearby.";
}
