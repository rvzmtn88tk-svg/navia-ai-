// Live evaluation of the NAVIA co-pilot against the real Claude API.
//
//   ANTHROPIC_API_KEY=... npm run eval:ai                 # all scenarios, auto tier routing
//   npm run eval:ai -- --only mcdonalds-10min-add,no-kfc  # a subset
//   npm run eval:ai -- --policy always_smart              # compare routing policies
//   npm run eval:ai -- --dry-run                          # no API calls: checks worlds + prompt sizes
//
// Each scenario runs the real NaviaCopilot loop with the real tools over the
// demo trip world; only the LLM is live. Grading is deterministic (see
// packages/core/eval/grader.ts). Writes a JSON report to eval/reports/.
// Every run spends real API credit — roughly $0.01–0.03 per scenario with
// the default fast/smart models.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  NaviaCopilot, COPILOT_SYSTEM_PROMPT, COPILOT_TOOLS, buildTripSnapshot, LLMUnavailableError,
  type CompletionRequest, type CompletionResponse, type LLMClient, type RouterPolicy, DEFAULT_ROUTER_POLICY, type Usage,
} from "@navia/core";
import { SCENARIOS, type Scenario } from "../../../packages/core/eval/scenarios";
import { buildWorld } from "../../../packages/core/eval/world";
import { gradeTurn, type Check } from "../../../packages/core/eval/grader";
import { AnthropicLLMClient } from "../src/anthropic-llm-client";
import { loadConfig } from "../src/config";

// USD per million tokens (Claude API list prices, 2026-09). Verify before relying on totals.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

function costUsd(model: string, u: Usage): number | null {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return null;
  const p = PRICES[key]!;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

/** Wraps the real client to record every request/response (for grounding + per-call cost). */
class RecordingLLM implements LLMClient {
  calls: { request: CompletionRequest; response: CompletionResponse; ms: number }[] = [];
  constructor(private inner: LLMClient) {}
  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const t0 = Date.now();
    const response = await this.inner.complete(request, signal);
    this.calls.push({ request, response, ms: Date.now() - t0 });
    return response;
  }
}

class OfflineLLM implements LLMClient {
  async complete(): Promise<CompletionResponse> { throw new LLMUnavailableError("dry run: no API calls", false); }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const policyMode = get("--policy") as RouterPolicy["mode"] | undefined;
  return {
    dryRun: argv.includes("--dry-run"),
    only: get("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    policy: { ...DEFAULT_ROUTER_POLICY, ...(policyMode ? { mode: policyMode } : {}) },
  };
}

type TurnReport = {
  user: string; answer: string; mode: string; tiers: string[]; models: string[]; tools: string[];
  latencyMs: number; usage: Usage; costUsd: number | null; checks: Check[]; passed: boolean;
};

async function runScenario(s: Scenario, llmFactory: () => LLMClient, policy: RouterPolicy) {
  const world = await buildWorld(s.world);
  const recorder = new RecordingLLM(llmFactory());
  const copilot = new NaviaCopilot({ runtime: world.runtime, llm: recorder, aiEnabled: () => true, routerPolicy: policy });
  const turns: TurnReport[] = [];
  const earlierAnswers: string[] = [];
  for (const spec of s.turns) {
    const before = recorder.calls.length;
    const reply = await copilot.ask(spec.user);
    const thisTurn = recorder.calls.slice(before);
    const corpus: unknown[] = [spec.user, ...earlierAnswers, ...thisTurn.map((c) => JSON.stringify(c.request.messages)), ...reply.trace.map((t) => t.result)];
    const checks = gradeTurn(spec, reply, { waypoints: world.host.route?.waypointCount ?? 0, groundingCorpus: corpus });
    const cost = thisTurn.reduce<number | null>((acc, c) => {
      const x = costUsd(c.response.model, c.response.usage);
      return acc == null || x == null ? null : acc + x;
    }, 0);
    turns.push({
      user: spec.user, answer: reply.text, mode: reply.mode, tiers: reply.tiers, models: reply.models,
      tools: reply.trace.map((t) => t.tool), latencyMs: reply.latencyMs, usage: reply.usage, costUsd: cost,
      checks, passed: checks.every((c) => c.passed),
    });
    earlierAnswers.push(reply.text);
  }
  const extra: Check[] = [];
  if (s.expectDestinationMatches) {
    const label = world.planner.getPlan().destination?.label ?? "";
    extra.push({ name: `destination ${s.expectDestinationMatches}`, passed: s.expectDestinationMatches.test(label), detail: label });
  }
  return { id: s.id, category: s.category, title: s.title, turns, extra, passed: turns.every((t) => t.passed) && extra.every((c) => c.passed) };
}

async function main() {
  const args = parseArgs();
  const scenarios = SCENARIOS.filter((s) => !args.only || args.only.includes(s.id));
  const promptChars = COPILOT_SYSTEM_PROMPT.length + JSON.stringify(COPILOT_TOOLS).length;
  console.log(`Scenarios: ${scenarios.length}. Static prompt (system + ${COPILOT_TOOLS.length} tools): ${promptChars} chars (~${Math.round(promptChars / 4)} tokens).`);

  if (args.dryRun) {
    for (const s of scenarios) {
      const w = await buildWorld(s.world);
      const copilot = new NaviaCopilot({ runtime: w.runtime, llm: new OfflineLLM(), aiEnabled: () => true });
      const snap = buildTripSnapshot(w.runtime, copilot.session);
      const r = await copilot.ask(s.turns[0]!.user);
      console.log(`- ${s.id.padEnd(24)} world ok, trip_state ${snap.length} chars; offline fallback: "${r.text.slice(0, 70)}…"`);
    }
    console.log("Dry run complete (no API calls made).");
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("No Claude API credential found. Set ANTHROPIC_API_KEY (or run `ant auth login`) to run the live eval, or use --dry-run.");
    process.exit(2);
  }
  const config = loadConfig();
  const sdk = new Anthropic({ timeout: 60_000, maxRetries: 2 });
  const factory = () => new AnthropicLLMClient(sdk, config);

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`${s.id.padEnd(26)}`);
    try {
      const r = await runScenario(s, factory, args.policy);
      results.push(r);
      const ms = r.turns.reduce((a, t) => a + t.latencyMs, 0);
      const cost = r.turns.reduce((a, t) => a + (t.costUsd ?? 0), 0);
      console.log(`${r.passed ? "PASS" : "FAIL"}  ${String(ms).padStart(6)} ms  $${cost.toFixed(4)}  tiers=${r.turns.map((t) => t.tiers.join(">")).join(" | ")}`);
      for (const t of r.turns) {
        for (const c of t.checks.filter((c) => !c.passed)) console.log(`    ✗ [${t.user.slice(0, 30)}] ${c.name}${c.detail ? ` (${c.detail.slice(0, 120)})` : ""}`);
        console.log(`    → ${t.answer}`);
      }
      for (const c of r.extra.filter((c) => !c.passed)) console.log(`    ✗ ${c.name} (${c.detail ?? ""})`);
    } catch (e) {
      console.log(`ERROR ${(e as Error).message}`);
      results.push({ id: s.id, category: s.category, title: s.title, error: (e as Error).message, passed: false });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const allTurns = results.flatMap((r) => ("turns" in r ? r.turns : []));
  const latencies = allTurns.map((t) => t.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;
  const totalCost = allTurns.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const summary = {
    passed, total: results.length, turns: allTurns.length,
    latencyMs: { p50: pct(0.5), p90: pct(0.9), max: latencies[latencies.length - 1] ?? 0 },
    costUsd: { total: totalCost, perTurn: allTurns.length ? totalCost / allTurns.length : 0 },
    fastOnlyTurns: allTurns.filter((t) => t.tiers.length > 0 && t.tiers.every((x) => x === "fast")).length,
    models: { fast: config.fastModel, smart: config.smartModel, smartEffort: config.smartEffort }, policy: args.policy.mode,
  };
  console.log(`\n${passed}/${results.length} scenarios passed · p50 ${summary.latencyMs.p50} ms · p90 ${summary.latencyMs.p90} ms · $${totalCost.toFixed(4)} total · ${summary.fastOnlyTurns}/${allTurns.length} turns fast-only`);

  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, "reports", `live-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report: ${out}`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
