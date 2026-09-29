// LLMClient backed by the Claude API through the official Anthropic SDK.
// Used by the HTTP server and by the live eval runner. It attaches the
// co-pilot's frozen system prompt and tool schemas from @navia/core, maps
// the fast/smart tier to a model, and enables prompt caching.

import Anthropic from "@anthropic-ai/sdk";
import {
  COPILOT_SYSTEM_PROMPT, COPILOT_TOOLS, LLMUnavailableError,
  type CompletionRequest, type CompletionResponse, type ContentBlock, type LLMClient,
} from "@navia/core";
import type { BackendConfig } from "./config";

type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The slice of the SDK client this module uses (lets tests inject a fake). */
export type MessagesApi = {
  beta: { messages: { create(params: BetaCreateParams, options?: { signal?: AbortSignal }): Promise<Anthropic.Beta.Messages.BetaMessage> } };
};

// Models that take output_config.effort and support the server-side refusal
// fallback (`fallbacks: "default"`). Haiku 4.5 supports neither.
const EFFORT_AND_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

const TOOLS: Anthropic.Beta.Messages.BetaTool[] = COPILOT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
}));

export class AnthropicLLMClient implements LLMClient {
  constructor(private client: MessagesApi, private config: Pick<BackendConfig, "fastModel" | "smartModel" | "smartEffort" | "fastMaxTokens" | "smartMaxTokens">) {}

  buildParams(request: CompletionRequest): BetaCreateParams {
    const smart = request.tier === "smart";
    const model = smart ? this.config.smartModel : this.config.fastModel;
    const advanced = EFFORT_AND_FALLBACK_MODELS.has(model);
    return {
      model,
      max_tokens: smart ? this.config.smartMaxTokens : this.config.fastMaxTokens,
      // Render order is tools -> system -> messages: this breakpoint caches
      // the (static) tool list and system prompt together...
      system: [{ type: "text", text: COPILOT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      // ...and top-level auto-caching covers the growing message prefix
      // across the several calls of one multi-step turn.
      cache_control: { type: "ephemeral" },
      messages: request.messages as unknown as Anthropic.Beta.Messages.BetaMessageParam[],
      ...(advanced && smart ? { output_config: { effort: this.config.smartEffort } } : {}),
      ...(advanced ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const params = this.buildParams(request);
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await this.client.beta.messages.create(params, signal ? { signal } : undefined);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new LLMUnavailableError("LLM rate limited", true);
      if (e instanceof Anthropic.AuthenticationError) throw new LLMUnavailableError("LLM provider credential rejected (check ANTHROPIC_API_KEY on the backend)", false);
      if (e instanceof Anthropic.BadRequestError) throw new LLMUnavailableError(`LLM rejected the request: ${e.message}`, false);
      if (e instanceof Anthropic.APIConnectionError) throw new LLMUnavailableError(`LLM provider unreachable: ${e.message}`, true);
      if (e instanceof Anthropic.APIError) throw new LLMUnavailableError(`LLM provider error ${e.status ?? ""}: ${e.message}`, (e.status ?? 500) >= 500);
      throw e;
    }
    return {
      content: message.content as unknown as ContentBlock[],
      stopReason: message.stop_reason ?? "end_turn",
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
