// NAVIA AI backend HTTP server.
//
//   POST /v1/copilot/complete   one LLM step of the on-device co-pilot loop
//   GET  /healthz               liveness + which models the tiers map to
//
// Run: ANTHROPIC_API_KEY=... npm start -w @navia/ai-backend
// Put it behind TLS (a reverse proxy or your platform's HTTPS) in production.

import { createServer, type IncomingMessage } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { COPILOT_PROTOCOL_VERSION } from "@navia/core";
import { loadConfig } from "./config";
import { AnthropicLLMClient } from "./anthropic-llm-client";
import { handleCompletion, LIMITS, RateLimiter } from "./handler";

const config = loadConfig();
const llm = new AnthropicLLMClient(new Anthropic({ timeout: 45_000, maxRetries: 1 }), config);
const limiter = new RateLimiter(config.rateLimitPerMinute);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxBodyBytes) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(200, { ok: true, protocolVersion: COPILOT_PROTOCOL_VERSION, tiers: { fast: config.fastModel, smart: config.smartModel } });
    }
    if (req.method === "POST" && req.url === "/v1/copilot/complete") {
      const key = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (!limiter.allow(key)) return send(429, { error: "rate limited" });
      const body = await readJson(req);
      const controller = new AbortController();
      req.on("close", () => { if (!res.writableEnded) controller.abort(); });
      const result = await handleCompletion(body, req.headers.authorization, { llm, clientToken: config.clientToken, signal: controller.signal });
      return send(result.status, result.body);
    }
    return send(404, { error: "not found" });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return send(status, { error: status === 500 ? "internal error" : (e as Error).message });
  }
});

server.listen(config.port, () => {
  console.log(`NAVIA AI backend listening on :${config.port} (fast=${config.fastModel}, smart=${config.smartModel}, effort=${config.smartEffort})`);
});
