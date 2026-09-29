// Wire protocol between the NAVIA app (which runs the co-pilot loop and
// executes tools locally, next to the navigation engine) and the NAVIA AI
// backend (which holds the provider API key, owns the system prompt and
// tool schemas, and forwards to the LLM).
//
// The app never sends a system prompt or tool schema: the backend attaches
// the ones compiled from this package, so a modified client cannot turn the
// backend into a general-purpose LLM proxy. `COPILOT_PROTOCOL_VERSION`
// guards against an app and backend built from different tool sets.

export const COPILOT_PROTOCOL_VERSION = "2026-09-29.3";

/** fast = cheap/low-latency model for routine turns; smart = stronger model for multi-step reasoning. */
export type ModelTier = "fast" | "smart";

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
/**
 * Any other block the model returns (thinking, redacted_thinking, fallback
 * markers …). The loop echoes these back unchanged within a turn — the API
 * requires thinking blocks to be replayed as-is.
 */
export type OpaqueBlock = { type: string; [key: string]: unknown };

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text" && typeof (b as TextBlock).text === "string";
}
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use" && typeof (b as ToolUseBlock).id === "string" && typeof (b as ToolUseBlock).name === "string";
}

export type CopilotMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

export type CompletionRequest = {
  protocolVersion: string;
  tier: ModelTier;
  messages: CopilotMessage[];
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CompletionResponse = {
  content: ContentBlock[];
  /** end_turn | tool_use | max_tokens | refusal | pause_turn | … */
  stopReason: string;
  model: string;
  usage: Usage;
};

export interface LLMClient {
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
}

/** Thrown for any failure to reach or use the LLM; the co-pilot degrades to its local deterministic answers. */
export class LLMUnavailableError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
