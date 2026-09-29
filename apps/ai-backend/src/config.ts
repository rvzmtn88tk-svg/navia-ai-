// Backend configuration from environment variables. The provider credential
// (ANTHROPIC_API_KEY, or any other credential source the Anthropic SDK
// resolves) is read by the SDK itself and never passes through this module.

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type BackendConfig = {
  port: number;
  /** Model for the fast tier: routine turns, single tool round, short answers. */
  fastModel: string;
  /** Model for the smart tier: multi-step planning, tool-error recovery. */
  smartModel: string;
  /** output_config.effort for the smart tier (models that support effort). */
  smartEffort: EffortLevel;
  fastMaxTokens: number;
  smartMaxTokens: number;
  /** If set, requests must carry `Authorization: Bearer <token>`. */
  clientToken: string | null;
  rateLimitPerMinute: number;
};

function env(key: string): string | null {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

function intEnv(key: string, fallback: number): number {
  const v = env(key);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export function loadConfig(): BackendConfig {
  const effort = env("NAVIA_AI_SMART_EFFORT");
  return {
    port: intEnv("PORT", 8787),
    fastModel: env("NAVIA_AI_MODEL_FAST") ?? "claude-haiku-4-5",
    smartModel: env("NAVIA_AI_MODEL_SMART") ?? "claude-opus-5-5",
    smartEffort: effort && (EFFORTS as string[]).includes(effort) ? (effort as EffortLevel) : "medium",
    fastMaxTokens: intEnv("NAVIA_AI_FAST_MAX_TOKENS", 1024),
    smartMaxTokens: intEnv("NAVIA_AI_SMART_MAX_TOKENS", 8000),
    clientToken: env("NAVIA_BACKEND_CLIENT_TOKEN"),
    rateLimitPerMinute: intEnv("NAVIA_AI_RATE_LIMIT_PER_MIN", 60),
  };
}
