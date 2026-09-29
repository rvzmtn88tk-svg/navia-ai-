// LLMClient for any provider exposing an OpenAI-compatible Chat Completions
// API with function calling (hosted or self-hosted gateways). It lets NAVIA
// switch model providers without touching the co-pilot: the loop, tools and
// prompt are the same; only this translation differs.
//
// Translation (NAVIA protocol = Anthropic-style content blocks):
//   system prompt            → {role:"system"}
//   tool schemas             → tools[{type:"function", function:{name, description, parameters}}]
//   assistant tool_use       → assistant.tool_calls[{id, function:{name, arguments(JSON)}}]
//   user tool_result blocks  → {role:"tool", tool_call_id, content}
//   thinking/opaque blocks   → dropped (provider-specific)
//   finish_reason            → stopReason (tool_calls→tool_use, stop→end_turn, length→max_tokens, content_filter→refusal)
//
// Prompt caching and the refusal fallback are Anthropic features; on this
// path they depend on the provider (cached_tokens is reported when given).

import {
  COPILOT_SYSTEM_PROMPT, COPILOT_TOOLS, LLMUnavailableError, isTextBlock, isToolUseBlock,
  type CompletionRequest, type CompletionResponse, type ContentBlock, type LLMClient, type CopilotMessage, type ToolResultBlock,
} from "@navia/core";

export type OpenAICompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  fastModel: string;
  smartModel: string;
  fastMaxTokens: number;
  smartMaxTokens: number;
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatResponse = {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

export function toChatMessages(messages: CopilotMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: COPILOT_SYSTEM_PROMPT }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content } as ChatMessage); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter(isTextBlock).map((b) => b.text).join("\n");
      const calls = m.content.filter(isToolUseBlock).map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user: tool results become tool messages (in order), text becomes one user message
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const r = b as ToolResultBlock;
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.is_error ? `ERROR: ${r.content}` : r.content });
      }
    }
    const text = m.content.filter(isTextBlock).map((b) => b.text).join("\n\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function fromChatResponse(res: ChatResponse): CompletionResponse {
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const content: ContentBlock[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try { const parsed = JSON.parse(c.function.arguments || "{}"); if (parsed && typeof parsed === "object") input = parsed; } catch { /* malformed arguments → empty input; the tool reports bad_request */ }
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const fr = choice?.finish_reason ?? "stop";
  const stopReason = fr === "tool_calls" || (msg.tool_calls?.length ?? 0) > 0 ? "tool_use" : fr === "length" ? "max_tokens" : fr === "content_filter" ? "refusal" : "end_turn";
  return {
    content, stopReason, model: res.model ?? "unknown",
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
}

export class OpenAICompatibleLLMClient implements LLMClient {
  constructor(private config: OpenAICompatibleConfig, private fetchImpl: typeof fetch = fetch) {}

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const smart = request.tier === "smart";
    return {
      model: smart ? this.config.smartModel : this.config.fastModel,
      max_tokens: smart ? this.config.smartMaxTokens : this.config.fastMaxTokens,
      messages: toChatMessages(request.messages),
      tools: COPILOT_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
    };
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(this.buildBody(request)),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new LLMUnavailableError(`LLM provider unreachable: ${(e as Error).message}`, true);
    }
    if (res.status === 401 || res.status === 403) throw new LLMUnavailableError("LLM provider credential rejected (check NAVIA_OPENAI_API_KEY on the backend)", false);
    if (res.status === 429) throw new LLMUnavailableError("LLM rate limited", true);
    if (!res.ok) throw new LLMUnavailableError(`LLM provider error ${res.status}`, res.status >= 500);
    return fromChatResponse((await res.json()) as ChatResponse);
  }
}
