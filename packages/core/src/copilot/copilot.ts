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
import { CopilotSession, EntityRegistry, type CopilotRuntime, type Reminder } from "./runtime";
import { executeCopilotTool, type ToolContext } from "./tool-executor";
import { TOOL_POLICY } from "./tool-definitions";
import { buildTripSnapshot } from "./trip-snapshot";
import { parseLocalPlaceIntent, phraseLocalPlaceResult } from "./local-place-intent";

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

/** Things NAVIA notices on its own (see ProactiveEngine). */
export type CopilotEvent =
  | { type: "reminder_due"; description: string; reminder: Reminder }
  | { type: "traffic_delay"; description: string; delayMin: number };

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

/** Remove formatting and internal ids (p3, s1, r2) that TTS would read out literally. */
export function toSpeakable(text: string): string {
  return text
    // "SKIP" is only for NAVIA-noticed events; never read it out in front of an answer.
    .replace(/^\s*SKIP\s*\.?\s*\n+/i, "")
    .replace(/\s*\((?:id\s*)?[prs]\d{1,3}\)/g, "")
    .replace(/\*\*|__|`|#+\s/g, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    // Numbered lists are read aloud badly ("один крапка"): one sentence per item.
    .replace(/^\s*\d{1,2}[.)]\s+/gm, "")
    .replace(/([^.!?:\s])\s*\n+/g, "$1. ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * NAVIA is "it": a sentence that starts with a gendered past-tense verb about
 * itself ("Знайшов три АЗС", "Додала зупинку") becomes impersonal ("Знайдено
 * три АЗС", "Додано зупинку"). Only at the start of a sentence, where the
 * subject can only be NAVIA; in a Ukrainian answer, a stray Russian "почти".
 */
const NEUTER: [RegExp, string][] = [
  [/^(знайш(ов|ла|ло))(?=[\s,.!?:—-]|$)/iu, "Знайдено"], [/^(додав|додала|додало)(?=[\s,.!?:—-]|$)/iu, "Додано"], [/^(прибрав|прибрала|прибрало)(?=[\s,.!?:—-]|$)/iu, "Прибрано"],
  [/^(зберіг|зберегла|зберегло)(?=[\s,.!?:—-]|$)/iu, "Збережено"], [/^(встановив|встановила|встановило)(?=[\s,.!?:—-]|$)/iu, "Встановлено"], [/^(скасував|скасувала|скасувало)(?=[\s,.!?:—-]|$)/iu, "Скасовано"],
  [/^(змінив|змінила|змінило)(?=[\s,.!?:—-]|$)/iu, "Змінено"], [/^(перевірив|перевірила|перевірило)(?=[\s,.!?:—-]|$)/iu, "Перевірено"], [/^(зрозумів|зрозуміла|зрозуміло)(?=[\s,.!?:—-]|$)/iu, "Зрозуміло"],
  // Russian replies: NAVIA is "it" there too.
  [/^(понял|поняла)(?=[\s,.!?:—-]|$)/iu, "Понятно"], [/^(нашёл|нашел|нашла)(?=[\s,.!?:—-]|$)/iu, "Найдено"], [/^(добавил|добавила)(?=[\s,.!?:—-]|$)/iu, "Добавлено"],
  [/^(убрал|убрала)(?=[\s,.!?:—-]|$)/iu, "Убрано"], [/^(сохранил|сохранила)(?=[\s,.!?:—-]|$)/iu, "Сохранено"], [/^(отменил|отменила)(?=[\s,.!?:—-]|$)/iu, "Отменено"],
  [/^(изменил|изменила)(?=[\s,.!?:—-]|$)/iu, "Изменено"], [/^(проверил|проверила)(?=[\s,.!?:—-]|$)/iu, "Проверено"],
  [/(^|,\s*)(вернулся|вернулась)(?=\s+к\s)/iu, "$1возвращаю"],
  // "NAVIA готова / я готовий" → neuter; "маршрут готовий" (a masculine noun) stays.
  [/(NAVIA|NAVIA[^.!?]{0,40}?|(^|\s)я)\s+готов(а|ий|ый)(?=[\s,.!?:—-]|$)/iu, "$1 готове"],
];
export function neuterize(text: string): string {
  const ukrainian = /[іїєґ]/i.test(text);
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      let out = sentence;
      for (const [re, repl] of NEUTER) out = out.replace(re, repl);
      return out;
    })
    .join(" ")
    .replace(/(^|\s)почти(?=\s)/g, (m, sp: string) => (ukrainian ? `${sp}майже` : m));
}

/** GPS is not what places the car right now (see TurnSignals.positionUncertain). */
function positionUncertainNow(runtime: CopilotRuntime): boolean {
  const { state } = runtime.getNavigation();
  if (state.positionMode === "DEAD_RECKONING" || state.positionMode === "MANUAL") return true;
  // No navigation-grade fix at all while GPS is weak or gone.
  return !state.trustedPosition && state.gnss !== "NORMAL";
}

/** A spoken answer longer than this is cut at a sentence boundary (the driver is driving). */
export const MAX_SPOKEN_WORDS = 60;
export function capSpokenWords(text: string, max = MAX_SPOKEN_WORDS): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    const next = (out + s).trim();
    if (next.split(/\s+/).length > max) break;
    out = next + " ";
  }
  // A question at the end (the driver has to answer it) is kept even past the limit.
  const lastQuestion = sentences.filter((s) => s.trim().endsWith("?")).pop()?.trim();
  const cut = out.trim() || (sentences[0] ?? text).trim();
  return lastQuestion && !cut.includes(lastQuestion) ? `${cut} ${lastQuestion}` : cut;
}

const ACTION_TOOLS = new Set(Object.entries(TOOL_POLICY).filter(([, p]) => p !== "read").map(([t]) => t));
/** "Додати …?", "Змінити маршрут на …?": a yes/no about one concrete action (not "ОККО чи WOG?"). */
const PROPOSAL_Q = /((додати|додам|додаю|змін|замін|поміня|поїха|поїде|їдемо|заїха|заїде|заїжджа|прибра|скасува|перестав|встанов|переспрям|переключ|перебуду|add|change|switch|set)[^?]*\?|(гаразд|добре|підтверджуєте|підтвердити|погоджуєтесь|згодні|так|ок|окей|ok|okay)\s*\?\s*$)/i;
const CHOICE = /(\sчи\s|\sабо\s|яку|який|яке|які|куди|куда|де саме|where|which)[^?]*\?/i;
/**
 * The language to answer in, from the driver's own words: a sentence in
 * English → en, in Russian → ru, otherwise (Ukrainian, a single word, a mix) → uk.
 * The fast model otherwise drifts to Ukrainian from the Ukrainian place names.
 */
export function replyLanguage(text: string, previous: "uk" | "ru" | "en" | null = null): "uk" | "ru" | "en" {
  const t = text.trim();
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const latin = (t.match(/[a-z]/gi) ?? []).length;
  const cyr = (t.match(/[а-яёіїєґ]/gi) ?? []).length;
  if (latin > cyr * 2 && words.length >= 2) return "en";
  if (/[іїєґ]/i.test(t)) return "uk";
  if (/[ыэъё]/i.test(t) || RUSSIAN_WORDS.test(t)) return "ru";
  // A one-word answer ("Харьковская", "справа") continues the conversation's language.
  if (words.length < 3 && previous) return previous;
  return "uk";
}
/** Common Russian words that Ukrainian spells differently (no ы/э/ё needed to tell them apart). */
const RUSSIAN_WORDS = /(^|[\s,.!?—-])(пробке|пробка|еду|едем|поехали|вижу|стоим|свернул|повернул налево|повернул направо|расскажи|скажи|покажи|помоги|подскажи|можешь|может|сейчас|время|какое|пока|тоже|очень|только|что|где|как|какая|какой|какое|какие|какую|сколько|ещё|еще|нет|вижу|видно|здесь|сейчас|куда|откуда|почему|теперь|опять|снова|сбился|потерялся|пропал|станцию|найди|найти|пути|дороге|хочу|мне|нужно|можно|давай|спасибо|хорошо|ладно|второе|первое|остановк\w*|пожалуйста|справа|слева|напротив|перекр[её]ст\w*)(?=[\s,.!?—-]|$)/iu;
const LANGUAGE_NAME = { uk: "Ukrainian", ru: "Russian", en: "English" } as const;

/** Marks NAVIA's self-check messages to the model (transcript replay recognises them). */
export const SELF_CHECK_PREFIX = "[NAVIA self-check] ";
/** The driver asked NAVIA to DO something (not only to find): go somewhere, add, plan, change, remove. */
const DRIVER_ACTION = /(поїхали|поїдемо|їдемо|їдьмо|веди|вези|додай|додати|зроби зупинку|заїдемо|заїдь|розплануй|сплануй|зміни|змінимо|заміни|поміняй|встанови|прибери|скасуй|поверни|перестав|поехали|едем|вези|добавь|сделай остановку|заедем|измени|поменяй|убери|верни|take me|go to|add|plan|change|switch|remove)/i;
/** "Додано.", "Зупинку видалено": the driver hears that something was done. */
const DONE_CLAIM = /(^|[\s.!,—-])(додано|додав|додала|видалено|видалена|видалений|прибрано|скасовано|змінено|замінено|встановлено|збережено|переставлено|перебудовано|запам.?ятовано|повернуто|позицію уточнено|позицію скасовано|добавлено|удалено|убрано|отменено|отмена|изменено|сохранено|возвращаю|возвращено|позиция уточнена|позиция отменена)([\s.!,]|$)/iu;

/**
 * Checks the model's final words against what really happened this turn and
 * returns a correction to send back to the model once, or null:
 * - an empty answer after tools ran;
 * - a yes/no about an action that was never proposed (the "yes" would do nothing);
 * - a claim that something was done when no action tool ran.
 */
export function replyCorrection(text: string, trace: ToolTraceEntry[], hasPending: boolean, driverText = ""): string | null {
  // Done = an action tool that ran without error and was not merely proposed (awaiting confirmation).
  const acted = trace.some((t) => ACTION_TOOLS.has(t.tool) && !t.isError && (t.result as { status?: unknown } | null)?.status !== "awaiting_user_confirmation");
  const proposed = trace.some((t) => ACTION_TOOLS.has(t.tool) && !t.isError);
  if (!text.trim()) {
    return trace.length > 0 ? "Tell the driver the result of what you just did or found, in one or two short spoken sentences, in the reply language. Do not mention this check." : null;
  }
  // Only when the driver asked for the action: after a plain "find …", offering "Додати?" without a proposal is the design.
  if (!hasPending && !proposed && DRIVER_ACTION.test(driverText) && PROPOSAL_Q.test(text) && !CHOICE.test(text.match(/[^.!?]*\?/g)?.pop() ?? "")) {
    return "You asked the driver to confirm an action, but nothing is pending, so a \"yes\" would do nothing. Call the action tool now (add_stop, set_destination, switch_route or reorder_stops — find the place or destination first if needed) so it returns awaiting_user_confirmation, then ask the yes/no question. If you only meant to list options, don't ask to confirm. Do not mention this check to the driver.";
  }
  if (!acted && DONE_CLAIM.test(text)) {
    return "You told the driver an action was done, but it was not done this turn (no action tool ran, or it only awaits the driver's confirmation). Fix it: safe actions (remove_stop, set_route_preferences, set_reminder, cancel_reminder, remember_preference, forget_preference, confirm_position, undo_position_fix) run at once — call the tool now; if it awaits confirmation, ask for it; otherwise say plainly it was not done. Do not mention this check to the driver.";
  }
  return null;
}

export class NaviaCopilot {
  readonly session = new CopilotSession();
  /** The language of the conversation so far (short answers keep it). */
  private replyLang: "uk" | "ru" | "en" | null = null;
  readonly registry = new EntityRegistry();
  private fallback: AIProvider;

  constructor(private options: CopilotOptions) {
    this.fallback = options.fallback ?? new DeterministicDemoAIProvider();
  }

  /** The action (or plan of actions) awaiting the driver's yes/no, as one confirm-button line. */
  /** A "where am I" dialogue is going on (the last locate_by_description was recent): the driver's next words belong to it. */
  isLocating(nowMs = Date.now(), withinMs = 180_000): boolean {
    const l = this.session.lastLocate;
    return !!l && nowMs - l.at < withinMs;
  }

  getPendingAction(): { tool: string; summary: string } | null {
    const ps = this.session.pendingActions;
    if (ps.length === 0) return null;
    return { tool: ps.map((p) => p.tool).join("+"), summary: ps.map((p) => p.summary).join("; потім ") };
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
    if (!text) return this.reply("Не вдалося почути питання.", "local", started, {});

    const enabled = this.llmEnabled();
    if (!enabled.ok) return this.localAnswer(text, started, enabled.reason, false);
    return this.runAgent(text, text, started, nowMs);
  }

  /**
   * Something happened that the driver may want to hear about (a reminder is
   * due, traffic ahead got much worse). The model gets it as an <event> with
   * the live trip state and decides: say one short sentence, look up places
   * and propose an action, or stay silent ("SKIP"). Returns null when there
   * is nothing to say.
   */
  async handleEvent(event: CopilotEvent): Promise<CopilotReply | null> {
    const started = Date.now();
    const nowMs = this.options.runtime.now().getTime();
    this.session.beginTurn(nowMs);
    const enabled = this.llmEnabled();
    if (!enabled.ok) return this.localEvent(event, started, enabled.reason);
    const eventText = `<event type="${event.type}">${event.description}\nThis is not the driver speaking: NAVIA noticed it. Bring it up only if useful right now, in one short sentence; you may look things up and propose one action. If it is not worth interrupting the driver, reply exactly SKIP.</event>`;
    const reply = await this.runAgent(eventText, `[подія] ${event.description}`, started, nowMs, event);
    if (!reply || /^\s*SKIP\s*\.?$/i.test(reply.text)) return null;
    return reply;
  }

  private async runAgent(text: string, memoryText: string, started: number, nowMs: number): Promise<CopilotReply>;
  private async runAgent(text: string, memoryText: string, started: number, nowMs: number, event: CopilotEvent): Promise<CopilotReply | null>;
  private async runAgent(text: string, memoryText: string, started: number, nowMs: number, event?: CopilotEvent): Promise<CopilotReply | null> {

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
          ...(event ? [] : [{ type: "text" as const, text: `<reply_language>${LANGUAGE_NAME[this.replyLang = replyLanguage(text, this.replyLang)]}</reply_language>` }]),
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
    let corrected = false;

    try {
      for (let callIndex = 0; callIndex < maxCalls; callIndex++) {
        const tier = chooseTier({
          callIndex,
          distinctToolsUsed: distinctTools.size,
          toolErrors,
          userTextLength: text.length,
          msSinceLastSmartTurn: this.session.lastSmartTurnAt != null ? nowMs - this.session.lastSmartTurnAt : null,
          previousTier: tiers[tiers.length - 1] ?? null,
          positionUncertain: !event && positionUncertainNow(this.options.runtime),
        }, this.options.routerPolicy ?? DEFAULT_ROUTER_POLICY);
        this.options.onProgress?.({ stage: "llm", callIndex, tier });

        let response;
        try {
          response = await this.options.llm!.complete({ protocolVersion: COPILOT_PROTOCOL_VERSION, tier, messages }, controller?.signal);
        } catch (e) {
          const reason = e instanceof LLMUnavailableError ? e.message : `LLM call failed: ${(e as Error).message}`;
          if (callIndex === 0 && trace.length === 0) return event ? this.localEvent(event, started, reason) : this.localAnswer(text, started, reason, true);
          // Mid-turn failure after tools ran: don't discard what the tools established.
          const partial = trace.length > 0 ? " Частину даних отримано, але опрацювати їх не вдалося — спитайте ще раз." : "";
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
          // Reads run in parallel; actions run one after another in the order the
          // model called them (a plan's order matters: "coffee first, then home").
          const runOne = async (use: (typeof toolUses)[number]): Promise<ToolResultBlock> => {
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
          };
          const isRead = (name: string) => (TOOL_POLICY as Record<string, string>)[name] === "read";
          const byId = new Map<string, ToolResultBlock>();
          await Promise.all(toolUses.filter((u) => isRead(u.name)).map(async (u) => { byId.set(u.id, await runOne(u)); }));
          for (const u of toolUses.filter((x) => !isRead(x.name))) byId.set(u.id, await runOne(u));
          const results: ToolResultBlock[] = toolUses.map((u) => byId.get(u.id)!);
          // All results for one assistant message go back in ONE user message.
          messages.push({ role: "user", content: results });
          continue;
        }
        if (response.stopReason === "pause_turn") continue;

        finalText = response.content.filter(isTextBlock).map((b) => b.text).join(" ").trim();
        // One self-check round: the words must match what was actually done.
        const correction = !event && !corrected && callIndex < maxCalls - 1 ? replyCorrection(finalText, trace, this.session.pendingActions.length > 0, text) : null;
        if (correction) {
          corrected = true;
          messages.push({ role: "user", content: [{ type: "text", text: SELF_CHECK_PREFIX + correction }] });
          finalText = "";
          continue;
        }
        break;
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    if (!finalText) {
      finalText = trace.length > 0
        ? "Запит не вдалося завершити вчасно. Спробуйте сформулювати коротше."
        : "Вибачте, не вдалося сформулювати відповідь.";
    }
    finalText = neuterize(toSpeakable(finalText));
    if (!event) finalText = capSpokenWords(finalText);
    if (!/^\s*SKIP\s*\.?$/i.test(finalText)) this.remember(memoryText, finalText);
    if (tiers.includes("smart")) this.session.lastSmartTurnAt = nowMs;
    return this.reply(finalText, "llm", started, { trace, tiers, models, usage, ...(stopReason ? { stopReason } : {}) });
  }

  /** The driver tapped "Confirm": execute the pending action(s) in order, no LLM round-trip. */
  async confirmPendingAction(): Promise<CopilotReply> {
    const started = Date.now();
    const plan = [...this.session.pendingActions];
    if (plan.length === 0) return this.reply("Немає дії, яку потрібно підтвердити.", "local", started, {});
    const trace: ToolTraceEntry[] = [];
    const spoken: string[] = [];
    for (const pending of plan) {
      const t0 = Date.now();
      const outcome = await executeCopilotTool(pending.tool, pending.input, this.toolContext(), { confirmedByUi: true });
      trace.push({ tool: pending.tool, input: pending.input, isError: outcome.isError, result: outcome.content, ms: Date.now() - t0 });
      spoken.push(outcome.spoken ?? (outcome.isError ? `Не вдалося виконати: ${String(outcome.content.message ?? "помилка")}` : "Готово."));
      if (outcome.isError) break; // don't run the rest of a plan whose first step failed
    }
    this.session.pendingActions = [];
    const text = spoken.join(" ");
    this.remember(`[підтверджено кнопкою] ${plan.map((p) => p.summary).join("; ")}`, text);
    return this.reply(text, "local", started, { trace });
  }

  declinePendingAction(): CopilotReply {
    const started = Date.now();
    const plan = this.session.pendingActions;
    this.session.pendingActions = [];
    const text = plan.length ? "Добре, скасовано." : "Немає дії, яку потрібно скасувати.";
    if (plan.length) this.remember(`[скасовано кнопкою] ${plan.map((p) => p.summary).join("; ")}`, text);
    return this.reply(text, "local", started, {});
  }

  /** Without the LLM: a reminder is still delivered, with a real along-route search when it names categories. */
  private async localEvent(event: CopilotEvent, started: number, reason: string): Promise<CopilotReply | null> {
    if (event.type !== "reminder_due") return null;
    const r = event.reminder;
    let text = `Нагадую: ${r.topic}.`;
    const trace: ToolTraceEntry[] = [];
    if (r.categories.length > 0 && this.options.runtime.places()) {
      const input = { categories: r.categories, max_detour_minutes: 5, limit: 1 };
      const t0 = Date.now();
      const out = await executeCopilotTool("search_along_route", input, this.toolContext());
      trace.push({ tool: "search_along_route", input, isError: out.isError, result: out.content, ms: Date.now() - t0 });
      const first = !out.isError ? (out.content.results as { name: string; ahead_km: number; detour_min: number }[] | undefined)?.[0] : undefined;
      if (first) text += ` Найближче по дорозі: ${first.name}, через ${first.ahead_km} км, заїзд близько ${Math.max(1, Math.round(first.detour_min))} хв.`;
    }
    this.remember(`[подія] ${event.description}`, text);
    return this.reply(text, "local", started, { trace, degradedReason: reason });
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
    const trace: ToolTraceEntry[] = [];
    // Without the LLM, the commonest request ("find fuel/coffee/parking on
    // the way") is still answered from the real tools; everything else goes
    // to the deterministic status answers.
    const intent = parseLocalPlaceIntent(text);
    if (intent && this.options.runtime.places()) {
      const t0 = Date.now();
      const outcome = await executeCopilotTool(intent.tool, intent.input, this.toolContext());
      trace.push({ tool: intent.tool, input: intent.input, isError: outcome.isError, result: outcome.content, ms: Date.now() - t0 });
      answer = phraseLocalPlaceResult(intent, outcome.content, outcome.isError);
    } else {
      try {
        answer = await this.fallback.answer(ctx, text);
      } catch {
        answer = "Голосовий штурман тимчасово недоступний.";
      }
    }
    const full = notify ? `${LOCAL_NOTICE} ${answer}` : answer;
    this.remember(text, full);
    return this.reply(full, "local", started, { degradedReason: reason, trace });
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


