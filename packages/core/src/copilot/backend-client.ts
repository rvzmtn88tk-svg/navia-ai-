// LLMClient that talks to the NAVIA AI backend (apps/ai-backend) over HTTPS.
// This is what the mobile app uses: the provider API key lives only on the
// backend (spec section 39), and the backend attaches the system prompt and
// tool schemas itself.

import { COPILOT_PROTOCOL_VERSION, LLMUnavailableError, type CompletionRequest, type CompletionResponse, type LLMClient } from "./protocol";
import type { FetchLike } from "../place-search";

export type BackendLLMClientOptions = {
  baseUrl: string;
  /** Optional app token the backend can require (identifies the app build; not a secret). */
  clientToken?: string | null;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class BackendLLMClient implements LLMClient {
  private fetchImpl: FetchLike;

  constructor(private options: BackendLLMClientOptions) {
    const f = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("BackendLLMClient: no fetch implementation available");
    this.fetchImpl = f;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000) : null;
    const onAbort = () => controller?.abort();
    signal?.addEventListener?.("abort", onAbort);
    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/v1/copilot/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.options.clientToken ? { Authorization: `Bearer ${this.options.clientToken}` } : {}),
          },
          body: JSON.stringify({ ...request, protocolVersion: request.protocolVersion || COPILOT_PROTOCOL_VERSION }),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (e) {
        throw new LLMUnavailableError(`AI backend unreachable: ${(e as Error).message}`, true);
      }
      const json = (await response.json().catch(() => null)) as (CompletionResponse & { error?: string }) | null;
      if (!response.ok || !json || json.error) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new LLMUnavailableError(`AI backend error ${response.status}${json?.error ? `: ${json.error}` : ""}`, retryable);
      }
      if (!Array.isArray(json.content)) throw new LLMUnavailableError("AI backend returned a malformed response", false);
      return json;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }
}
