// Which model tier serves each LLM call inside a co-pilot turn.
//
// A cascade on structural signals of the turn, not on keywords in the
// driver's text. Typical turns — status questions, one search + answer,
// search -> propose -> answer, "yes" confirmations — stay on the fast/cheap
// model: the tools have already done the hard, numeric part. The strong
// model takes over when a turn is genuinely complex: a tool error to recover
// from, three or more different tools, a fourth LLM call, or a long
// multi-constraint request. (Tuned with the model-in-the-loop replay: an
// earlier policy — escalate at the 3rd call / 2 tools, stay smart for 90 s
// after a smart turn — sent 23 of 72 calls (32 %) to the smart tier, mostly
// to phrase results or handle "yes"/"repeat"; this one sends 3, all tool-
// error recoveries, and cuts estimated cost per turn by ~20 %.) Measure alternatives with
// `npm run eval:ai -- --policy always_fast|always_smart`.

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
  escalateAtCall: 3,
  escalateAtDistinctTools: 3,
  longMessageChars: 160,
  stickySmartMs: 0,
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
  if (policy.stickySmartMs > 0 && signals.msSinceLastSmartTurn != null && signals.msSinceLastSmartTurn <= policy.stickySmartMs) return "smart";
  if (signals.toolErrors > 0) return "smart";
  if (signals.distinctToolsUsed >= policy.escalateAtDistinctTools) return "smart";
  if (signals.callIndex >= policy.escalateAtCall) return "smart";
  return "fast";
}
