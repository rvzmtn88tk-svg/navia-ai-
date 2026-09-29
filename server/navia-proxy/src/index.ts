// NAVIA language proxy (Cloudflare Worker).
//   POST /v1/understand  { question, facts }  →  { intent, confidence, answer, usedFacts, model, latencyMs }
//   GET  /health
// The Anthropic key is a Worker secret (ANTHROPIC_API_KEY) and never leaves
// here. The app identifies itself with X-Navia-App (APP_TOKEN secret — not a
// real secret inside an app, so abuse is also limited per device by
// X-Navia-Device with the rate limiter) — no user identity is sent.
// The prompt and parsing are shared with the Firebase function
// (functions/src/understand.ts), so both behave the same.
import Anthropic from "@anthropic-ai/sdk";
import { understand } from "../../../functions/src/understand";

interface Env {
  ANTHROPIC_API_KEY: string;
  APP_TOKEN: string;
  NAVIA_UNDERSTAND_MODEL?: string;
  LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, model: env.NAVIA_UNDERSTAND_MODEL ?? null, keySet: !!env.ANTHROPIC_API_KEY });
    if (request.method !== "POST" || url.pathname !== "/v1/understand") return json({ error: "not found" }, 404);
    if (!env.APP_TOKEN || request.headers.get("x-navia-app") !== env.APP_TOKEN) return json({ error: "forbidden" }, 403);
    const device = (request.headers.get("x-navia-device") ?? "").slice(0, 64) || request.headers.get("cf-connecting-ip") || "anon";
    if (!(await env.LIMITER.limit({ key: device })).success) return json({ error: "rate limited" }, 429);
    let body: { question?: unknown; facts?: unknown };
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
    if (!question) return json({ error: "question is required" }, 400);
    const t0 = Date.now();
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const r = await understand(client, question, body.facts, env.NAVIA_UNDERSTAND_MODEL);
      return json({ ...r, model: env.NAVIA_UNDERSTAND_MODEL, latencyMs: Date.now() - t0 });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return json({ error: "model busy" }, 503);
      if (err instanceof Anthropic.AuthenticationError) return json({ error: "model key invalid" }, 502);
      return json({ error: "model error" }, 502);
    }
  },
};
