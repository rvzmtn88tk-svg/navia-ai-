// Which model tier serves each LLM call inside a co-pilot turn.
//
// A cascade on structural signals of the turn, not on keywords in the
// driver's text: most turns ("how long left?", "find fuel on the way") are a
// single tool round plus a short answer and stay on the fast/cheap model.
// The strong model takes over when the turn turns out to be genuinely
// multi-step (a third LLM call, two or more different tools, a tool error to
// recover from) or when the previous turn needed it moments ago (the driver
// is mid-way through a complex exchange).

import type { ModelTier } from "./protocol";

export type RouterPolicy = {
  mode: "auto" | "always_fast" | "always_smart";
  /** Escalate once this many LLM calls have happened in the turn. */
  escalateAtCall: number;
  /** Escalate once this many distinct tools were used in the turn. */
  escalateAtDistinctTools: number;
  /** Escalate immediately for driver messages longer than this (characters). */
  longMessageChars: number;
  /** Keep using the smart tier for follow-ups within this window after a smart turn. */
  stickySmartMs: number;
};

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  mode: "auto",
  escalateAtCall: 2,
  escalateAtDistinctTools: 2,
  longMessageChars: 160,
  stickySmartMs: 90_000,
};

export type TurnSignals = {
  /** LLM calls already made in this turn (0 for the first call). */
  callIndex: number;
  distinctToolsUsed: number;
  toolErrors: number;
  userTextLength: number;
  msSinceLastSmartTurn: number | null;
  /** Tier used by the previous call in this turn (never downgrade mid-turn). */
  previousTier: ModelTier | null;
};

export function chooseTier(signals: TurnSignals, policy: RouterPolicy = DEFAULT_ROUTER_POLICY): ModelTier {
  if (policy.mode === "always_fast") return "fast";
  if (policy.mode === "always_smart") return "smart";
  if (signals.previousTier === "smart") return "smart";
  if (signals.userTextLength > policy.longMessageChars) return "smart";
  if (signals.msSinceLastSmartTurn != null && signals.msSinceLastSmartTurn <= policy.stickySmartMs) return "smart";
  if (signals.toolErrors > 0) return "smart";
  if (signals.distinctToolsUsed >= policy.escalateAtDistinctTools) return "smart";
  if (signals.callIndex >= policy.escalateAtCall) return "smart";
  return "fast";
}
