// "Understand" mode of the NAVIA co-pilot proxy: Claude reads the driver's
// question together with the phone's context snapshot (facts only) and
// returns WHAT is asked (one intent from the navigator's list), how sure it
// is, and a short proposed answer built only from those facts. The phone
// checks the proposed answer against its own snapshot before using it and
// otherwise answers from its own handler for that intent.
// Pure (no Firebase): shared by the Cloud Function and the evaluation script.
import type Anthropic from "@anthropic-ai/sdk";

/** Small and fast: the answer must start speaking within about a second. */
export const UNDERSTAND_MODEL = process.env.NAVIA_UNDERSTAND_MODEL || "claude-haiku-4-5-20251001";

export const UNDERSTAND_INTENTS = [
  "repeat", "explain", "emergency", "signalLost", "gpsStatus", "confidence", "onRoute", "reroute", "routeNext", "eta", "routeWhy",
  "whereAmI", "shelter", "shelterWhy", "alert", "status", "place", "offline", "emotion", "noData", "smalltalk", "unknown",
] as const;
export type UnderstandIntent = (typeof UNDERSTAND_INTENTS)[number];

// Frozen: byte-stable so it is served from the prompt cache.
export const UNDERSTAND_PROMPT = `Ти — модуль розуміння запитів штурмана NAVIA (навігатор для водіїв в Україні під час тривог і глушіння GPS). На вхід: питання людини (українською, російською, суржиком, англійською, з помилками, розмовно чи після розпізнавання голосу) і <facts> — поточні дані телефона.

Поверни ЛИШЕ JSON без пояснень: {"intent": "...", "confidence": 0.0-1.0, "answer": "..."}.

intent — один зі списку:
repeat — повторити попередню відповідь; explain — чому/на основі чого була попередня відповідь;
emergency — загроза життю, поранені, потрібна швидка, пожежа;
signalLost — GPS/супутники зникли, глушать, або «а якщо сигнал зникне»; gpsStatus — стан і точність GPS, чому позиція «стрибає»;
confidence — наскільки точно відома позиція, чи знає NAVIA, де людина;
onRoute — чи правильно їду; reroute — звернув не туди, пропустив поворот, перебудувати; routeNext — наступний поворот/маневр;
eta — скільки лишилось, коли приїдемо; routeWhy — чому саме цей маршрут, чи найкоротший;
whereAmI — де я, яка вулиця; shelter — укриття, куди ховатися; shelterWhy — чи це справді найближче укриття;
alert — повітряна тривога, обстріл; status — загальна обстановка; place — АЗС, аптека, банкомат, магазин, їжа, вода, лікарня, зарядка, пункт незламності;
offline — немає інтернету, що працює без мережі; emotion — страх, паніка, людині погано від нервів;
noData — пробки, погода, камери, поліція, ціни, новини, розваги (таких даних у NAVIA немає); smalltalk — привітання, подяка, «хто ти»; unknown — інше.

answer — 1–3 короткі речення мовою поля lang, ЛИШЕ з фактів <facts>: не вигадуй чисел, назв, вулиць, укриттів, стану GPS. Якщо потрібного факту немає — чесно скажи, чого немає. У кризі (тривога, втрата сигналу, страх) — коротко й спокійно, один конкретний наступний крок. Ніколи не обіцяй безпеку. NAVIA — «воно»: про себе безособово або в середньому роді, без «я могла/зробила/готова/впевнений».
confidence — оцінка того, наскільки правильно обрано intent.`;

/** Only these facts may be sent; everything else is dropped (and nothing identifies the user). */
const FACT_KEYS = [
  "lang", "gnssState", "gnssLastFixAgeMs", "positionSource", "positionConfidence", "positionConfidenceBand", "positionAccuracyM",
  "routeActive", "routeRemainingM", "etaMinutes", "nextManeuver", "offRoute", "reroutingInProgress", "alarmStatus",
  "nearbyShelters", "speedKmh", "networkOnline", "offlinePackageAvailable", "street", "area", "destination", "previousAnswer",
] as const;

export function sanitizeFacts(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  const clip = (v: unknown, depth = 0): unknown => {
    if (v == null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    if (typeof v === "string") return v.slice(0, 300);
    if (Array.isArray(v) && depth < 2) return v.slice(0, 5).map((x) => clip(x, depth + 1));
    if (typeof v === "object" && depth < 2) return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 8).map(([k, x]) => [k.slice(0, 40), clip(x, depth + 1)]));
    return null;
  };
  for (const k of FACT_KEYS) if (k in (raw as Record<string, unknown>)) out[k] = clip((raw as Record<string, unknown>)[k]);
  return out;
}

export function understandRequest(question: string, facts: Record<string, unknown>): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: UNDERSTAND_MODEL,
    max_tokens: 300,
    system: [{ type: "text", text: UNDERSTAND_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `<facts>${JSON.stringify(facts)}</facts>\n<question>${question.slice(0, 500)}</question>` }],
  };
}

export type Understood = { intent: UnderstandIntent; confidence: number; answer: string };

export function parseUnderstood(text: string): Understood {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const v = JSON.parse(json) as { intent?: unknown; confidence?: unknown; answer?: unknown };
    const intent = (UNDERSTAND_INTENTS as readonly string[]).includes(String(v.intent)) ? (v.intent as UnderstandIntent) : "unknown";
    const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? Math.max(0, Math.min(1, v.confidence)) : 0;
    return { intent, confidence, answer: typeof v.answer === "string" ? v.answer.slice(0, 600) : "" };
  } catch {
    return { intent: "unknown", confidence: 0, answer: "" };
  }
}

export async function understand(client: Anthropic, question: string, facts: unknown): Promise<Understood> {
  const response = await client.messages.create(understandRequest(question, sanitizeFacts(facts)));
  return parseUnderstood(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
}
