# NAVIA language proxy

A Cloudflare Worker between the phone and the language model. The phone sends
the question and the Context Snapshot facts (no coordinates, nothing that
identifies the person). The Worker asks Claude and returns what was asked, a
short answer and the facts it used. The Anthropic key exists only here, as a
Worker secret. The app never calls the model provider and holds no key.

```
POST /v1/understand   headers: X-Navia-App, X-Navia-Device
  { "question": "...", "facts": { ... } }
→ { "intent", "confidence", "answer", "usedFacts", "usage", "model", "latencyMs" }
GET  /health          → { "ok", "model", "keySet" }
```

The prompt and the parsing live in `functions/src/understand.ts`, shared with
the Firebase function.
- The prompt forbids the model from inventing any fact about the person's
  situation (position, distances, GPS, alerts, shelters, network).
- Such facts may come only from `<facts>`.
- The phone then checks the model's wording against its own snapshot
  (`apps/mobile/src/ai/navigator/grounding.ts`). If a fact is not in the
  snapshot, the answer is built by the phone's own handler for that intent.

## Provider, model, limits

| | |
|---|---|
| Provider | Anthropic (Claude API) |
| Model | `claude-haiku-4-5-20251001` (var `NAVIA_UNDERSTAND_MODEL` in `wrangler.toml`) |
| Max answer | 300 tokens (1–3 short sentences) |
| Phone timeout | 3 s, then the on-device rules answer |
| Rate limit | 20 questions / minute per device (`[[ratelimits]]` in `wrangler.toml`), then 429 |
| App check | `X-Navia-App` must equal the `APP_TOKEN` secret, else 403 |

What each request costs is measured, not estimated: every response carries
`usage` (input, output and cache-read tokens), and
`apps/mobile/scripts/evalLanguageModel.ts` turns that into an average price
per question. At Haiku 4.5 list prices ($1 / M input tokens, $5 / M output
tokens), a question is about 1.5–2.5 k input tokens (the prompt plus the
facts) and about 100–200 output tokens. That is roughly $0.002–0.003 per
question, or about $2–3 per 1,000 questions. Replace this estimate with the
measured number after the first run.

Cloudflare Workers free plan: 100,000 requests a day.

Deployed: https://navia-proxy.navia-ua.workers.dev (the owner's Cloudflare account, 2026-09-29).

## Deploy (once, about 10 minutes)

What the owner needs:
- an Anthropic API key with credit (console.anthropic.com → API keys;
  prepaid credit, $5 is enough for thousands of questions);
- a Cloudflare account (free).

```bash
cd server/navia-proxy
npm install
npx wrangler login                        # opens the browser, Cloudflare account
npx wrangler secret put ANTHROPIC_API_KEY # paste the key; stored by Cloudflare only
openssl rand -hex 24 | npx wrangler secret put APP_TOKEN
npx wrangler deploy                       # prints https://navia-proxy.<account>.workers.dev
curl https://navia-proxy.<account>.workers.dev/health   # {"ok":true,...,"keySet":true}
```

Then build the app with the proxy address and the app token. These are not
provider keys; the token only makes casual abuse harder:

```bash
EXPO_PUBLIC_NAVIA_AI_PROXY_URL=https://navia-proxy.<account>.workers.dev \
EXPO_PUBLIC_NAVIA_AI_APP_TOKEN=<the APP_TOKEN value> \
npx expo run:ios --configuration Release --device
```

Acceptance run: 12 control + 34 off-topic questions. It writes the answers
word for word before and after, plus latency and cost, to
`apps/mobile/test/reports/llm-eval.md`:

```bash
NAVIA_AI_PROXY_URL=https://navia-proxy.<account>.workers.dev \
NAVIA_AI_APP_TOKEN=<token> npx tsx apps/mobile/scripts/evalLanguageModel.ts
```

## Local run (no real key)

`.dev.vars` (not committed) holds a fake key and `APP_TOKEN=local-test-token`.

```bash
npx wrangler dev --port 8787 --local
```

Expected results:
- `/health` answers.
- A call without the token → 403.
- A call with it → 502 "model key invalid". The path reaches Anthropic and
  the key is refused.
- The 21st call in a minute → 429.
- The app shows «Базовий режим» and Diagnostics gives the reason.
