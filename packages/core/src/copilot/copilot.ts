// NaviaCopilot — the agent loop that makes NAVIA a conversational co-pilot.
//
//   driver text ─► [trip_state snapshot + short dialogue memory] ─► LLM
//        ▲                                                          │ tool_use
//        │                          executeCopilotTool (on-device) ◄┘
//        └──────────── spoken answer ◄── LLM ◄── tool_result ◄──────┘
//
// The LLM decides which tools to call and phrases the answer; every fact it
// can cite is produced by the navigation stack. The loop runs on the device
// (tools need the live navigation engine); only the LLM call goes through
// the backend. If the LLM is disabled, not configured, or unreachable, the
// co-pilot degrades to DeterministicDemoAIProvider's local answers and says
// the smart mode is unavailable (spec section 41).

import { DeterministicDemoAIProvider, type AIProvider, type NavigationContext } from "../ai-engine";
import {
  COPILOT_PROTOCOL_VERSION, LLMUnavailableError, addUsage, emptyUsage, isTextBlock, isToolUseBlock,
  type CopilotMessage, type LLMClient, type ModelTier, type ToolResultBlock, type Usage,
} from "./protocol";
import { chooseTier, DEFAULT_ROUTER_POLICY, type RouterPolicy } from "./model-router";
import { CopilotSession, EntityRegistry, type CopilotRuntime } from "./runtime";
import { executeCopilotTool, type ToolContext } from "./tool-executor";
import { buildTripSnapshot } from "./trip-snapshot";

export type CopilotOptions = {
  runtime: CopilotRuntime;
  /** null → local deterministic answers only. */
  llm: LLMClient | null;
  /** Checked on every turn: e.g. the driver's "send trip context to AI" consent. */
  aiEnabled?: () => boolean;
  routerPolicy?: RouterPolicy;
  /** Max LLM calls per driver message. */
  maxLlmCalls?: number;
  /** Max tool executions per driver message. */
  maxToolCalls?: number;
  /** Wall-clock budget for one driver message. */
  turnDeadlineMs?: number;
  /** Past exchanges kept as plain text for follow-ups ("and the second one?"). */
  historyTurns?: number;
  historyCharBudget?: number;
  fallback?: AIProvider;
  onProgress?: (event: CopilotProgress) => void;
};

export type CopilotProgress =
  | { stage: "llm"; callIndex: number; tier: ModelTier }
  | { stage: "tool"; tool: string };

export type ToolTraceEntry = {
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  result: Record<string, unknown>;
  ms: number;
};

export type CopilotReply = {
  text: string;
  /** "llm" = full co-pilot; "local" = deterministic on-device answer (AI off/unavailable). */
  mode: "llm" | "local";
  pendingAction: { tool: string; summary: string } | null;
  trace: ToolTraceEntry[];
  tiers: ModelTier[];
  models: string[];
  usage: Usage;
  latencyMs: number;
  stopReason?: string;
  /** Why the smart mode was not used / failed, for diagnostics. */
  degradedReason?: string;
};

const LOCAL_NOTICE = "Розумний режим штурмана зараз недоступний.";

/** Remove formatting that TTS would read out literally. */
export function toSpeakable(text: string): string {
  return text
    .replace(/\*\*|__|`|#+\s/g, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export class NaviaCopilot {
  readonly session = new CopilotSession();
  readonly registry = new EntityRegistry();
  private fallback: AIProvider;

  constructor(private options: CopilotOptions) {
    this.fallback = options.fallback ?? new DeterministicDemoAIProvider();
  }

  getPendingAction(): { tool: string; summary: string } | null {
    const p = this.session.pending;
    return p ? { tool: p.tool, summary: p.summary } : null;
  }

  resetConversation(): void {
    this.session.reset();
  }

  private toolContext(): ToolContext {
    return { runtime: this.options.runtime, registry: this.registry, session: this.session };
  }

  private llmEnabled(): { ok: true } | { ok: false; reason: string } {
    if (!this.options.llm) return { ok: false, reason: "AI backend not configured" };
    if (this.options.aiEnabled && !this.options.aiEnabled()) return { ok: false, reason: "AI trip-context sharing is turned off" };
    return { ok: true };
  }

  async ask(userText: string): Promise<CopilotReply> {
    const started = Date.now();
    const text = userText.trim();
    const nowMs = this.options.runtime.now().getTime();
    this.session.beginTurn(nowMs);
    if (!text) return this.reply("Я не почула запитання.", "local", started, {});

    const enabled = this.llmEnabled();
    if (!enabled.ok) return this.localAnswer(text, started, enabled.reason, false);

    const maxCalls = this.options.maxLlmCalls ?? 6;
    const maxTools = this.options.maxToolCalls ?? 12;
    const deadline = started + (this.options.turnDeadlineMs ?? 30_000);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const deadlineTimer = controller ? setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now())) : null;

    const messages: CopilotMessage[] = [
      ...this.historyMessages(),
      {
        role: "user",
        content: [
          { type: "text", text: buildTripSnapshot(this.options.runtime, this.session) },
          { type: "text", text },
        ],
      },
    ];

    const trace: ToolTraceEntry[] = [];
    const tiers: ModelTier[] = [];
    const models: string[] = [];
    let usage = emptyUsage();
    let toolCalls = 0;
    let toolErrors = 0;
    const distinctTools = new Set<string>();
    let finalText = "";
    let stopReason: string | undefined;

    try {
      for (let callIndex = 0; callIndex < maxCalls; callIndex++) {
        const tier = chooseTier({
          callIndex,
          distinctToolsUsed: distinctTools.size,
          toolErrors,
          userTextLength: text.length,
          msSinceLastSmartTurn: this.session.lastSmartTurnAt != null ? nowMs - this.session.lastSmartTurnAt : null,
          previousTier: tiers[tiers.length - 1] ?? null,
        }, this.options.routerPolicy ?? DEFAULT_ROUTER_POLICY);
        this.options.onProgress?.({ stage: "llm", callIndex, tier });

        let response;
        try {
          response = await this.options.llm!.complete({ protocolVersion: COPILOT_PROTOCOL_VERSION, tier, messages }, controller?.signal);
        } catch (e) {
          const reason = e instanceof LLMUnavailableError ? e.message : `LLM call failed: ${(e as Error).message}`;
          if (callIndex === 0 && trace.length === 0) return this.localAnswer(text, started, reason, true);
          // Mid-turn failure after tools ran: don't discard what the tools established.
          const partial = trace.length > 0 ? " Частину даних я отримала, але не встигла їх опрацювати — спитайте ще раз." : "";
          return this.reply(`${LOCAL_NOTICE}${partial}`, "llm", started, { trace, tiers, models, usage, degradedReason: reason });
        }
        tiers.push(tier);
        models.push(response.model);
        usage = addUsage(usage, response.usage);
        stopReason = response.stopReason;

        if (response.stopReason === "refusal") {
          finalText = "Я не можу допомогти з цим запитом.";
          break;
        }

        messages.push({ role: "assistant", content: response.content });
        const toolUses = response.content.filter(isToolUseBlock);

        if (response.stopReason === "tool_use" && toolUses.length > 0) {
          const lastAllowedCall = callIndex >= maxCalls - 2;
          const results: ToolResultBlock[] = await Promise.all(toolUses.map(async (use) => {
            toolCalls++;
            distinctTools.add(use.name);
            if (lastAllowedCall || toolCalls > maxTools || (controller?.signal.aborted ?? false)) {
              toolErrors++;
              return {
                type: "tool_result" as const, tool_use_id: use.id, is_error: true,
                content: JSON.stringify({ error: "budget_exhausted", message: "No more tool calls this turn. Answer now with the information you already have, and say what you could not check." }),
              };
            }
            this.options.onProgress?.({ stage: "tool", tool: use.name });
            const t0 = Date.now();
            const input = use.input && typeof use.input === "object" ? use.input : {};
            const outcome = await executeCopilotTool(use.name, input, this.toolContext());
            if (outcome.isError) toolErrors++;
            trace.push({ tool: use.name, input, isError: outcome.isError, result: outcome.content, ms: Date.now() - t0 });
            return {
              type: "tool_result" as const, tool_use_id: use.id,
              content: JSON.stringify(outcome.content),
              ...(outcome.isError ? { is_error: true } : {}),
            };
          }));
          // All results for one assistant message go back in ONE user message.
          messages.push({ role: "user", content: results });
          continue;
        }
        if (response.stopReason === "pause_turn") continue;

        finalText = response.content.filter(isTextBlock).map((b) => b.text).join(" ").trim();
        break;
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    if (!finalText) {
      finalText = trace.length > 0
        ? "Не встигла завершити запит. Спробуйте сформулювати коротше."
        : "Вибачте, не вдалося сформулювати відповідь.";
    }
    finalText = toSpeakable(finalText);
    this.remember(text, finalText);
    if (tiers.includes("smart")) this.session.lastSmartTurnAt = nowMs;
    return this.reply(finalText, "llm", started, { trace, tiers, models, usage, ...(stopReason ? { stopReason } : {}) });
  }

  /** The driver tapped "Confirm" on the pending action: execute it directly, no LLM round-trip. */
  async confirmPendingAction(): Promise<CopilotReply> {
    const started = Date.now();
    const pending = this.session.pending;
    if (!pending) return this.reply("Немає дії, яку потрібно підтвердити.", "local", started, {});
    const t0 = Date.now();
    const outcome = await executeCopilotTool(pending.tool, pending.input, this.toolContext(), { confirmedByUi: true });
    const text = outcome.spoken ?? (outcome.isError
      ? `Не вдалося виконати: ${String(outcome.content.message ?? "помилка")}`
      : "Готово.");
    this.remember(`[підтверджено кнопкою] ${pending.summary}`, text);
    return this.reply(text, "local", started, {
      trace: [{ tool: pending.tool, input: pending.input, isError: outcome.isError, result: outcome.content, ms: Date.now() - t0 }],
    });
  }

  declinePendingAction(): CopilotReply {
    const started = Date.now();
    const pending = this.session.pending;
    this.session.pending = null;
    const text = pending ? "Добре, скасовано." : "Немає дії, яку потрібно скасувати.";
    if (pending) this.remember(`[скасовано кнопкою] ${pending.summary}`, text);
    return this.reply(text, "local", started, {});
  }

  private async localAnswer(text: string, started: number, reason: string, notify: boolean): Promise<CopilotReply> {
    const { state, route } = this.options.runtime.getNavigation();
    const ctx: NavigationContext = {
      state, route,
      nearbyLandmarks: state.nearbyLandmarks,
      nearbyPOI: [...this.options.runtime.localPois()],
      recentEvents: [],
    };
    let answer: string;
    try {
      answer = await this.fallback.answer(ctx, text);
    } catch {
      answer = "Голосовий штурман тимчасово недоступний.";
    }
    const full = notify ? `${LOCAL_NOTICE} ${answer}` : answer;
    this.remember(text, full);
    return this.reply(full, "local", started, { degradedReason: reason });
  }

  private remember(user: string, assistant: string): void {
    const keep = this.options.historyTurns ?? 6;
    this.session.history.push({ user, assistant, at: this.options.runtime.now().getTime() });
    if (this.session.history.length > keep) this.session.history.splice(0, this.session.history.length - keep);
  }

  /** Earlier exchanges as plain text (no stale tool payloads or thinking blocks), newest last, within a char budget. */
  private historyMessages(): CopilotMessage[] {
    const budget = this.options.historyCharBudget ?? 3000;
    const out: CopilotMessage[] = [];
    let used = 0;
    for (let i = this.session.history.length - 1; i >= 0; i--) {
      const t = this.session.history[i]!;
      used += t.user.length + t.assistant.length;
      if (used > budget) break;
      out.unshift({ role: "user", content: t.user }, { role: "assistant", content: t.assistant });
    }
    return out;
  }

  private reply(
    text: string, mode: CopilotReply["mode"], started: number,
    extra: Partial<Pick<CopilotReply, "trace" | "tiers" | "models" | "usage" | "stopReason" | "degradedReason">>,
  ): CopilotReply {
    return {
      text,
      mode,
      pendingAction: this.getPendingAction(),
      trace: extra.trace ?? [],
      tiers: extra.tiers ?? [],
      models: extra.models ?? [],
      usage: extra.usage ?? emptyUsage(),
      latencyMs: Date.now() - started,
      ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
      ...(extra.degradedReason ? { degradedReason: extra.degradedReason } : {}),
    };
  }
}


