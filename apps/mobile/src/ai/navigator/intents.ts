// NAVIA navigator — LAYER 2: intent classifier.
// Maps a question (Ukrainian, Russian, English; typed or recognised speech)
// to one scenario. Matching is by word stems and word order independent
// phrases, so rephrasings of the same need land on the same scenario
// ("пропав сигнал, що робити" = "глушать GPS" = "no gps what now").
// Order matters: the most specific / most urgent scenario wins.
// Pure; unit-tested.
import { detectIntent, detectKind, fold } from "../copilotBrain";

export type NavigatorIntent =
  | "repeat"          // "повтори"
  | "emergency"       // injured, 112
  | "signalLost"      // GPS is gone / jammed — what now
  | "gpsStatus"       // what's with GPS
  | "onRoute"         // am I on the right road
  | "reroute"         // I left the route / rebuild
  | "routeNext"       // what next / how far to the turn
  | "eta"             // when do we arrive
  | "whereAmI"        // where am I / I'm lost
  | "shelter"         // nearest shelter
  | "alert"           // air alert status
  | "status"          // overall situation
  | "place"           // other place categories (fuel, pharmacy, resilience point…)
  | "classic"         // describe / navigate to / landmarks / greetings / help — the classic co-pilot
  | "unknown";

/** True when every word of some phrase starts a word of the text, in order
 * (stems < 4 letters must match whole words). */
function has(text: string, ...phrases: string[]): boolean {
  const words = text.split(" ");
  const hit = (w: string, s: string) => (s.length < 4 ? w === s : w.startsWith(s));
  return phrases.some((raw) => {
    const parts = fold(raw).split(" ").filter(Boolean);
    for (let i = 0; i + parts.length <= words.length; i++) if (parts.every((p, k) => hit(words[i + k]!, p))) return true;
    return false;
  });
}

/** Like `has`, but the words may be anywhere in the text ("сигнал ... пропав"). */
function hasAll(text: string, ...stems: string[]): boolean {
  const words = text.split(" ");
  return stems.every((s) => words.some((w) => (s.length < 4 ? w === s : w.startsWith(s))));
}

const SIGNAL = ["сигнал", "gps", "джипиес", "джипіес", "gnss", "навігац", "навигац", "супутник", "спутник", "signal"];
const GONE = ["пропа", "зник", "исчез", "нема", "нет", "втрат", "потер", "лост", "lost", "gone", "dropped", "died", "глуш", "заглуш", "jam"];

export function classify(question: string): NavigatorIntent {
  const f = fold(question);
  if (!f) return "unknown";
  if (/^(повтори|повтори будь ласка|повтори пожалуйста|ще раз|еще раз|що ти сказав|что ты сказал|не почув|не расслышал|не услышал|repeat|say again|say that again|again)( |$)/.test(f)) return "repeat";
  const classic = detectIntent(question);
  if (classic === "emergency") return "emergency";

  // Signal lost / jammed — the navigator's most important scenario.
  if (has(f, "без gps", "без сигнал", "без джипиес", "реб", "рэб", "глушат", "глушить", "заглуш", "jamming", "jammed", "no gps", "without gps", "no signal", "спуф", "spoof", "підміня", "подменя")
    || (SIGNAL.some((s) => has(f, s)) && GONE.some((g) => has(f, g)))
    || classic === "noGps") return "signalLost";
  if (classic === "gps" || has(f, "точніст", "точност", "accuracy")) return "gpsStatus";

  // Route questions before the generic "where am I".
  if (has(f, "правильно їду", "правильно еду", "правильно йду", "правильно иду", "правильн дорог", "правильн дороз", "правильн шлях", "правильн шлях", "правильн напрям", "та дорога", "туди їду", "туда еду", "не туди", "не туда", "right road", "right way", "on track", "on the route", "по маршрут", "за маршрут")) {
    if (has(f, "не туди", "не туда", "wrong")) return "reroute";
    return "onRoute";
  }
  if (has(f, "перебуд", "перестро", "перерах", "пересчит", "новий маршрут", "новый маршрут", "з їхав", "з'їхав", "зїхав", "съехал", "звернув не", "свернул не", "пропустив поворот", "пропустил поворот", "reroute", "recalculat", "missed the turn", "off route")) return "reroute";
  if (classic === "routeNext") return "routeNext";
  if (classic === "eta") return "eta";
  if (classic === "whereAmI" || classic === "lost") return "whereAmI";

  const kind = detectKind(question);
  if (kind === "shelter" || has(f, "ховат", "сховат", "прятат", "спрятат", "hide", "take cover")) return "shelter";
  if (classic === "alert") return "alert";
  if (kind) return "place";
  if (has(f, "статус", "обстановк", "ситуац", "що відбуває", "что происход", "як справи", "как дела", "що там", "что там", "status", "situation", "what s going on", "whats going on", "звіт", "отчет", "report")) return "status";
  if (classic !== "unknown") return "classic";
  // Loose fallbacks: a lone signal word, a lone "turn".
  if (hasAll(f, "поворот") || has(f, "turn")) return "routeNext";
  if (SIGNAL.some((s) => has(f, s))) return "gpsStatus";
  return "unknown";
}
