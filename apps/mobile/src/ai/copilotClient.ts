// Co-pilot client. Uses the Claude-backed server function when it is
// configured and the user is signed in; otherwise answers on-device from the
// same structured state (and says so in the UI).
import { config } from "../config";
import type { CopilotState } from "./copilotState";

export type CopilotTurn = { role: "user" | "assistant"; text: string };
export type CopilotAnswer = { answer: string; source: "claude" | "local" | "refusal" };

type TokenProvider = () => Promise<string | null>;
let idTokenProvider: TokenProvider | null = null;

/** Registered by the sign-in module once Firebase Auth is connected. */
export function setCopilotTokenProvider(provider: TokenProvider | null): void {
  idTokenProvider = provider;
}

export function remoteCopilotAvailable(): boolean {
  return !!config.aiBackendUrl && !!idTokenProvider;
}

/** Calls the `copilot` callable function (Firebase callable HTTP protocol). */
export async function askRemote(question: string, state: CopilotState, history: CopilotTurn[]): Promise<CopilotAnswer> {
  const token = await idTokenProvider?.();
  if (!config.aiBackendUrl || !token) throw new Error("copilot: not signed in or backend not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(config.aiBackendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { question, state, history: history.slice(-6) } }),
      signal: controller.signal,
    });
    const body = await response.json() as { result?: CopilotAnswer; error?: { message?: string } };
    if (!response.ok || !body.result) throw new Error(body.error?.message ?? `copilot HTTP ${response.status}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** The server's language model says only WHAT is asked (one intent word);
 * the answer is then built on the phone from its own live state. */
export async function classifyRemote(question: string, timeoutMs = 4000): Promise<string | null> {
  const token = await idTokenProvider?.();
  if (!config.aiBackendUrl || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.aiBackendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { question, mode: "intent" } }),
      signal: controller.signal,
    });
    const body = await response.json() as { result?: { intent?: string } };
    return response.ok ? body.result?.intent ?? null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Why the server's language model can or cannot be used now. */
export function backendStatus(): { configured: boolean; signedIn: boolean } {
  return { configured: !!config.aiBackendUrl, signedIn: !!idTokenProvider };
}

/** One call to the co-pilot function (Firebase callable protocol). Throws on any failure. */
export async function callBackend<T>(data: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const token = await idTokenProvider?.();
  if (!config.aiBackendUrl) throw new Error("not configured");
  if (!token) throw new Error("not signed in");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.aiBackendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
      signal: controller.signal,
    });
    const body = await response.json() as { result?: T; error?: { message?: string } };
    if (!response.ok || !body.result) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}
