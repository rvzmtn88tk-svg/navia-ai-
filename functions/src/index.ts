// NAVIA co-pilot proxy. The app sends a question plus a small, structured
// snapshot of navigation state (no coordinates); this function asks Claude
// for a short, driver-safe answer grounded only in that snapshot. The
// Anthropic key never leaves the server.
import Anthropic from "@anthropic-ai/sdk";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-opus-5";
/** Small and fast: the intent is one word. */
const INTENT_MODEL = "claude-haiku-4-5-20251001";
// Keeps a tester group inside the ~$20/month budget; tune in one place.
const DAILY_LIMIT_PER_USER = 40;
const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY_TURNS = 6;

// Frozen system prompt: kept byte-stable so it can be served from the cache.
const SYSTEM_PROMPT = `Ти — штурман NAVIA: спокійний, людяний помічник у навігаторі для водіїв і пішоходів в Україні під час повітряних тривог і глушіння GPS. Ти говориш з живою людиною, яка може хвилюватися або бути за кермом.

Відповідай лише на основі даних NAVIA з блоку <navia_state>. Це єдине джерело фактів про позицію, маршрут, GPS, тривоги, орієнтири й місця поруч.
- Не вигадуй вулиць, поворотів, відстаней, місць, укриттів чи стану GPS. Якщо потрібного факту немає, чесно скажи, що не можеш це перевірити, і що людина може зробити.
- Місця називай з відстанню та напрямком ("200 м на північний схід, близько 3 хв пішки"), якщо вони є в даних.
- Якщо "positionMode" = DEAD_RECKONING або GPS LOST: не називай точних метрів до повороту; опирайся на орієнтир ("routeCue", "landmarkAhead", "landmarkBehind") і нагадай натиснути «Я вже повернув» після повороту.
- Ніколи не стверджуй, що маршрут, місце чи укриття безпечні. Дані про тривоги лише інформаційні; коли йдеться про небезпеку, нагадуй про офіційні сповіщення.
- Не давай тактичних порад щодо повітряних загроз і не роби висновків про їхній напрямок.
- При загрозі життю першим реченням порадь телефонувати 112 або 103.
- Відповідай коротко: 1–3 речення, без списків і розмітки, простими словами, тепло й по суті.
- Мова відповіді — мова поля "lang" (uk — українська, en — англійська).
- NAVIA — «воно». Про себе говори в середньому роді або безособово: «готово допомогти», «показую маршрут», «веду за маршрутом». Ніколи не вживай жіночого чи чоловічого роду про себе («я могла», «я зробила», «я готова», «я впевнений»).`;

// Intent mode: Claude only recognises WHAT the driver asks; the app builds the
// answer from its own live state, so no fact comes from the model.
const INTENTS = ["repeat", "explain", "emergency", "signalLost", "gpsStatus", "onRoute", "reroute", "routeNext", "eta", "whereAmI", "shelter", "alert", "status", "place", "noData", "smalltalk", "unknown"] as const;
const INTENT_PROMPT = `Класифікуй питання водія до навігатора NAVIA. Відповідай ОДНИМ словом зі списку, без пояснень:
repeat — повторити попередню відповідь; explain — чому/на основі чого була відповідь; emergency — загроза життю, поранені, потрібна швидка;
signalLost — GPS/супутники зникли, глушать, або «а якщо сигнал зникне»; gpsStatus — стан, точність GPS; onRoute — чи правильно їду/чи на маршруті;
reroute — звернув не туди, пропустив поворот, перебудувати, «а якщо зіб'юсь»; routeNext — наступний поворот/маневр, куди далі, скільки до повороту;
eta — скільки лишилось їхати, коли приїдемо, відстань до кінця; whereAmI — де я, яка вулиця/район; shelter — укриття, куди ховатися;
alert — повітряна тривога, обстріл, загрози; status — загальна обстановка; place — АЗС, аптека, банкомат, магазин, їжа, вода, пункт незламності;
noData — пробки, погода, камери, поліція, новини, розваги (даних немає); smalltalk — привітання, подяка, розмова; unknown — інше.`;

type Place = { name: string; category: string; distanceM: number };
type CopilotState = {
  lang: "uk" | "en";
  gnss: "NORMAL" | "DEGRADED" | "LOST";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  currentRoad?: string;
  district?: string;
  destination?: string;
  nextManeuver?: { maneuver: string; distanceM: number | null; roadName?: string; roundaboutExit?: number };
  remainingM?: number;
  etaMin?: number;
  offRoute?: boolean;
  alert?: { active: boolean | null; area?: string; sinceTime?: string };
  regionSummary?: string;
  nearbyPlaces?: Place[];
  positionMode?: "GNSS" | "DEAD_RECKONING" | "MANUAL";
  uncertaintyM?: number;
  lastFixMinAgo?: number;
  street?: string;
  alertDetail?: { scope?: string; level?: string; reasons?: string[]; otherDistricts?: number };
  routeCue?: string;
  routeConfirm?: string;
  landmarkBehind?: string;
  landmarkAhead?: string;
  landmarkCount?: number;
  places?: { name: string; kind: string; distanceM: number; direction?: string; walkMin?: number }[];
};
type Turn = { role: "user" | "assistant"; text: string };

function str(v: unknown, max = 120): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

/** Whitelists fields; anything that looks like coordinates is simply not copied. */
export function sanitizeState(raw: unknown): CopilotState {
  const s = (raw ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const m = s.nextManeuver as Record<string, unknown> | undefined;
  const a = s.alert as Record<string, unknown> | undefined;
  return {
    lang: pick(s.lang, ["uk", "en"] as const, "uk"),
    gnss: pick(s.gnss, ["NORMAL", "DEGRADED", "LOST"] as const, "LOST"),
    confidence: pick(s.confidence, ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const, "UNKNOWN"),
    currentRoad: str(s.currentRoad),
    district: str(s.district),
    destination: str(s.destination),
    nextManeuver: m ? { maneuver: str(m.maneuver, 30) ?? "straight", distanceM: num(m.distanceM) ?? null, roadName: str(m.roadName), roundaboutExit: num(m.roundaboutExit) } : undefined,
    remainingM: num(s.remainingM),
    etaMin: num(s.etaMin),
    offRoute: typeof s.offRoute === "boolean" ? s.offRoute : undefined,
    alert: a ? { active: typeof a.active === "boolean" ? a.active : null, area: str(a.area), sinceTime: str(a.sinceTime, 5) } : undefined,
    regionSummary: str(s.regionSummary, 200),
    positionMode: s.positionMode === "GNSS" || s.positionMode === "DEAD_RECKONING" || s.positionMode === "MANUAL" ? s.positionMode : undefined,
    uncertaintyM: num(s.uncertaintyM),
    lastFixMinAgo: num(s.lastFixMinAgo),
    street: str(s.street),
    alertDetail: (() => {
      const d = s.alertDetail as Record<string, unknown> | undefined;
      if (!d) return undefined;
      return {
        scope: str(d.scope, 20), level: str(d.level, 20), otherDistricts: num(d.otherDistricts),
        reasons: Array.isArray(d.reasons) ? d.reasons.slice(0, 4).map((r) => str(r, 120)).filter((r): r is string => !!r) : undefined,
      };
    })(),
    routeCue: str(s.routeCue),
    routeConfirm: str(s.routeConfirm),
    landmarkBehind: str(s.landmarkBehind),
    landmarkAhead: str(s.landmarkAhead),
    landmarkCount: num(s.landmarkCount),
    places: Array.isArray(s.places)
      ? s.places.slice(0, 12).map((p) => p as Record<string, unknown>)
        .map((p) => ({ name: str(p.name) ?? "", kind: str(p.kind, 30) ?? "", distanceM: num(p.distanceM) ?? 0, direction: str(p.direction, 40), walkMin: num(p.walkMin) }))
        .filter((p) => p.name)
      : undefined,
    nearbyPlaces: Array.isArray(s.nearbyPlaces)
      ? s.nearbyPlaces.slice(0, 10).map((p) => p as Record<string, unknown>)
        .map((p) => ({ name: str(p.name) ?? "", category: str(p.category, 30) ?? "", distanceM: num(p.distanceM) ?? 0 }))
        .filter((p) => p.name)
      : undefined,
  };
}

async function consumeQuota(uid: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = getFirestore().doc(`copilotUsage/${uid}_${day}`);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = (snap.get("count") as number | undefined) ?? 0;
    if (used >= DAILY_LIMIT_PER_USER) return false;
    tx.set(ref, { count: FieldValue.increment(1), uid, day }, { merge: true });
    return true;
  });
}

export const copilot = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: "europe-central2", enforceAppCheck: false, timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to use the co-pilot.");
    const data = (request.data ?? {}) as { question?: unknown; state?: unknown; history?: unknown; mode?: unknown };
    const question = str(data.question, MAX_QUESTION_CHARS);
    if (!question) throw new HttpsError("invalid-argument", "question is required");
    if (!(await consumeQuota(request.auth.uid))) throw new HttpsError("resource-exhausted", "Daily co-pilot limit reached.");

    if (data.mode === "intent") {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      try {
        const response = await client.messages.create({
          model: INTENT_MODEL,
          max_tokens: 16,
          system: [{ type: "text", text: INTENT_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: question }],
        });
        const word = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim().split(/\s+/)[0] ?? "";
        const intent = (INTENTS as readonly string[]).includes(word) ? word : "unknown";
        return { intent, source: "claude" };
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "The co-pilot is busy. Try again shortly.");
        throw new HttpsError("unavailable", "Co-pilot intent service error.");
      }
    }

    const state = sanitizeState(data.state);
    const history: Turn[] = Array.isArray(data.history)
      ? data.history.slice(-MAX_HISTORY_TURNS).flatMap((t) => {
        const turn = t as Record<string, unknown>;
        const text = str(turn.text, MAX_QUESTION_CHARS);
        return (turn.role === "user" || turn.role === "assistant") && text ? [{ role: turn.role, text } as Turn] : [];
      })
      : [];

    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role, content: t.text })),
      { role: "user", content: `<navia_state>\n${JSON.stringify(state)}\n</navia_state>\n\n${question}` },
    ];
    // The API requires the first message to be from the user.
    while (messages.length > 1 && messages[0]?.role !== "user") messages.shift();

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 1024,
        betas: ["server-side-fallback-2026-07-01"],
        // Re-runs a declined request on Anthropic's recommended model for that refusal category.
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
      });
      if (response.stop_reason === "refusal") {
        return { answer: state.lang === "en" ? "I can't help with that." : "Я не можу з цим допомогти.", source: "refusal" };
      }
      const answer = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
      return { answer, source: "claude" };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "The co-pilot is busy. Try again shortly.");
      if (err instanceof Anthropic.APIError) throw new HttpsError("unavailable", `Co-pilot service error ${err.status ?? ""}`.trim());
      throw new HttpsError("internal", "Co-pilot failed.");
    }
  },
);
