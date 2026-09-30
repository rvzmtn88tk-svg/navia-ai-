// Model-in-the-loop runner: plays an eval scenario through the real
// NaviaCopilot + real tools, with the LLM's decisions read from a transcript
// file (packages/core/eval/transcripts/<id>.json). When the transcript runs
// out, it prints exactly what the model would see next (trip_state + driver
// text, or the tool results) and stops, so a decider — a human, or another
// model — can append the next decision and re-run. The world is fully
// deterministic, so each run replays the transcript from scratch.
//
//   npx tsx packages/core/eval/model-in-the-loop.ts <scenario-id>
//
// Completed transcripts are replayed and graded by test/eval-transcripts.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NaviaCopilot, SELF_CHECK_PREFIX, type CopilotReply } from "../src/copilot/copilot";
import { LLMUnavailableError, type CompletionRequest, type CompletionResponse, type ContentBlock, type LLMClient } from "../src/copilot/protocol";
import { SCENARIOS, type Scenario } from "./scenarios";
import { DEV_SUITE } from "./suite/dev";
import { HOLDOUT_SUITE } from "./suite/holdout";

const ALL: Scenario[] = [...SCENARIOS, ...DEV_SUITE, ...HOLDOUT_SUITE];
import { buildWorld } from "./world";
import { gradeTurn, tripStatesOf, type Check } from "./grader";

export type Decision = { tools: { name: string; input: Record<string, unknown> }[] } | { text: string };
export type Transcript = {
  scenario: string;
  /** Who produced the decisions, e.g. "claude-opus-5-5 via Claude Code session (manual model-in-the-loop)". */
  decider: string;
  /** One array of LLM-call decisions per driver turn. */
  turns: Decision[][];
};

export const TRANSCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "transcripts");

export function loadTranscript(id: string): Transcript | null {
  const p = join(TRANSCRIPT_DIR, `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Transcript) : null;
}

class NeedDecision extends LLMUnavailableError {
  constructor(readonly request: CompletionRequest) { super("transcript exhausted: decision needed", false); }
}

function isSelfCheck(request: CompletionRequest): boolean {
  const last = request.messages[request.messages.length - 1];
  const content = last?.content;
  return last?.role === "user" && Array.isArray(content) && content.some((b) => b.type === "text" && typeof (b as { text?: unknown }).text === "string" && ((b as { text: string }).text).startsWith(SELF_CHECK_PREFIX));
}

/** Replays one turn's decisions; throws NeedDecision (caught by the copilot) when they run out. */
export class ReplayLLM implements LLMClient {
  private turnIndex = -1;
  private callIndex = 0;
  private seq = 0;
  needed: CompletionRequest | null = null;
  readonly requests: CompletionRequest[] = [];

  constructor(private transcript: Transcript) {}

  startTurn(i: number): void { this.turnIndex = i; this.callIndex = 0; }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    let decision = this.transcript.turns[this.turnIndex]?.[this.callIndex++];
    // A recording made before NAVIA's self-check has no answer to it: replay the
    // model as not complying (its last words again), so the grader judges the
    // recorded behaviour as it was. Live runs show what the check changes.
    if (!decision && isSelfCheck(request)) {
      const turn = this.transcript.turns[this.turnIndex] ?? [];
      decision = [...turn].reverse().find((d) => "text" in d);
    }
    if (!decision) { this.needed = request; throw new NeedDecision(request); }
    const content: ContentBlock[] = "text" in decision
      ? [{ type: "text", text: decision.text }]
      : decision.tools.map((t) => ({ type: "tool_use", id: `tu_${++this.seq}`, name: t.name, input: t.input }));
    return {
      content,
      stopReason: "text" in decision ? "end_turn" : "tool_use",
      model: "transcript-replay",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

export type TurnResult = { user: string; reply: CopilotReply; checks: Check[]; requests: CompletionRequest[] };

export async function replayScenario(s: Scenario, transcript: Transcript): Promise<{ turns: TurnResult[]; needed: CompletionRequest | null; neededTurn: number; extra: Check[] }> {
  const world = await buildWorld(s.world);
  const llm = new ReplayLLM(transcript);
  const copilot = new NaviaCopilot({ runtime: world.runtime, llm, aiEnabled: () => true });
  const turns: TurnResult[] = [];
  const earlier: string[] = [];
  for (let i = 0; i < s.turns.length; i++) {
    const spec = s.turns[i]!;
    llm.startTurn(i);
    const before = llm.requests.length;
    const reply = await copilot.ask(spec.user);
    if (llm.needed) return { turns, needed: llm.needed, neededTurn: i, extra: [] };
    const corpus: unknown[] = [spec.user, ...earlier, ...tripStatesOf(llm.requests.slice(before)), ...reply.trace.map((t) => t.result)];
    const prefs = world.runtime.preferences();
    turns.push({
      user: spec.user, reply, requests: llm.requests.slice(before),
      checks: gradeTurn(spec, reply, {
        waypoints: world.host.route?.waypointCount ?? 0, groundingCorpus: corpus,
        preferenceKeys: prefs ? [...prefs.all().keys()] : [], reminders: copilot.session.reminders.length,
      }),
    });
    earlier.push(reply.text);
  }
  const extra: Check[] = [];
  if (s.expectDestinationMatches) {
    const label = world.planner.getPlan().destination?.label ?? "";
    extra.push({ name: `destination ${s.expectDestinationMatches}`, passed: s.expectDestinationMatches.test(label), detail: label });
  }
  return { turns, needed: null, neededTurn: -1, extra };
}

function describeRequest(req: CompletionRequest): string {
  const last = req.messages[req.messages.length - 1]!;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const lines = [`--- model input (tier=${req.tier}, ${req.messages.length} messages) ---`];
  if (req.messages.length > 1 && blocks.some((b) => b.type === "text")) {
    lines.push("history:");
    for (const m of req.messages.slice(0, -1)) {
      if (typeof m.content === "string") lines.push(`  ${m.role}: ${m.content}`);
    }
  }
  for (const b of blocks) {
    if (b.type === "text") lines.push((b as { text: string }).text);
    if (b.type === "tool_result") lines.push(`tool_result${(b as { is_error?: boolean }).is_error ? " (ERROR)" : ""}: ${(b as { content: string }).content}`);
  }
  return lines.join("\n");
}

/**
 * Rough per-call cost from actual request sizes. Token counts are estimated
 * from characters (≈3 chars/token for this Ukrainian/English mix) — use the
 * live eval for real usage numbers. Assumes: fast tier uncached (Haiku 4.5
 * caches only prompts ≥4096 tokens), smart tier reads the static prefix from
 * cache, and each smart call spends ~300 thinking tokens.
 */
export function estimateCallCostUsd(req: CompletionRequest, outputChars: number, staticChars: number): { inTok: number; outTok: number; usd: number } {
  const msgTok = JSON.stringify(req.messages).length / 3;
  const staticTok = staticChars / 3;
  const outTok = outputChars / 3 + (req.tier === "smart" ? 300 : 0);
  const usd = req.tier === "fast"
    ? ((staticTok + msgTok) * 1 + outTok * 5) / 1e6
    : (staticTok * 0.2 + msgTok * 4 + outTok * 20) / 1e6;
  return { inTok: Math.round(staticTok + msgTok), outTok: Math.round(outTok), usd };
}

/** Holdout transcripts (the model-in-the-loop sample): pass/fail per scenario, never used for tuning. */
async function summarizeHoldout() {
  let pass = 0, have = 0;
  for (const s of HOLDOUT_SUITE) {
    const t = loadTranscript(s.id);
    if (!t) continue;
    have++;
    const r = await replayScenario(s, t);
    const ok = !r.needed && r.turns.every((x) => x.checks.every((c) => c.passed)) && r.extra.every((c) => c.passed);
    if (ok) pass++;
    const failed = r.turns.flatMap((x) => x.checks.filter((c) => !c.passed).map((c) => c.name));
    console.log(`${s.id.padEnd(28)}${(r.needed ? "INCOMPLETE" : ok ? "PASS" : "FAIL").padEnd(11)}${s.category.padEnd(14)}${failed.join("; ")}`);
  }
  console.log(`\nholdout sample: ${pass}/${have} pass (of ${HOLDOUT_SUITE.length} holdout scenarios)`);
}

async function summarizeAll() {
  const { COPILOT_SYSTEM_PROMPT } = await import("../src/copilot/system-prompt");
  const { COPILOT_TOOLS } = await import("../src/copilot/tool-definitions");
  const staticChars = COPILOT_SYSTEM_PROMPT.length + JSON.stringify(COPILOT_TOOLS).length;
  let pass = 0, turnsTotal = 0, callsTotal = 0, fastOnly = 0, usdTotal = 0;
  console.log("scenario                  result  turns  calls  tiers                         est.in_tok  est.$");
  for (const s of SCENARIOS) {
    const t = loadTranscript(s.id);
    if (!t) { console.log(`${s.id.padEnd(26)}MISSING`); continue; }
    const r = await replayScenario(s, t);
    const ok = !r.needed && r.turns.every((x) => x.checks.every((c) => c.passed)) && r.extra.every((c) => c.passed);
    if (ok) pass++;
    let calls = 0, inTok = 0, usd = 0;
    const tiers: string[] = [];
    r.turns.forEach((turn, ti) => {
      turnsTotal++;
      if (turn.reply.tiers.every((x) => x === "fast")) fastOnly++;
      tiers.push(turn.reply.tiers.map((x) => x[0]).join(""));
      const decisions = t.turns[ti] ?? [];
      turn.reply.tiers.forEach((tier, ci) => {
        const d = decisions[ci];
        const outChars = d ? JSON.stringify(d).length : 0;
        const req = turn.requests[ci];
        if (req) { const e = estimateCallCostUsd(req, outChars, staticChars); inTok += e.inTok; usd += e.usd; }
        calls++;
        void tier;
      });
    });
    callsTotal += calls; usdTotal += usd;
    console.log(`${s.id.padEnd(26)}${(ok ? "PASS" : "FAIL").padEnd(8)}${String(r.turns.length).padStart(5)}${String(calls).padStart(7)}  ${tiers.join(" | ").padEnd(30)}${String(inTok).padStart(10)}  ${usd.toFixed(4)}`);
  }
  console.log(`\n${pass}/${SCENARIOS.length} scenarios pass · ${turnsTotal} turns · ${callsTotal} LLM calls · ${fastOnly}/${turnsTotal} turns fast-tier only · est. $${usdTotal.toFixed(3)} total, $${(usdTotal / Math.max(1, turnsTotal)).toFixed(4)} per turn`);
  console.log("tiers: f = fast (Haiku 4.5), s = smart (Opus 5.5). Costs are character-based estimates; run npm run eval:ai for measured usage.");
}

async function main() {
  if (process.argv[2] === "--all") return summarizeAll();
  if (process.argv[2] === "--holdout") return summarizeHoldout();
  const id = process.argv[2];
  const s = ALL.find((x) => x.id === id);
  if (!s) {
    console.error(`usage: model-in-the-loop.ts <scenario-id> | --all | --holdout\n${ALL.map((x) => `  ${x.id}`).join("\n")}`);
    process.exit(2);
  }
  const t = loadTranscript(s.id) ?? { scenario: s.id, decider: "unset", turns: [] };
  const r = await replayScenario(s, t);
  for (const turn of r.turns) {
    console.log(`TURN "${turn.user}" -> ${turn.reply.text}`);
    for (const c of turn.checks) console.log(`   ${c.passed ? "✓" : "✗"} ${c.name}${!c.passed && c.detail ? ` (${c.detail.slice(0, 200)})` : ""}`);
  }
  for (const c of r.extra) console.log(`   ${c.passed ? "✓" : "✗"} ${c.name} (${c.detail ?? ""})`);
  if (r.needed) {
    console.log(`\nNEED DECISION for turn ${r.neededTurn} ("${s.turns[r.neededTurn]!.user}")`);
    console.log(describeRequest(r.needed));
  } else {
    const ok = r.turns.every((x) => x.checks.every((c) => c.passed)) && r.extra.every((c) => c.passed);
    console.log(`\nSCENARIO ${ok ? "PASS" : "FAIL"}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
