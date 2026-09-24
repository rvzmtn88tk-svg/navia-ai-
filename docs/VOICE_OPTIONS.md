# Guidance voice: options (phase 10a)

Goal: natural Ukrainian female and male voices for turn prompts, within the ~$20/month test budget, with the iPhone's built-in voice as the offline fallback.

Current state: prompts use the iPhone system voice through `apps/mobile/src/voice/VoiceGuide.ts` (one `speak()` entry point, music ducked, interruptions handled). A neural voice plugs in behind the same call; phrasing and timing (`voice/guidance.ts`) do not change.

## Candidates

| Provider | Ukrainian quality | Female + male | Notes |
|---|---|---|---|
| ElevenLabs | Very natural (multilingual models) | Yes, many voices | Strongest realism; per-character pricing — verify current plan limits against the budget. |
| OpenAI TTS | Natural, slight accent on some words | Voice set is gender-neutral-ish; pick one of each | Simple API; same key could serve other features. |
| Google Cloud Text-to-Speech | Good (Neural2/WaveNet uk-UA) | Limited uk-UA voice list — check male availability | Fits with Firebase (same Google account); generous free tier. |
| Azure Neural TTS | Good (uk-UA Polina / Ostap) | Yes (female Polina, male Ostap) | Explicit uk-UA male + female; free tier for testing. |

Prices change often; confirm on each provider's pricing page before choosing.

## Architecture (all options)

- The key stays on the server: a Firebase function turns text into audio (same pattern as `functions/src/index.ts`).
- Cache: the ~200 most frequent phrases ("Поверніть праворуч.", "Через 300 метрів…", "Ви прибули.") are generated once per voice and bundled; street-specific phrases are cached on the phone after the first use.
- No network, timeout (> 1.5 s) or error → the iPhone system voice speaks immediately, so guidance never goes silent.
- Audio ducking: already configured (`DuckOthers`) — music lowers during a prompt instead of stopping.

## Decision needed from the owner

1. Which provider to trial (recommendation: Azure for guaranteed uk-UA female + male within free tier, ElevenLabs if realism matters most).
2. Listen to samples of 2–3 voices before wiring the chosen one.
