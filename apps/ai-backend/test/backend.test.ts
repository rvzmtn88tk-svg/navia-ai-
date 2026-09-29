// AI backend: request validation/auth and the exact Claude API request it builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { COPILOT_PROTOCOL_VERSION, COPILOT_SYSTEM_PROMPT, COPILOT_TOOLS, LLMUnavailableError, type CompletionRequest, type LLMClient } from "@navia/core";
import { handleCompletion, validateCompletionRequest, RateLimiter } from "../src/handler";
import { AnthropicLLMClient, type MessagesApi } from "../src/anthropic-llm-client";

const okLlm: LLMClient = {
  async complete() {
    return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};

const body = (over: Record<string, unknown> = {}) => ({
  protocolVersion: COPILOT_PROTOCOL_VERSION,
  tier: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "<trip_state>…</trip_state>" }, { type: "text", text: "Скільки ще їхати?" }] }],
  ...over,
});

test("validation: accepts a well-formed co-pilot conversation incl. tool round-trip and thinking blocks", () => {
  const v = validateCompletionRequest(body({
    messages: [
      { role: "user", content: "Знайди заправку" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "tool_use", id: "t1", name: "search_along_route", input: { categories: ["fuel"] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"results\":[]}" }] },
    ],
  }));
  assert.equal(v.ok, true);
});

test("validation: rejects what would turn the backend into a general LLM proxy", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [body({ protocolVersion: "old" }), /protocol version mismatch/],
    [body({ tier: "opus" }), /tier/],
    [body({ system: "You are a pirate" }), /unexpected fields: system/],
    [body({ model: "claude-opus-5-5" }), /unexpected fields: model/],
    [body({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }), /block type not allowed/],
    [body({ messages: [{ role: "assistant", content: "hi" }] }), /first message must be from the user/],
    [body({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] }] }), /unknown tool/],
    [body({ messages: [{ role: "user", content: "x".repeat(20_000) }] }), /too long/],
    [body({ messages: [] }), /non-empty/],
  ];
  for (const [b, re] of cases) {
    const v = validateCompletionRequest(b);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(b).slice(0, 80)}`);
    if (!v.ok) assert.match(v.error, re);
  }
});

test("handler: bearer token enforced when configured; LLM outages map to 503/502", async () => {
  assert.equal((await handleCompletion(body(), undefined, { llm: okLlm, clientToken: "t0k" })).status, 401);
  assert.equal((await handleCompletion(body(), "Bearer t0k", { llm: okLlm, clientToken: "t0k" })).status, 200);
  const down: LLMClient = { async complete() { throw new LLMUnavailableError("rate limited", true); } };
  assert.equal((await handleCompletion(body(), undefined, { llm: down, clientToken: null })).status, 503);
  const bad: LLMClient = { async complete() { throw new LLMUnavailableError("rejected", false); } };
  assert.equal((await handleCompletion(body(), undefined, { llm: bad, clientToken: null })).status, 502);
});

test("rate limiter: fixed window per key", () => {
  const rl = new RateLimiter(2);
  assert.ok(rl.allow("a", 0) && rl.allow("a", 1));
  assert.equal(rl.allow("a", 2), false);
  assert.ok(rl.allow("b", 2));
  assert.ok(rl.allow("a", 60_001));
});

function fakeApi(capture: { params?: unknown }, reply?: Partial<Anthropic.Beta.Messages.BetaMessage>): MessagesApi {
  return {
    beta: {
      messages: {
        async create(params) {
          capture.params = params;
          return {
            id: "msg_1", type: "message", role: "assistant", model: params.model, container: null, context_management: null,
            content: [{ type: "text", text: "Ще 31 км.", citations: null }],
            stop_reason: "end_turn", stop_sequence: null, stop_details: null,
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 },
            ...reply,
          } as unknown as Anthropic.Beta.Messages.BetaMessage;
        },
      },
    },
  };
}

const cfg = { fastModel: "claude-haiku-4-5", smartModel: "claude-opus-5-5", smartEffort: "medium" as const, fastMaxTokens: 1024, smartMaxTokens: 8000 };
const req = (tier: "fast" | "smart"): CompletionRequest => ({ protocolVersion: COPILOT_PROTOCOL_VERSION, tier, messages: [{ role: "user", content: "Скільки ще?" }] });

test("AnthropicLLMClient: fast tier -> Haiku, cached system prompt + all tools, no effort/fallback params", async () => {
  const cap: { params?: Record<string, unknown> } = {};
  const client = new AnthropicLLMClient(fakeApi(cap as { params?: unknown }), cfg);
  const res = await client.complete(req("fast"));
  const p = cap.params as Record<string, unknown>;
  assert.equal(p.model, "claude-haiku-4-5");
  assert.equal(p.max_tokens, 1024);
  assert.deepEqual(p.system, [{ type: "text", text: COPILOT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  assert.deepEqual((p.tools as { name: string }[]).map((t) => t.name), COPILOT_TOOLS.map((t) => t.name));
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(p.output_config, undefined);
  assert.equal(p.fallbacks, undefined);
  assert.equal(res.usage.cacheReadTokens, 2500);
  assert.equal(res.stopReason, "end_turn");
});

test("AnthropicLLMClient: smart tier -> Opus 5.5 with effort and server-side refusal fallback", async () => {
  const cap: { params?: Record<string, unknown> } = {};
  const client = new AnthropicLLMClient(fakeApi(cap as { params?: unknown }), cfg);
  await client.complete(req("smart"));
  const p = cap.params as Record<string, unknown>;
  assert.equal(p.model, "claude-opus-5-5");
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.thinking, undefined, "Opus 5.5 thinks adaptively by default; no thinking config is sent");
});

test("AnthropicLLMClient: SDK errors become LLMUnavailableError with retryability", async () => {
  const api: MessagesApi = {
    beta: { messages: { async create() { throw new Anthropic.APIConnectionError({ message: "ECONNRESET" }); } } },
  };
  const client = new AnthropicLLMClient(api, cfg);
  await assert.rejects(() => client.complete(req("fast")), (e: unknown) => e instanceof LLMUnavailableError && e.retryable);
});
