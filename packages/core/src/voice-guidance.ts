// VoiceGuidance — what the navigator says, and when, derived only from
// NavigationState. Platform-independent (the app just speaks the cues) and
// honest about position quality:
//   guidance "exact"       → "Через 400 метрів праворуч, на вул. Х."
//   guidance "approximate" → "Приблизно через 400 метрів праворуч… Звірте з табличкою."
//   guidance "none"        → no distances from a guess; the maneuver itself
//                            (from the route) once, plus "точна геопозиція
//                            тимчасово недоступна".
// Location-state changes (GPS lost, spoofed, restored) are announced once per
// episode, never on every tick.

import type { NavigationState, RouteStep } from "./types";

export type GuidanceCue = { kind: "maneuver" | "status" | "arrival"; text: string };

export type VoiceGuidanceOptions = {
  /** Announcement distances before a maneuver, metres (largest first). */
  thresholdsM?: number[];
  /** Extra early announcement at highway speed (> 20 m/s). */
  highwayThresholdM?: number;
};

function maneuverPhrase(m: RouteStep["maneuver"]): string {
  switch (m) {
    case "left": return "ліворуч";
    case "right": return "праворуч";
    case "uturn": return "розворот";
    case "roundabout": return "на круговий рух";
    case "arrive": return "прибуття";
    case "depart": return "рушайте";
    default: return "прямо";
  }
}

export function spokenDistance(m: number): string {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    return `${String(km).replace(".", ",")} кілометра`;
  }
  const r = m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
  return `${r} метрів`;
}

type Policy = "exact" | "approximate" | "none";

function policyOf(state: NavigationState): Policy {
  if (state.positioning) return state.positioning.guidance;
  // Classic/demo pipeline: derive from the confidence band.
  if (state.confidenceBand === "HIGH" || state.confidenceBand === "MEDIUM") return "exact";
  if (state.confidenceBand === "LOW") return "approximate";
  return "none";
}

type StatusKey = "ok" | "lost" | "spoofed" | "unstable" | "no_position";

export class VoiceGuidance {
  private thresholds: number[];
  private highway: number;
  private stepId: string | null = null;
  private spokenThresholds = new Set<number>();
  private spokenNoPositionForStep = false;
  private hintGivenForStep = false;
  private status: StatusKey = "ok";
  private arrivedSpoken = false;

  constructor(options: VoiceGuidanceOptions = {}) {
    this.thresholds = options.thresholdsM ?? [400, 150, 30];
    this.highway = options.highwayThresholdM ?? 1000;
  }

  reset(): void {
    this.stepId = null;
    this.spokenThresholds.clear();
    this.status = "ok";
    this.arrivedSpoken = false;
  }

  update(state: NavigationState): GuidanceCue[] {
    const cues: GuidanceCue[] = [];
    const policy = policyOf(state);

    // --- location-state announcements, once per episode ---
    const p = state.positioning;
    let key: StatusKey = "ok";
    if (p?.locationState === "SPOOFED") key = "spoofed";
    else if (policy === "none" && state.mode !== "IDLE") key = "no_position";
    else if (p?.locationState === "LOST") key = "lost";
    else if (p?.locationState === "UNSTABLE") key = "unstable";
    if (key !== this.status) {
      const text = this.statusText(key, this.status, p?.imuAvailable ?? false);
      this.status = key;
      if (text) cues.push({ kind: "status", text });
    }

    if (state.mode === "ARRIVED") {
      if (!this.arrivedSpoken) { this.arrivedSpoken = true; cues.push({ kind: "arrival", text: "Ви прибули до місця призначення." }); }
      return cues;
    }
    this.arrivedSpoken = false;

    // --- maneuver announcements ---
    const step = state.nextStep;
    if (!step) return cues;
    if (step.id !== this.stepId) {
      this.stepId = step.id;
      this.spokenThresholds.clear();
      this.spokenNoPositionForStep = false;
      this.hintGivenForStep = false;
    }
    const road = step.roadName ? `, на ${step.roadName}` : "";
    const what = step.maneuver === "arrive" ? "місце призначення" : maneuverPhrase(step.maneuver);

    if (policy === "none") {
      if (!this.spokenNoPositionForStep) {
        this.spokenNoPositionForStep = true;
        cues.push({ kind: "maneuver", text: `Наступний маневр за маршрутом: ${what}${road}. Відстань до нього зараз не можу визначити точно — орієнтуйтеся на дорожні знаки.` });
      }
      return cues;
    }

    const d = state.nextManeuverDistanceM;
    if (d == null) return cues;
    const thresholds = (state.speedMps ?? 0) > 20 ? [this.highway, ...this.thresholds] : this.thresholds;
    // A new maneuver that is still far away: say what comes next, once.
    if (this.spokenThresholds.size === 0 && d > Math.max(...thresholds) + 100 && step.maneuver !== "arrive") {
      this.spokenThresholds.add(Infinity);
      const approx = policy === "exact" ? "" : "приблизно ";
      cues.push({ kind: "maneuver", text: `Далі ${approx}через ${spokenDistance(d)} ${what}${road}.` });
      return cues;
    }
    // The largest threshold we're already inside that hasn't been spoken.
    const due = thresholds.filter((th) => d <= th && !this.spokenThresholds.has(th));
    if (due.length === 0) return cues;
    for (const th of due) this.spokenThresholds.add(th);
    const nearest = Math.min(...due);
    const closeNow = nearest <= 30 && d <= 40;
    let text: string;
    if (policy === "exact") {
      text = closeNow ? `Зараз ${what}${road}.` : `Через ${spokenDistance(d)} ${what}${road}.`;
    } else {
      text = closeNow ? `Орієнтовно зараз ${what}${road}.` : `Приблизно через ${spokenDistance(d)} ${what}${road}.`;
      if (!this.hintGivenForStep) { this.hintGivenForStep = true; text += " Звірте з табличкою чи орієнтиром."; }
    }
    cues.push({ kind: "maneuver", text });
    return cues;
  }

  private statusText(key: StatusKey, prev: StatusKey, imu: boolean): string | null {
    switch (key) {
      case "spoofed": return "Увага: сигнал GPS схожий на підробку. Ігнорую його і веду за картою та датчиками руху.";
      case "lost": return `GPS зник. Продовжую вести за картою${imu ? " та датчиками руху" : ""}, точність поступово знижується.`;
      case "unstable": return "GPS нестабільний, точність позиції знижена.";
      case "no_position": return "Точна геопозиція тимчасово недоступна. Продовжую відстежувати сигнал — орієнтуйтеся на дорожні знаки.";
      case "ok": return prev === "lost" || prev === "spoofed" || prev === "no_position" ? "GPS відновлено." : null;
    }
  }
}
