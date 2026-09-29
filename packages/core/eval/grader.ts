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

export type Unit = "km" | "m" | "min" | "clock" | "speed" | "none";
export type Fact = { unit: Unit; value: number };

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const L = "а-яіїєґё";
// Order matters: clock and speed before km/m, km before m.
const UNIT_PATTERNS: [Unit, RegExp][] = [
  ["clock", /(\d{1,2}):(\d{2})/g],
  ["speed", new RegExp(`${NUM}\\s*(?:km\\/h|км\\/год|км\\/ч)`, "gi")],
  ["km", new RegExp(`${NUM}\\s*(?:km\\b|км(?![${L}/])|кілометр[${L}]*|километр[${L}]*)`, "gi")],
  ["m", new RegExp(`${NUM}\\s*(?:m\\b|м(?![${L}/])|метр[${L}]*)`, "gi")],
  ["min", new RegExp(`${NUM}\\s*(?:min\\b|хв(?![${L}])|хвилин[${L}]*|минут[${L}]*|мин(?![${L}]))`, "gi")],
];

/** Numbers in free text, each tagged with the unit it was spoken with ("none" if bare). */
export function extractFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  const used: [number, number][] = [];
  const overlaps = (a: number, b: number) => used.some(([x, y]) => a < y && b > x);
  for (const [unit, re] of UNIT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (overlaps(at, at + m[0].length)) continue;
      used.push([at, at + m[0].length]);
      facts.push({ unit, value: unit === "clock" ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]!.replace(",", ".")) });
    }
  }
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const at = m.index ?? 0;
    if (!overlaps(at, at + m[0].length)) facts.push({ unit: "none", value: Number(m[0].replace(",", ".")) });
  }
  return facts;
}

function unitForKey(key: string): Unit {
  if (/(^|_)km$|_km_/.test(key) || key === "km") return "km";
  if (/min$|minutes/.test(key)) return "min";
  if (/(^|_)m$/.test(key)) return "m";
  if (key === "arrival" || key === "updated") return "clock";
  return "none";
}

/** Typed facts from tool results (by JSON key) and from text (trip_state, driver's words, earlier answers). */
export function collectFacts(value: unknown, into: Fact[] = [], key = ""): Fact[] {
  if (typeof value === "number") into.push({ unit: unitForKey(key), value });
  else if (typeof value === "string") {
    if (unitForKey(key) === "clock" && /^\d{1,2}:\d{2}$/.test(value)) {
      const [h, mm] = value.split(":").map(Number);
      into.push({ unit: "clock", value: h! * 60 + mm! });
    } else into.push(...extractFacts(value));
  } else if (Array.isArray(value)) value.forEach((v) => collectFacts(v, into, key));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collectFacts(v, into, k);
  return into;
}

const close = (claim: number, fact: number) =>
  Math.abs(claim - fact) <= (Math.abs(fact) < 10 ? 0.5 : Math.max(1, Math.abs(fact) * 0.06));

function supported(claim: Fact, facts: Fact[]): boolean {
  switch (claim.unit) {
    case "km": return facts.some((f) => (f.unit === "km" && close(claim.value, f.value)) || (f.unit === "m" && close(claim.value, f.value / 1000)));
    case "m": return facts.some((f) => (f.unit === "m" && close(claim.value, f.value)) || (f.unit === "km" && close(claim.value, f.value * 1000)));
    case "min": return facts.some((f) => f.unit === "min" && close(claim.value, f.value));
    case "clock": return facts.some((f) => f.unit === "clock" && Math.abs(claim.value - f.value) <= 1);
    case "speed": return facts.some((f) => f.unit === "speed" && close(claim.value, f.value));
    case "none": return (Number.isInteger(claim.value) && claim.value <= 3) || facts.some((f) => close(claim.value, f.value) || (f.unit === "m" && close(claim.value, f.value / 1000)));
  }
}

/**
 * Spoken numbers that no fact of the same kind supports. A distance must
 * match a distance, a duration a duration, a clock time an arrival/current
 * time — so "5 km" is not excused by the driver having said "5 minutes".
 * Tolerates spoken rounding (±0.5 below 10, else ±6 %) and m <-> km.
 */
export function ungroundedNumbers(answer: string, corpus: unknown[]): string[] {
  const facts: Fact[] = [];
  for (const c of corpus) collectFacts(c, facts);
  return extractFacts(answer)
    .filter((claim) => !supported(claim, facts))
    .map((c) => (c.unit === "clock" ? `${Math.floor(c.value / 60)}:${String(c.value % 60).padStart(2, "0")}` : `${c.value}${c.unit === "none" ? "" : ` ${c.unit}`}`));
}

/** The <trip_state> blocks the model was shown in these requests. */
export function tripStatesOf(requests: { messages: { role: string; content: unknown }[] }[]): string[] {
  const out: string[] = [];
  for (const r of requests) for (const m of r.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; text?: string }[]) if (b.type === "text" && b.text?.startsWith("<trip_state>")) out.push(b.text);
  }
  return out;
}

/** Rough language of a reply: Ukrainian and Russian told apart by their distinctive letters. */
export function detectLanguage(text: string): "uk" | "ru" | "en" | "unknown" {
  const cyr = (text.match(/[а-яёіїєґ]/gi) ?? []).length, lat = (text.match(/[a-z]/gi) ?? []).length;
  if (lat > cyr) return "en";
  if (cyr === 0) return "unknown";
  const uk = (text.match(/[іїєґ]/gi) ?? []).length, ru = (text.match(/[ыэъё]/gi) ?? []).length;
  return uk >= ru ? (uk > 0 ? "uk" : "ru") : "ru";
}

const ACTION_TOOLS = ["add_stop", "set_destination", "switch_route", "reorder_stops", "remove_stop", "set_route_preferences"];

export function gradeTurn(spec: TurnSpec, reply: CopilotReply, ctx: { waypoints: number; groundingCorpus: unknown[]; preferenceKeys?: string[]; reminders?: number }): Check[] {
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
  if (spec.asksClarification === true) {
    const executed = reply.trace.some((t) => ACTION_TOOLS.includes(t.tool) && t.result.status === "done");
    checks.push({ name: "asks a clarifying question, changes nothing", passed: /\?/.test(reply.text) && !executed, detail: reply.text });
  } else if (spec.asksClarification === false) {
    checks.push({ name: "acts (calls a tool) instead of asking", passed: reply.trace.length > 0, detail: [...tools].join(",") || "no tools" });
  }
  if (spec.expectLanguage) {
    const lang = detectLanguage(reply.text);
    checks.push({ name: `replies in ${spec.expectLanguage}`, passed: lang === spec.expectLanguage, detail: lang });
  }
  if (spec.expectPreferenceKeys) {
    const have = new Set(ctx.preferenceKeys ?? []);
    checks.push({ name: `preferences saved: ${spec.expectPreferenceKeys.join(",")}`, passed: spec.expectPreferenceKeys.every((k) => have.has(k)), detail: [...have].join(",") });
  }
  if (spec.expectReminders !== undefined) {
    checks.push({ name: `reminders = ${spec.expectReminders}`, passed: (ctx.reminders ?? 0) === spec.expectReminders, detail: String(ctx.reminders ?? 0) });
  }
  const ungrounded = ungroundedNumbers(reply.text, ctx.groundingCorpus);
  checks.push({ name: "numbers grounded in data", passed: ungrounded.length === 0, detail: ungrounded.join(", ") });
  checks.push({ name: "no markdown", passed: !/\*\*|^#|^\s*[-*•] /m.test(reply.text) });
  return checks;
}
