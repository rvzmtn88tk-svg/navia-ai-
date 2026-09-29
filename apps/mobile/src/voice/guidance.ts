// Turn-by-turn phrasing and announcement timing. Pure functions (no React
// Native imports) so they are unit-tested.
import { ordinalExit, spokenDistance, type Lang } from "../i18n/format";
import { landmarkConfirmation, landmarkLead, type StepLandmark } from "../navigation/landmarks";

export type Maneuver =
  | "depart" | "straight" | "slight_left" | "slight_right" | "left" | "right" | "sharp_left" | "sharp_right"
  | "uturn" | "roundabout" | "exit_left" | "exit_right" | "merge" | "arrive";

export type StepLike = { id: string; maneuver: Maneuver; roadName: string; roundaboutExit?: number };
export type TravelMode = "car" | "walk";

const FEMININE_NOUNS: Record<string, string> = {
  "вулиця": "вулицю", "площа": "площу", "набережна": "набережну", "алея": "алею", "дорога": "дорогу", "траса": "трасу", "лінія": "лінію",
};

/** Puts a Ukrainian street name into the accusative after "на": "вулиця Хрещатик" → "вулицю Хрещатик". */
export function streetAccusative(name: string): string {
  const words = name.trim().split(/\s+/);
  const nounIndex = words.findIndex((w) => FEMININE_NOUNS[w.toLocaleLowerCase("uk-UA")]);
  if (nounIndex < 0) return name.trim();
  return words.map((w, i) => {
    if (i === nounIndex) {
      const lower = w.toLocaleLowerCase("uk-UA");
      const replaced = FEMININE_NOUNS[lower]!;
      return w[0] === w[0]?.toLocaleUpperCase("uk-UA") && w[0] !== w[0]?.toLocaleLowerCase("uk-UA") ? replaced[0]!.toLocaleUpperCase("uk-UA") + replaced.slice(1) : replaced;
    }
    // Adjectives agreeing with a feminine noun that precedes: "Велика Васильківська вулиця".
    if (i < nounIndex && /[ая]$/.test(w)) return w.replace(/а$/, "у").replace(/я$/, "ю");
    return w;
  }).join(" ");
}

function action(step: StepLike, lang: Lang): string {
  const uk = lang === "uk";
  switch (step.maneuver) {
    case "left": return uk ? "поверніть ліворуч" : "turn left";
    case "right": return uk ? "поверніть праворуч" : "turn right";
    case "slight_left": return uk ? "тримайтеся лівіше" : "keep left";
    case "slight_right": return uk ? "тримайтеся правіше" : "keep right";
    case "sharp_left": return uk ? "різко поверніть ліворуч" : "make a sharp left";
    case "sharp_right": return uk ? "різко поверніть праворуч" : "make a sharp right";
    case "uturn": return uk ? "розверніться" : "make a U-turn";
    case "exit_left": return uk ? "з’їжджайте ліворуч" : "take the exit on the left";
    case "exit_right": return uk ? "з’їжджайте праворуч" : "take the exit on the right";
    case "merge": return uk ? "продовжуйте рух" : "merge";
    case "roundabout":
      if (step.roundaboutExit) return uk ? `на круговому русі ${ordinalExit(step.roundaboutExit, lang)} з’їзд` : `at the roundabout, take the ${ordinalExit(step.roundaboutExit, lang)} exit`;
      return uk ? "проїдьте круговий рух" : "go through the roundabout";
    case "arrive": return uk ? "ви прибудете до місця призначення" : "you will arrive at your destination";
    case "depart": return uk ? "рушайте" : "start";
    case "straight": return uk ? "їдьте прямо" : "continue straight";
  }
}

function onto(step: StepLike, lang: Lang): string {
  if (!step.roadName || step.maneuver === "arrive" || step.maneuver === "roundabout") return "";
  return lang === "uk" ? ` на ${streetAccusative(step.roadName)}` : ` onto ${step.roadName}`;
}

/** Action and target road as separate words, for the co-pilot's own sentences. */
export function actionWords(step: StepLike, lang: Lang): { action: string; road?: string } {
  const road = step.roadName && step.maneuver !== "arrive" && step.maneuver !== "roundabout" ? (lang === "uk" ? streetAccusative(step.roadName) : step.roadName) : undefined;
  return { action: action(step, lang), ...(road ? { road } : {}) };
}

function capitalize(s: string): string {
  return s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s;
}

/** "Через 300 метрів, після АЗС «ОККО», поверніть праворуч на вулицю Шевченка." */
export function instructionPhrase(step: StepLike, distanceM: number | null, lang: Lang, cue?: StepLandmark | null): string {
  if (step.maneuver === "arrive" && (distanceM == null || distanceM < 30)) return lang === "uk" ? "Ви прибули." : "You have arrived.";
  const body = `${action(step, lang)}${onto(step, lang)}`;
  const lead = landmarkLead(cue, lang);
  const confirm = landmarkConfirmation(cue, lang);
  const tail = confirm ? ` ${confirm}` : "";
  if (distanceM == null) return lead ? `${capitalize(lead)} ${body}.${tail}` : `${capitalize(body)}.${tail}`;
  const head = lang === "uk" ? `Через ${spokenDistance(distanceM, lang)}` : `In ${spokenDistance(distanceM, lang)}`;
  if (!lead) return `${head} ${body}.${tail}`;
  // "на світлофорі" reads without commas; "після АЗС «ОККО»" is set off by them.
  const glued = /^(на світлофорі|at the traffic lights)$/.test(lead) ? ` ${lead} ` : `, ${lead}, `;
  return `${head}${glued}${body}.${tail}`;
}

/** Announcement stages by distance to the maneuver. */
export type Stage = "far" | "prepare" | "now";

export function stageFor(distanceM: number, mode: TravelMode): Stage | null {
  const [far, prepare, now] = mode === "walk" ? [200, 60, 15] : [1500, 400, 80];
  if (distanceM <= now) return "now";
  if (distanceM <= prepare) return "prepare";
  if (distanceM <= far) return "far";
  return null;
}

/**
 * Decides whether to speak for this step now. Each step is announced at most
 * once per stage, and never at a stage earlier than one already spoken, so GPS
 * jitter cannot repeat a prompt.
 */
export class GuidanceAnnouncer {
  private spoken = new Map<string, Stage>();
  private static order: Stage[] = ["far", "prepare", "now"];

  next(step: StepLike | null, distanceM: number | null, mode: TravelMode, lang: Lang, cue?: StepLandmark | null): string | null {
    if (!step || distanceM == null || !Number.isFinite(distanceM)) return null;
    const stage = stageFor(distanceM, mode);
    if (!stage) return null;
    const previous = this.spoken.get(step.id);
    if (previous && GuidanceAnnouncer.order.indexOf(stage) <= GuidanceAnnouncer.order.indexOf(previous)) return null;
    this.spoken.set(step.id, stage);
    // Landmarks are named from the "prepare" stage on, when they are in sight.
    return instructionPhrase(step, stage === "now" ? null : distanceM, lang, stage === "far" ? null : cue);
  }

  reset(): void {
    this.spoken.clear();
  }
}

/** Prompt used when the position is estimated (no GNSS): no exact distance,
 * the landmark carries the cue, and the driver is asked to confirm the turn. */
export function cautiousPhrase(step: StepLike, lang: Lang, cue?: StepLandmark | null): string {
  const uk = lang === "uk";
  if (step.maneuver === "arrive") {
    const lead = landmarkLead(cue, lang);
    return uk ? `Приготуйтеся: місце призначення попереду${lead ? `, ${lead}` : ""}.` : `Get ready: your destination is ahead${lead ? `, ${lead}` : ""}.`;
  }
  const lead = landmarkLead(cue, lang);
  const head = uk ? "Приготуйтеся: скоро" : "Get ready: soon";
  const confirm = landmarkConfirmation(cue, lang);
  const ask = uk ? "Коли повернете — натисніть «Поворот пройдено»." : "When you've turned, tap “I've turned”.";
  return `${head}${lead ? `, ${lead},` : ""} ${action(step, lang)}${onto(step, lang)}.${confirm ? ` ${confirm}` : ""} ${ask}`;
}

// Spoken GNSS status changes (unstable / lost / back) live in
// navigation/navigatorMode.ts, built from the engine state.

/** Spoken notice when an air alert starts or ends at the user's location. */
export function alertPhrase(active: boolean, scope: "district" | "city" | "region" | undefined, lang: Lang): string {
  const uk = lang === "uk";
  if (!active) return uk ? "Тривогу у вашому районі скасовано." : "The air alert for your area has ended.";
  const where = scope === "region" ? (uk ? "по всій області" : "across the oblast") : scope === "city" ? (uk ? "у місті" : "in the city") : (uk ? "у вашому районі" : "in your district");
  return uk ? `Увага! Повітряна тривога ${where}. Дотримуйтеся офіційних сигналів.` : `Attention! Air alert ${where}. Follow official signals.`;
}
