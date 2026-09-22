// AIEngine — spec section 16 ("AI SHUTTLEMAN / NAVIA AI") + section 39
// ("AI PROVIDER").
//
// "AI is a conversational interface over structured navigation data...
// LLM must never receive a raw prompt saying 'guess where the user is'. It
// receives structured facts." The getters below are that structured-facts
// API: each is a pure function of NavigationContext, returning only data
// that's actually present in the context — never a guess. System policy
// (never invent coordinates/roads/POIs, never claim GPS is healthy without
// data, never claim a landmark confirmed without evidence, say so when
// confidence is low or an interpretation is ambiguous) is enforced by
// construction: DeterministicDemoAIProvider below can only say what the
// getters hand it.

import type {
  NavigationState,
  Landmark,
  RouteStep,
  PositionEstimate,
  LatLon,
  NavigationEvent,
  GNSSIntegrityState,
  ConfidenceBand,
} from "./types";
import type { Route } from "./route-engine";
import type { POI } from "./landmark-engine";
import { LandmarkEngine } from "./landmark-engine";

export type NavigationContext = {
  state: NavigationState;
  route: Route | null;
  nearbyLandmarks: Landmark[];
  nearbyPOI: POI[];
  recentEvents: NavigationEvent[];
};

// --- Tool getters (spec section 16's list, verbatim names) ---

export const AIEngine = {
  getNavigationState(ctx: NavigationContext): NavigationState["mode"] {
    return ctx.state.mode;
  },
  getPositionConfidence(ctx: NavigationContext): { confidence: number; band: ConfidenceBand } {
    return { confidence: ctx.state.confidence, band: ctx.state.confidenceBand };
  },
  getGNSSState(ctx: NavigationContext): GNSSIntegrityState {
    return ctx.state.gnss;
  },
  getNextTurn(ctx: NavigationContext): RouteStep | null {
    return ctx.state.nextStep;
  },
  getRouteProgress(ctx: NavigationContext): { distanceCompletedM: number | null; distanceRemainingM: number; etaSeconds: number | null } {
    const totalDistance = ctx.route?.distanceM ?? null;
    return {
      distanceCompletedM: totalDistance != null ? totalDistance - ctx.state.routeRemainingM : null,
      distanceRemainingM: ctx.state.routeRemainingM,
      etaSeconds:
        ctx.state.speedMps && ctx.state.speedMps > 0.5
          ? ctx.state.routeRemainingM / ctx.state.speedMps
          : null,
    };
  },
  getNearbyLandmarks(ctx: NavigationContext): Landmark[] {
    return ctx.state.nearbyLandmarks;
  },
  searchNearbyPOI(ctx: NavigationContext, query: string): POI[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return ctx.nearbyPOI.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.brand?.toLowerCase().includes(q) ?? false) || p.category.includes(q)
    );
  },
  getCurrentRoad(ctx: NavigationContext): string | null {
    // NavigationState only carries the *next* maneuver's road (per the
    // canonical type in section 5); "current road" is best approximated by
    // the road the upcoming maneuver is on, since we have no separately
    // cached "current step" on the state object. If there's no next step
    // (e.g. IDLE, or arrived), there's honestly no current-road fact to give.
    return ctx.state.nextStep?.roadName ?? null;
  },
  getDestination(ctx: NavigationContext): LatLon | null {
    const geometry = ctx.route?.geometry;
    return geometry && geometry.length > 0 ? geometry[geometry.length - 1]! : null;
  },
  getOffRouteStatus(ctx: NavigationContext): boolean {
    return ctx.state.offRoute;
  },
  getLastTrustedPosition(ctx: NavigationContext): PositionEstimate | null {
    return ctx.state.trustedPosition;
  },
};

// --- AI provider abstraction (section 39) ---

export interface AIProvider {
  answer(context: NavigationContext, userText: string): Promise<string>;
}

const CONFIDENCE_PHRASE: Record<ConfidenceBand, string> = {
  HIGH: "Позиція підтверджена",
  MEDIUM: "Позиція уточнюється",
  LOW: "Позиція неточна",
  UNKNOWN: "Не можу надійно визначити позицію",
};

function maneuverPhrase(m: RouteStep["maneuver"]): string {
  switch (m) {
    case "left": return "ліворуч";
    case "right": return "праворуч";
    case "uturn": return "розворот";
    case "roundabout": return "круговий рух";
    case "arrive": return "прибуття до пункту призначення";
    case "depart": return "рушайте";
    case "straight": return "прямо";
  }
}

/**
 * The app's default AI, per spec section 39: "The app must run without an
 * API key using deterministic AI." Answers are built only from AIEngine's
 * structured getters — no model call, no invented facts, honest about low
 * confidence and ambiguity.
 */
export class DeterministicDemoAIProvider implements AIProvider {
  private landmarkEngine = new LandmarkEngine();

  async answer(context: NavigationContext, userText: string): Promise<string> {
    const text = userText.trim().toLowerCase();

    if (/де я|позиці|position|where am i|місцезнаходж/.test(text)) {
      return this.describePosition(context);
    }
    if (/поворот|куди|next turn|маневр|turn|що далі|what.?s next|далі\b/.test(text)) {
      return this.describeNextTurn(context);
    }
    if (/скільки залиш|route progress|прогрес|скільки їхати/.test(text)) {
      return this.describeProgress(context);
    }
    if (/gnss|gps|сигнал/.test(text)) {
      return this.describeGnss(context);
    }

    // Otherwise, treat it as a potential landmark-identification query
    // ("Я бачу WOG. Це моя заправка?") — try to extract a brand/POI name
    // token and ask LandmarkEngine, which itself never guesses.
    const landmarkAnswer = this.tryLandmarkQuery(context, userText);
    if (landmarkAnswer) return landmarkAnswer;

    return "Я можу розповісти про вашу позицію, GNSS, прогрес маршруту, наступний поворот або найближчі орієнтири поблизу.";
  }

  private describePosition(context: NavigationContext): string {
    const { band } = AIEngine.getPositionConfidence(context);
    const gnss = AIEngine.getGNSSState(context);
    const road = AIEngine.getCurrentRoad(context);
    const base = CONFIDENCE_PHRASE[band];
    if (gnss === "LOST") {
      return `${base}. GNSS-сигнал зараз втрачено, тому я не можу підтвердити точну позицію на карті.`;
    }
    if (road) {
      return `${base}${band === "HIGH" || band === "MEDIUM" ? `. Ви орієнтовно на ${road}` : ""}.`;
    }
    return base + ".";
  }

  private describeNextTurn(context: NavigationContext): string {
    const step = AIEngine.getNextTurn(context);
    if (!step) return "Наразі немає активного маршруту з наступним поворотом.";
    const { band } = AIEngine.getPositionConfidence(context);
    // Policy: "if confidence is low, say so" — and don't hand out a precise
    // distance figure when the position it's measured from isn't trustworthy.
    if (band === "LOW" || band === "UNKNOWN") {
      return `Я не можу впевнено назвати точну відстань до наступного повороту, бо позиція зараз неточна. Орієнтовно: ${maneuverPhrase(step.maneuver)} на ${step.roadName}.`;
    }
    return `Наступний маневр — ${maneuverPhrase(step.maneuver)} на ${step.roadName}, за ${Math.round(step.distanceM)} м.`;
  }

  private describeProgress(context: NavigationContext): string {
    const progress = AIEngine.getRouteProgress(context);
    if (progress.distanceRemainingM <= 0 && context.route == null) {
      return "Маршрут ще не побудовано.";
    }
    const eta = progress.etaSeconds != null ? `${Math.round(progress.etaSeconds / 60)} хв` : "невідомо (немає стабільної швидкості)";
    return `Залишилося приблизно ${Math.round(progress.distanceRemainingM)} м, орієнтовний час прибуття — ${eta}.`;
  }

  private describeGnss(context: NavigationContext): string {
    const gnss = AIEngine.getGNSSState(context);
    const { band } = AIEngine.getPositionConfidence(context);
    if (gnss === "NORMAL") return "GNSS-сигнал у нормі.";
    if (gnss === "DEGRADED") return `GNSS-сигнал ослаблений. ${CONFIDENCE_PHRASE[band]}.`;
    return `GNSS-сигнал втрачено. ${CONFIDENCE_PHRASE[band]}. Я не можу стверджувати, що GPS справний, поки немає даних.`;
  }

  private tryLandmarkQuery(context: NavigationContext, userText: string): string | null {
    const position = AIEngine.getLastTrustedPosition(context)?.position ?? null;
    if (!context.route || !position || context.nearbyPOI.length === 0) return null;

    // Look for any known POI name/brand mentioned in the user's text.
    const mentioned = context.nearbyPOI.find(
      (p) =>
        userText.toLowerCase().includes(p.name.toLowerCase()) ||
        (p.brand && userText.toLowerCase().includes(p.brand.toLowerCase()))
    );
    if (!mentioned) return null;

    const result = this.landmarkEngine.identifyLandmarkQuery(
      context.nearbyPOI,
      mentioned.brand ?? mentioned.name,
      context.route,
      position,
      context.state.speedMps
    );
    return result.message;
  }
}

/**
 * RemoteLLMProvider — the second provider spec section 39 names. Per its own
 * rules ("Remote LLM must be behind backend. Never put provider secret in
 * mobile code."), this class deliberately has no API key or HTTP call baked
 * in: it's a wiring point for a backend proxy endpoint the mobile app would
 * call, which this sandbox has no backend to stand up. Left as an honest
 * not-implemented stub — DeterministicDemoAIProvider is the production
 * default, per "the app must run without an API key."
 */
export class RemoteLLMProvider implements AIProvider {
  constructor(private backendEndpoint: string) {}

  async answer(_context: NavigationContext, _userText: string): Promise<string> {
    throw new Error(
      `RemoteLLMProvider is not implemented in this build. It is a wiring point for a ` +
      `backend endpoint (configured: "${this.backendEndpoint}") that would proxy to an LLM — ` +
      `no such backend exists in this sandbox, and per spec section 39 no provider secret may ` +
      `live in mobile code, so this cannot call a model directly. Use DeterministicDemoAIProvider.`
    );
  }
}
