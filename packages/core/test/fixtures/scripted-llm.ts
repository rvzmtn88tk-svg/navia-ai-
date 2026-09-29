// A scripted stand-in for the LLM, for testing the co-pilot's plumbing
// deterministically: the agent loop, tool execution, confirmation gating,
// budgets, fallbacks, history. Each step inspects the conversation so far
// (like a model would) and returns text and/or tool calls. It tests OUR code
// paths — not the real model's judgement, which apps/ai-backend/eval covers.

import { LLMUnavailableError, type CompletionRequest, type CompletionResponse, type ContentBlock, type LLMClient, type ModelTier } from "../../src/copilot/protocol";

export type ScriptView = {
  request: CompletionRequest;
  callIndex: number;
  /** Parsed JSON of the tool results in the latest user message (in call order). */
  lastToolResults: Record<string, unknown>[];
  /** The driver's latest text (last text block of the last message that has one). */
  userText: string;
  /** The <trip_state> block of the current turn. */
  tripState: string;
};

export type ScriptReply = { text?: string; tools?: { name: string; input: Record<string, unknown> }[]; stopReason?: string };
export type ScriptStep = (view: ScriptView) => ScriptReply;

export class ScriptedLLM implements LLMClient {
  readonly requests: CompletionRequest[] = [];
  private callIndex = 0;
  private toolSeq = 0;

  constructor(private steps: ScriptStep[], private opts: { failAtCall?: number } = {}) {}

  get tiers(): ModelTier[] { return this.requests.map((r) => r.tier); }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as CompletionRequest);
    const idx = this.callIndex++;
    if (this.opts.failAtCall === idx) throw new LLMUnavailableError("simulated backend outage", true);
    const step = this.steps[idx];
    if (!step) throw new Error(`ScriptedLLM: no step for call ${idx}`);
    const reply = step(view(request, idx));
    const content: ContentBlock[] = [];
    if (reply.text) content.push({ type: "text", text: reply.text });
    for (const t of reply.tools ?? []) content.push({ type: "tool_use", id: `tu_${++this.toolSeq}`, name: t.name, input: t.input });
    return {
      content,
      stopReason: reply.stopReason ?? ((reply.tools?.length ?? 0) > 0 ? "tool_use" : "end_turn"),
      model: `scripted-${request.tier}`,
      usage: { inputTokens: Math.round(JSON.stringify(request.messages).length / 4), outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

function view(request: CompletionRequest, callIndex: number): ScriptView {
  const last = request.messages[request.messages.length - 1]!;
  const blocks = typeof last.content === "string" ? [] : last.content;
  const lastToolResults = blocks
    .filter((b) => b.type === "tool_result")
    .map((b) => JSON.parse((b as { content: string }).content) as Record<string, unknown>);
  let userText = "";
  let tripState = "";
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") { userText ||= m.content; break; }
    const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    if (texts.length > 0) {
      userText ||= texts[texts.length - 1]!;
      tripState ||= texts.find((t) => t.startsWith("<trip_state>")) ?? "";
      break;
    }
  }
  return { request, callIndex, lastToolResults, userText, tripState };
}
