# NAVIA AI audit: where the "understanding" really happens

Date: 2026-09-29. The question: how much of NAVIA AI is real language
understanding and reasoning, and how much is keyword matching, regex,
intent → response tables and templates that only *look* intelligent?

## Findings — before this round of work

| Where | What it is | Role before |
|---|---|---|
| `packages/core/src/ai-engine.ts` — `DeterministicDemoAIProvider.answer` | 4 regex intent buckets (position / next turn / progress / GNSS) + landmark token match + one catch-all sentence ("Я можу розповісти про вашу позицію, GNSS…") | **The default answer path in the app**: the smart co-pilot ran only if the driver found and switched on a consent toggle that was **off by default** on the Home screen, so a new driver got templates. Answers "what to do without GPS" with a GPS status sentence; treats "I see Fora, where next?" as a generic turn question. |
| `packages/core/src/copilot/local-place-intent.ts` | ~15 regexes: category stems, 5 brands, "біля місця призначення", "не більше N хв", "N км пального", "відчинено" → one search | Offline fallback when the LLM is unreachable |
| `packages/core/src/copilot/model-router.ts` | Structural signals (message length, tool count, errors) | Chooses cheap vs. strong model; not language understanding |
| `packages/core/src/landmark-engine.ts`, `geocoder.ts` | Token matching of place names | Data lookup behind tools (legitimate: matching a name against map data) |
| `copilot/copilot.ts` — `toSpeakable` | Regex removing markdown/ids | Output formatting only |
| `apps/mobile/src/components/VoicePanel.tsx` — `DEMO_INTENTS` | Canned question buttons | Demo Mode only, labelled |
| LLM co-pilot (`NaviaCopilot`, 14 tools, `<trip_state>`, confirmation gate) | Real tool-calling loop | Existed, but: no structured memory beyond the last result list (so "remove it again" had nothing to refer to), one pending action at a time (a two-step plan overwrote itself), no place-details / time-cost tool, no preferences, no reminders or proactive layer, no driving context, one provider only, no hands-free voice, 28 eval scenarios. |

Measured, not assumed: the old deterministic system was run on the new
evaluation suites with the same behavioural checks (`npm run eval:ai --
--suite all --baseline-local`):

| Suite | Deterministic system (before) |
|---|---|
| legacy 28 | 8/28 |
| dev 264 | 99/264 (37.5%) — preferences 0/8, reminders 0/6, multi-step 3/15, route changes 2/13, references 6/20 |
| holdout 59 | 25/59 |

Its "passes" are mostly information questions where a generic sentence
happens to satisfy lenient checks (it changed nothing and said no false
number). It cannot plan, resolve references, change the trip, remember or
generalise.

## What changed

**The LLM is now the understanding layer, and the regex code is only a
fallback.**

1. **Nothing understands a phrase by keyword on the main path.** A driver
   message goes to the LLM with the live `<trip_state>`, and the model
   chooses tools. No new intent, phrase or template was added anywhere. The
   system prompt was rewritten as general rules (references, actions,
   clarification, preferences, events, GPS/internet, driving style) with no
   phrase → answer table.
2. **The consent prompt is up-front.** On first use the voice panel asks
   once and remembers the answer. Consent still defaults to *not sending*
   trip context, as privacy requires; it is no longer hidden.
3. **Structured memory instead of keyword tricks for follow-ups:**
   - numbered result lists (plus the previous list);
   - a focus entity;
   - an action log where each action carries its exact undo;
   - pending *plans* confirmed together;
   - reminders;
   - long-term preferences.

   "The second one", "remove it again", "not this one, the next" and "coffee
   first, then home" are resolved by the model from this state. None of them
   exists as code.
4. **Tool policies** (read / safe action / confirm) decide what may run
   without asking. A confirm action runs directly only when the driver
   orders it having already heard its impact, and the code verifies that part.
5. **Kept deliberately:**
   - `DeterministicDemoAIProvider` and `local-place-intent` remain as the
     **offline / no-consent fallback** for basic navigation questions and
     the commonest place searches. Their answers were corrected to use real
     data (distance *to* the maneuver, what NAVIA does without GPS). They are
     prefixed "Розумний режим штурмана зараз недоступний."
   - The wake word ("Навіа…") uses a fixed word list. That's an addressing
     signal, not language understanding.

## What still depends on infrastructure

Real LLM reasoning needs the model API behind `apps/ai-backend` (the key
lives on the server, never in the app or Git). Without it, NAVIA falls back
to the deterministic layer above, and says so. See
`docs/AI_COPILOT.md` → "Required APIs".
