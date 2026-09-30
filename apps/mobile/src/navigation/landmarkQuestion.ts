// NAVIA asks about a landmark itself when the position is uncertain ("Бачите
// праворуч АЗС «WOG»?"): a "yes" places the car next to it. Asked only while
// dead reckoning with a wide error, about a named, visible landmark just
// ahead, never the same one twice, at most once a minute, and not right
// before a maneuver (the driver is busy then).
import { landmarkForms, type RouteLandmark } from "./landmarks";

export type LandmarkAskInput = {
  positionMode: string | null | undefined;
  uncertaintyM: number | null | undefined;
  progressM: number;
  speedMps: number | null;
  nextManeuverInM: number | null | undefined;
  landmarks: readonly RouteLandmark[];
  asked: ReadonlySet<string>;
  lastAskedAtMs: number;
  nowMs: number;
};

export function pickLandmarkQuestion(i: LandmarkAskInput): RouteLandmark | null {
  if (i.positionMode !== "DEAD_RECKONING") return null;
  const sigma = i.uncertaintyM ?? 0;
  if (sigma < 120) return null;
  if (i.nowMs - i.lastAskedAtMs < 60_000) return null;
  const v = Math.max(3, i.speedMps ?? 0);
  if (i.nextManeuverInM != null && i.nextManeuverInM / v < 20) return null;
  let best: RouteLandmark | null = null;
  for (const l of i.landmarks) {
    if (i.asked.has(l.id) || !l.name || l.side === "on" || l.offsetM > 40) continue;
    const ahead = l.alongM - i.progressM;
    // Somewhere the car can reach soon, given where it may really be.
    if (ahead < -0.5 * sigma || ahead > sigma + 400) continue;
    if (!best || Math.abs(ahead - 100) < Math.abs(best.alongM - i.progressM - 100)) best = l;
  }
  return best;
}

export function landmarkQuestionText(l: RouteLandmark, lang: "uk" | "en"): string {
  const f = landmarkForms(l);
  if (lang === "en") return `Do you see ${f.en} on your ${l.side}? Say yes or no.`;
  return `Бачите ${l.side === "right" ? "праворуч" : "ліворуч"} ${f.acc}? Скажіть «так» або «ні».`;
}
