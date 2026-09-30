// Transport-independent request handling for POST /v1/copilot/complete.
// Validates that the body is a well-formed co-pilot conversation (and
// nothing else — no custom system prompt, no images/documents, bounded
// size) before spending provider tokens on it.

import { COPILOT_PROTOCOL_VERSION, COPILOT_TOOLS, LLMUnavailableError, type CompletionRequest, type LLMClient } from "@navia/core";

export const LIMITS = {
  maxBodyBytes: 256 * 1024,
  maxMessages: 80,
  maxTextChars: 12_000,
  maxToolResultChars: 24_000,
};

const TOOL_NAMES = new Set(COPILOT_TOOLS.map((t) => t.name));
/** Block types a co-pilot conversation can legitimately contain. */
const ALLOWED_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking", "fallback"]);

export type HandlerResult = { status: number; body: Record<string, unknown> };

export function validateCompletionRequest(body: unknown): { ok: true; request: CompletionRequest } | { ok: false; error: string; status: number } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.protocolVersion !== COPILOT_PROTOCOL_VERSION) {
    return { ok: false, status: 409, error: `protocol version mismatch: backend speaks ${COPILOT_PROTOCOL_VERSION}, app sent ${String(b.protocolVersion)}` };
  }
  if (b.tier !== "fast" && b.tier !== "smart") return { ok: false, status: 400, error: "tier must be fast or smart" };
  if (!Array.isArray(b.messages) || b.messages.length === 0) return { ok: false, status: 400, error: "messages must be a non-empty array" };
  if (b.messages.length > LIMITS.maxMessages) return { ok: false, status: 413, error: "too many messages" };
  const extraKeys = Object.keys(b).filter((k) => !["protocolVersion", "tier", "messages"].includes(k));
  if (extraKeys.length > 0) return { ok: false, status: 400, error: `unexpected fields: ${extraKeys.join(", ")}` };

  for (const [i, m] of (b.messages as unknown[]).entries()) {
    if (!m || typeof m !== "object") return { ok: false, status: 400, error: `messages[${i}] is not an object` };
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user" && msg.role !== "assistant") return { ok: false, status: 400, error: `messages[${i}].role must be user or assistant` };
    if (i === 0 && msg.role !== "user") return { ok: false, status: 400, error: "first message must be from the user" };
    if (typeof msg.content === "string") {
      if (msg.content.length > LIMITS.maxTextChars) return { ok: false, status: 413, error: `messages[${i}] text too long` };
      continue;
    }
    if (!Array.isArray(msg.content)) return { ok: false, status: 400, error: `messages[${i}].content must be a string or array` };
    for (const [j, blk] of msg.content.entries()) {
      const block = blk as Record<string, unknown> | null;
      const where = `messages[${i}].content[${j}]`;
      if (!block || typeof block.type !== "string" || !ALLOWED_BLOCKS.has(block.type)) {
        return { ok: false, status: 400, error: `${where}: block type not allowed` };
      }
      if (block.type === "text" && (typeof block.text !== "string" || block.text.length > LIMITS.maxTextChars)) {
        return { ok: false, status: 400, error: `${where}: invalid text block` };
      }
      if (block.type === "tool_use" && (msg.role !== "assistant" || typeof block.name !== "string" || !TOOL_NAMES.has(block.name))) {
        return { ok: false, status: 400, error: `${where}: unknown tool or misplaced tool_use` };
      }
      if (block.type === "tool_result") {
        if (msg.role !== "user" || typeof block.tool_use_id !== "string") return { ok: false, status: 400, error: `${where}: invalid tool_result` };
        if (typeof block.content !== "string" || block.content.length > LIMITS.maxToolResultChars) {
          return { ok: false, status: 400, error: `${where}: tool_result content must be a string within limits` };
        }
      }
      if ((block.type === "thinking" || block.type === "redacted_thinking" || block.type === "fallback") && msg.role !== "assistant") {
        return { ok: false, status: 400, error: `${where}: ${block.type} only allowed in assistant messages` };
      }
    }
  }
  return { ok: true, request: { protocolVersion: COPILOT_PROTOCOL_VERSION, tier: b.tier, messages: b.messages as CompletionRequest["messages"] } };
}

export async function handleCompletion(
  body: unknown,
  authorization: string | undefined,
  deps: { llm: LLMClient; clientToken: string | null; signal?: AbortSignal },
): Promise<HandlerResult> {
  if (deps.clientToken && authorization !== `Bearer ${deps.clientToken}`) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const v = validateCompletionRequest(body);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  try {
    const response = await deps.llm.complete(v.request, deps.signal);
    return { status: 200, body: response as unknown as Record<string, unknown> };
  } catch (e) {
    if (e instanceof LLMUnavailableError) {
      return { status: e.retryable ? 503 : 502, body: { error: e.message } };
    }
    return { status: 500, body: { error: "internal error" } };
  }
}

/** Fixed-window per-key request limiter (in-memory; use a shared store when running several instances). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private perMinute: number) {}

  allow(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.windows.clear();
      return true;
    }
    w.count++;
    return w.count <= this.perMinute;
  }
}
