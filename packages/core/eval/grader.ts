// Deterministic grading of co-pilot turns against TurnSpec, plus the
// number-grounding check: every number the co-pilot says must be traceable
// to the trip_state block, a tool result, the driver's words, or an earlier
// answer — a direct detector for invented distances, times and counts.

import type { CopilotReply } from "../src/copilot/copilot";
import type { TurnSpec, ToolCall } from "./scenarios";

export type Check = { name: string; passed: boolean; detail?: string };

/** Numbers as a driver would hear them: 12, 2.8, 2,8, 14:48 (-> 14 and 48). */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.push(Number(m[0].replace(",", ".")));
  return out;
}

function collectNumbers(value: unknown, into: number[]): void {
  if (typeof value === "number") into.push(value);
  else if (typeof value === "string") into.push(...extractNumbers(value));
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, into));
}

/**
 * Numbers in `answer` that match nothing in the grounding corpus. Tolerates
 * spoken rounding (±0.5 absolute or ±10 % relative) and unit changes
 * (m <-> km, s <-> min). Single-digit integers up to 3 are ignored (counts
 * like "two options", ordinal words rendered as digits).
 */
export function ungroundedNumbers(answer: string, corpus: unknown[]): number[] {
  const known: number[] = [];
  for (const c of corpus) collectNumbers(c, known);
  const candidates = new Set<number>();
  for (const k of known) {
    candidates.add(k);
    candidates.add(k / 1000);
    candidates.add(k * 1000);
    candidates.add(k / 60);
    candidates.add(k * 60);
  }
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.5 || Math.abs(a - b) <= Math.abs(b) * 0.1;
  return extractNumbers(answer).filter((n) => !(Number.isInteger(n) && n <= 3) && ![...candidates].some((k) => close(n, k)));
}

export function gradeTurn(spec: TurnSpec, reply: CopilotReply, ctx: { waypoints: number; groundingCorpus: unknown[] }): Check[] {
  const checks: Check[] = [];
  const calls: ToolCall[] = reply.trace.map((t) => ({ tool: t.tool, input: t.input }));
  const tools = new Set(calls.map((c) => c.tool));
  checks.push({ name: "answered_by_llm", passed: reply.mode === "llm", detail: reply.degradedReason ?? "" });
  for (const t of spec.expectTools ?? []) checks.push({ name: `calls ${t}`, passed: tools.has(t), detail: [...tools].join(",") });
  if (spec.expectAnyTool) {
    checks.push({ name: `calls any of ${spec.expectAnyTool.join("|")}`, passed: spec.expectAnyTool.some((t) => tools.has(t)), detail: [...tools].join(",") });
  }
  for (const t of spec.forbidTools ?? []) checks.push({ name: `does not call ${t}`, passed: !tools.has(t) });
  if (spec.expectCall) checks.push({ name: spec.expectCall.description, passed: spec.expectCall.test(calls), detail: JSON.stringify(calls) });
  if (spec.expectPending !== undefined) {
    checks.push({ name: `pending = ${spec.expectPending ?? "none"}`, passed: (reply.pendingAction?.tool ?? null) === spec.expectPending, detail: String(reply.pendingAction?.tool ?? "none") });
  }
  if (spec.expectWaypoints !== undefined) {
    checks.push({ name: `waypoints = ${spec.expectWaypoints}`, passed: ctx.waypoints === spec.expectWaypoints, detail: String(ctx.waypoints) });
  }
  for (const re of spec.mustMatch ?? []) checks.push({ name: `says ${re}`, passed: re.test(reply.text) });
  for (const re of spec.mustNotMatch ?? []) checks.push({ name: `does not say ${re}`, passed: !re.test(reply.text) });
  if (spec.maxWords) {
    const words = reply.text.split(/\s+/).filter(Boolean).length;
    checks.push({ name: `<= ${spec.maxWords} words`, passed: words <= spec.maxWords, detail: String(words) });
  }
  const ungrounded = ungroundedNumbers(reply.text, ctx.groundingCorpus);
  checks.push({ name: "numbers grounded in data", passed: ungrounded.length === 0, detail: ungrounded.join(", ") });
  checks.push({ name: "no markdown", passed: !/\*\*|^#|^\s*[-*•] /m.test(reply.text) });
  return checks;
}
