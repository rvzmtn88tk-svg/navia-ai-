# Guidance voice: options (phase 10a)

Goal: natural Ukrainian female and male voices for turn prompts, within the ~$20/month test budget, with the iPhone's built-in voice as the offline fallback.

Current state (30.09.2026): **Azure Neural TTS chosen and wired** (owner asked for a natural, non-robotic male voice).

- Proxy: `POST /v1/tts {text, lang, gender}` in `server/navia-proxy/src/tts.ts` → MP3. Voices: uk-UA-OstapNeural (male), uk-UA-PolinaNeural (female); Russian text (ы/э/ъ/ё) → ru-RU-DmitryNeural / SvetlanaNeural; English → en-US Andrew / Ava Multilingual. Auth `Bearer <APP_TOKEN>`, TTS_LIMITER 60/min per device. `/health` reports `tts: true|false`.
- App: `apps/mobile/src/voice/cloudVoice.ts` — each phrase is cached on the phone (`cacheDirectory/navia-tts/`, SHA-256 of voice+text); wait budget 1.5 s for prompts, 3 s for co-pilot answers, 4 s for the Settings preview; a download that arrives late is still cached. Any failure → the iPhone voice (`VoiceGuide.speak`), so speech never goes silent. The old pitch-lowered "male" voice was removed (it sounded robotic).
- Status: **UNAVAILABLE until the owner adds the key**: portal.azure.com → Speech resource, region West Europe, tier Free F0 → KEY 1 → `cd server/navia-proxy && npx wrangler secret put AZURE_SPEECH_KEY`. No app reinstall is needed after that.

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

## Decision

Azure chosen (explicit uk-UA male + female, free tier 0.5M characters/month). ElevenLabs remains the option if even more realism is wanted later — it would plug into the same `/v1/tts` route.
