// Model gateway: picks the LLM provider behind the co-pilot from config.
// Adding a provider = one LLMClient implementation + one case here; the
// co-pilot loop, tools, prompt and the app are unchanged.
//
// Credentials are read from the backend's environment only:
//   anthropic          ANTHROPIC_API_KEY (read by the Anthropic SDK)
//   openai_compatible  NAVIA_OPENAI_API_KEY + NAVIA_OPENAI_BASE_URL + NAVIA_AI_MODEL_FAST/SMART

import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "@navia/core";
import type { BackendConfig } from "./config";
import { AnthropicLLMClient } from "./anthropic-llm-client";
import { OpenAICompatibleLLMClient } from "./openai-compatible-llm-client";

export function createLLMClient(config: BackendConfig, env: NodeJS.ProcessEnv = process.env): LLMClient {
  if (config.provider === "openai_compatible") {
    const apiKey = env.NAVIA_OPENAI_API_KEY?.trim();
    if (!config.openaiBaseUrl || !apiKey || !config.fastModel || !config.smartModel) {
      throw new Error("NAVIA_LLM_PROVIDER=openai_compatible needs NAVIA_OPENAI_BASE_URL, NAVIA_OPENAI_API_KEY, NAVIA_AI_MODEL_FAST and NAVIA_AI_MODEL_SMART");
    }
    return new OpenAICompatibleLLMClient({ baseUrl: config.openaiBaseUrl, apiKey, fastModel: config.fastModel, smartModel: config.smartModel, fastMaxTokens: config.fastMaxTokens, smartMaxTokens: config.smartMaxTokens });
  }
  return new AnthropicLLMClient(new Anthropic({ timeout: 45_000, maxRetries: 1 }), config);
}
