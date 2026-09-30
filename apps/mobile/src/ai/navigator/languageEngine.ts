// NAVIA navigator — the language engine behind layer 2.
//   "llm":      the NAVIA server (EXPO_PUBLIC_NAVIA_AI_BACKEND_URL, signed in)
//               asks Claude what the question means (+ a proposed answer)
//               from the phone's facts; the key lives only on the server.
//   "fallback": the on-device rules (intents.ts + normalize.ts) — when the
//               server is not configured, the user is not signed in, or the
//               server does not answer in time.
// The active level and why is shown in Diagnostics.
import { backendStatus, callBackend } from "../copilotClient";
import { config } from "../../config";
import type { NavigatorIntent } from "./intents";
import type { Snapshot } from "./snapshot";

export type LanguageLevel = { mode: "llm" | "fallback"; reason: string };
export type RemoteUnderstanding = { intent: NavigatorIntent; confidence: number; answer: string; latencyMs: number };

const TIMEOUT_MS = 3000;
let lastError: string | null = null;
let lastOkAt: number | null = null;
let lastLatencyMs: number | null = null;

/** Anonymous per-install id for the proxy's rate limit (random, not tied to the user). */
let deviceId: string | null = null;
export function device(): string {
  if (deviceId) return deviceId;
  deviceId = `nv-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { getItemSync?(k: string): string | null; setItemSync?(k: string, v: string): void } }).default;
    const saved = kv.getItemSync?.("navia.device.v1");
    if (saved) deviceId = saved; else kv.setItemSync?.("navia.device.v1", deviceId);
  } catch { /* no storage: a session id */ }
  return deviceId;
}

async function callProxy(question: string, facts: Record<string, unknown>): Promise<{ intent?: string; confidence?: number; answer?: string; usedFacts?: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.aiProxyUrl!.replace(/\/$/, "")}/v1/understand`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-navia-app": config.aiAppToken ?? "", "x-navia-device": device() },
      body: JSON.stringify({ question, facts }),
      signal: controller.signal,
    });
    const body = await res.json() as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as { intent?: string; confidence?: number; answer?: string; usedFacts?: string[] };
  } finally {
    clearTimeout(timer);
  }
}

/** A language model can be asked at all (proxy configured, or the signed-in Firebase backend). */
export function remoteLanguageAvailable(): boolean {
  if (config.aiProxyUrl) return true;
  const b = backendStatus();
  return b.configured && b.signedIn;
}

export function languageLevel(): LanguageLevel {
  if (config.aiProxyUrl) {
    if (lastError && lastOkAt == null) return { mode: "fallback", reason: `сервер мовної моделі не відповідає: ${lastError}` };
    return { mode: "llm", reason: lastLatencyMs != null ? `проксі NAVIA, остання відповідь ${lastLatencyMs} мс` : "проксі NAVIA налаштовано" };
  }
  const b = backendStatus();
  if (!b.configured) return { mode: "fallback", reason: "сервер мовної моделі не налаштовано (EXPO_PUBLIC_NAVIA_AI_PROXY_URL)" };
  if (!b.signedIn) return { mode: "fallback", reason: "потрібен вхід в акаунт NAVIA" };
  if (lastError && (lastOkAt == null)) return { mode: "fallback", reason: `сервер не відповідає: ${lastError}` };
  return { mode: "llm", reason: lastLatencyMs != null ? `остання відповідь сервера ${lastLatencyMs} мс` : "сервер налаштовано" };
}

/** The facts the server may use — no coordinates, nothing that identifies the user. */
export function factsFor(s: Snapshot, previousAnswer: string | null): Record<string, unknown> {
  const f = s.fields;
  return {
    lang: s.lang, gnssState: f.gnssState, gnssLastFixAgeMs: f.gnssLastFixAgeMs, positionSource: f.positionSource,
    positionConfidence: f.positionConfidence, positionConfidenceBand: f.positionConfidenceBand, positionAccuracyM: f.positionAccuracyM,
    routeActive: f.routeActive, routeRemainingM: f.routeRemainingM, etaMinutes: s.route?.etaS != null ? Math.round(s.route.etaS / 60) : null,
    nextManeuver: s.route?.next ? { action: s.route.next.action, road: s.route.next.road, distanceM: s.route.next.distanceM } : null,
    offRoute: f.offRoute, reroutingInProgress: f.reroutingInProgress, alarmStatus: f.alarmStatus,
    nearbyShelters: f.nearbyShelters.slice(0, 3).map((p) => ({ name: p.label, distanceM: Math.round(p.distanceM) })),
    speedKmh: s.motion.speedKmh, networkOnline: f.networkOnline, offlinePackageAvailable: f.offlinePackageAvailable,
    street: s.position.street, area: s.position.area, destination: s.route?.destination ?? null, previousAnswer,
  };
}

type RemoteFn = (question: string, facts: Record<string, unknown>) => Promise<{ intent?: string; confidence?: number; answer?: string }>;
let testRemote: RemoteFn | null = null;
/** Tests: a stand-in for the server (null = the real one). */
export function setRemoteForTests(fn: RemoteFn | null): void {
  testRemote = fn;
}

/** Asks the server; null when it is not available (the caller falls back to the rules). */
export async function understandRemote(question: string, s: Snapshot, previousAnswer: string | null): Promise<RemoteUnderstanding | null> {
  if (testRemote) {
    try { const r = await testRemote(question, factsFor(s, previousAnswer)); return { intent: (r.intent ?? "unknown") as NavigatorIntent, confidence: r.confidence ?? 0, answer: r.answer ?? "", latencyMs: 0 }; } catch { return null; }
  }
  if (!config.aiProxyUrl && !(backendStatus().configured && backendStatus().signedIn)) return null;
  const t0 = Date.now();
  try {
    const facts = factsFor(s, previousAnswer);
    const r = config.aiProxyUrl ? await callProxy(question, facts) : await callBackend<{ intent?: string; confidence?: number; answer?: string }>({ question, mode: "understand", facts }, TIMEOUT_MS);
    lastLatencyMs = Date.now() - t0;
    lastOkAt = Date.now();
    lastError = null;
    return { intent: (r.intent ?? "unknown") as NavigatorIntent, confidence: r.confidence ?? 0, answer: r.answer ?? "", latencyMs: lastLatencyMs };
  } catch (e) {
    lastError = (e as Error).message;
    lastOkAt = null;
    return null;
  }
}
