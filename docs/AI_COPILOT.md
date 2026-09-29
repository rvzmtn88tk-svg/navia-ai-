# NAVIA AI co-pilot

NAVIA's AI is a general agent over the navigation stack. The driver speaks
naturally, in any wording: "бензину вже небагато", "друга норм, скільки
втратимо?", "заїдь спочатку за кавою, потім додому". The LLM works out the
goal, plans the steps and calls NAVIA's tools. The navigation stack computes
every fact and performs every action. The LLM then answers in one or two
spoken sentences, or asks one short question when it really must. No request
wording exists in the code (see `docs/AI_AUDIT.md`).

```
 voice ("Навіа, …") / mic / text
        │ speech-to-text (expo-speech-recognition, uk-UA)
        ▼
 VoiceConversation ──► NaviaCopilot.ask()                 on the phone (@navia/core)
                         │  <trip_state>: trip + position quality + memory + driving context
                         ▼
                BackendLLMClient ──HTTPS──► apps/ai-backend ──► model gateway
                         ▲                  (key, prompt, tools,   ├─ Anthropic (default)
                         │ tool_use          tier → model)          └─ OpenAI-compatible
                         ▼
                executeCopilotTool()  (policy: read / safe action / confirm)
                         │   RouteGeometry, TripPlanner → RoutingProvider, PlaceSearchProvider,
                         │   TrafficProvider, Geocoder, LandmarkEngine, PreferenceStore
                         ▼
                NavigationEngine.applyRoute()  ──►  HUD + VoiceGuidance (text-to-speech)

 ProactiveEngine (reminders, live-traffic delay) ──► NaviaCopilot.handleEvent() ──► same loop
```

## Division of labour

| Layer | Owns |
|---|---|
| **LLM** | understanding (any phrasing, slang, typos, uk/ru/en), resolving references, planning multi-step tasks, choosing tools and constraints, deciding when to ask, phrasing a short spoken answer, deciding whether a noticed event is worth saying |
| **Tools** (`copilot/tool-executor.ts`) | facts and actions; every number is computed here |
| **Navigation / location engine** | position and its quality (`LocationState`, GNSS integrity, dead reckoning), route geometry, progress, ETA, maneuvers, routing — deterministic |
| **Conversation / trip state** (`CopilotSession`, `TripPlanner`, `PreferenceStore`) | memory the model reads each turn |
| **App** | UI, voice I/O, consent, persistence |

The model never receives or produces coordinates. Places, stops, routes and
reminders are short ids (`p3`, `s1`, `r2`, `m1`) that the device maps back
to real objects; a made-up id is rejected.

## Tools and what they may do without asking

| Tool | Policy | Purpose |
|---|---|---|
| `search_along_route` | read | places ahead: category/brand, time window, distance window, max detour, range, open now, `exclude_place_ids`, `beyond_place_id` ("the next one after it"); routed detours |
| `search_near` | read | around destination / car / a found place; walking minutes |
| `get_place_details` | read | one place: hours, open now, km/min ahead, side, distance from the road, **routed time added if stopping**, is it a stop |
| `get_route_overview`, `compare_routes`, `get_traffic_ahead` | read | route facts, alternatives, live traffic (unavailable without a feed) |
| `find_destination`, `check_landmark`, `get_landmarks_ahead` | read | destinations, "I see X", recognisable places near the next turns |
| `remove_stop`, `set_route_preferences` | safe action | the driver asked explicitly; logged with undo |
| `set_reminder`, `cancel_reminder` | safe action | "remind me about coffee in 30 min" → proactive later |
| `remember_preference`, `forget_preference` | safe action | only explicit, lasting statements; validated keys |
| `add_stop`, `set_destination`, `switch_route`, `reorder_stops` | **confirm** | change the trip substantially |
| `cancel_pending_action` | safe action | the driver said no |

**Confirmation.** A confirm action first returns `awaiting_user_confirmation`
with its impact ("+4 min"). It executes only when one of these happens:

- the driver taps **Так**;
- the model repeats it in a later turn, after the driver's yes;
- the driver orders exactly that action having heard its impact in an
  earlier answer. The model sets `driver_confirmed_in_this_message`, and the
  code checks the impact was presented before.

So "друга норм, скільки втратимо?" → (+4 min) → "додавай" executes without a
second question. "Знайди McDonald's і додай" (impact not yet heard) is
proposed first. Actions proposed in the same turn form one plan ("coffee
first, then home"), confirmed with one yes or one tap and executed in the
order the model called them. Reads run in parallel. Proposals expire after 2
turns or 5 minutes.

## What the model sees: `<trip_state>`

A compact snapshot of about 250–600 characters per message, with no
coordinates or polylines. Example after "find fuel" → "the second, how much?":

```
<trip_state>
time: 14:00
nav: mode=ACTIVE gnss=NORMAL position_confidence=HIGH internet=online
positioning: location_state=PRECISE source=GNSS (GPS) gnss_verdict=OK uncertainty=±4 m confidence=0.99 maneuver_guidance=exact motion_sensors=yes last_trusted_fix=1 s ago
speed: 60 km/h
road: вул. Хрещатик / просп. Броварський
next_maneuver: right onto Бориспільське шосе in 2440 m
destination: Бориспіль | remaining: 31 km, 48 min, arrival 14:48 (routing-engine estimate)
stops: none
route: provider=demo avoid=none
data: places=demo traffic=unavailable
last_results (along route: fuel): #1 p2 ОККО (fuel) 7 km ahead, +0.5 min; #2 p1 WOG (fuel) 16 km ahead, +0.2 min; #3 p3 SOCAR (fuel) 25 km ahead, +3.6 min
focus: p1 WOG (the place "it"/"that one" most likely refers to)
recent_actions: 2 min ago: added stop s1 "Aroma Kava" [undo: remove_stop {"stop_id":"s1"}]
reminders: m1 "кава" at 14:30
preferences (driver's saved, long-term): preferred_fuel_brands=OKKO; max_detour_minutes=7
driving: phase=moving trip_phase=en_route_with_stops next_maneuver_in_s=146 reply_style=brief, spoken
</trip_state>
```

Earlier exchanges are replayed as plain text only (last 6, ≤3000 chars):
no stale tool payloads. The structured memory above carries the ids, so
references survive without them.

## Memory

| Layer | Lives in | Holds | Lifetime |
|---|---|---|---|
| Conversation | `CopilotSession` | dialogue text, numbered result lists (+ previous), focus, pending plan | the conversation (reset on a new trip) |
| Trip | `TripPlanner`, `CopilotSession.actions/reminders`, `ActiveTripCache` | destination, stops, road preferences, actions with undo, reminders; the active trip is saved on the phone | the trip |
| Long-term | `PreferenceStore` (expo-sqlite key-value on the phone) | preferred/avoided brands, food, dietary, detour limit, toll/highway/unpaved avoidance, proactive level, reply length | until the driver says forget |

Only explicit, lasting statements become preferences ("я завжди…",
"ніколи…", "запам'ятай…"). Saved road preferences apply to each new trip,
and a saved detour limit becomes the default for searches (reported as
`applied_preference`).

## Proactive co-pilot

`ProactiveEngine` notices things deterministically:

- a reminder is due (by time or distance);
- live traffic ahead adds ≥8 min (≥15 with `important_only`), only when a
  traffic feed exists.

GPS lost / spoofed / restored is announced by `VoiceGuidance`, once per
episode. What to say is the model's decision (`handleEvent`, `<event>`
message: speak, look up places and propose, or `SKIP`). Without the model, a
reminder is still delivered with a real along-route search.

Anti-spam limits:

- at most 1 message per 4 min and 3 per 30 min;
- never within 20 s of a maneuver;
- never while a question is pending or the co-pilot is busy;
- preference `proactive_suggestions` = off / important_only.

## Driving context

`driving:` in trip_state gives the phase (stopped / moving /
maneuver_imminent), the trip phase and the reply style. Moving means short
spoken answers with at most 3 options. With a maneuver imminent, one sentence
or wait. Stopped allows up to 5 options. Preference `reply_length=short`
shortens answers further.

## Position, GPS and internet

The location engine exposes `positioning`:

- `location_state`: PRECISE / REDUCED_ACCURACY / STALE / UNSTABLE / LOST /
  SPOOFED / RECOVERED;
- `source` and `uncertainty`;
- `maneuver_guidance`: exact / approximate / none.

The model states nothing more precisely than that allows. `internet=offline`
is separate from GPS: navigation continues on the saved route. The model
never computes position; see `docs/GNSS_DENIED_REPORT.md`.

## Voice-first

`VoiceConversation` (core, UI-independent):

- **Hands-free**: continuous listening; an utterance is for NAVIA when it
  starts with "Навіа" (one recognition error tolerated, "ей Навіа" too).
- **Follow-up**: after NAVIA asks something, the reply needs no wake word
  for 8 s.
- **Push-to-talk**: the mic button.
- **Barge-in**: speaking stops the TTS.
- **Queue**: proactive messages wait until the loop is idle.

The app's voice panel has a "Руки вільні" switch.

## Models, routing, cost

The backend picks the provider (`NAVIA_LLM_PROVIDER`: `anthropic` default, or
`openai_compatible` for any OpenAI-style Chat Completions endpoint with
function calling) and maps tiers to models:

| Tier | Default | Used for |
|---|---|---|
| `fast` | `claude-haiku-4-5` | most turns: status questions, one search + answer, confirmations |
| `smart` | `claude-opus-5-5`, effort medium, server-side refusal fallback | tool errors, long multi-constraint requests, ≥3 tools, 4th+ call |

The cascade (`model-router.ts`) uses structural signals only. The static
prompt (system + 20 tool schemas) is ~22k characters (~5.5k tokens), above
Haiku 4.5's 4096-token caching minimum, so it is cached on both tiers (verify
with `cache_read_input_tokens` in the live eval). Read tools share a 60 s
cache per position. An on-device model can plug in behind the same
`LLMClient` interface. It isn't included: none fits NAVIA's tool-use needs
on a phone today, and the deterministic fallback covers offline basics.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| no backend / no consent / backend unreachable | deterministic local answers + real searches for common place requests, prefixed "Розумний режим штурмана зараз недоступний." |
| failure after tools ran | honest partial message, nothing invented |
| place search down / no place data | "unavailable", no invented places |
| routing down during an action | action rolled back and reported; navigation keeps the current route |
| model refuses / loops | refusal sentence / tool budget → answer with what it has |

## Required APIs (what makes it fully work)

| Needed | Status | Where it goes |
|---|---|---|
| LLM API key (Claude; or an OpenAI-compatible provider) | **required for the AI** | backend env only: `ANTHROPIC_API_KEY=sk-ant-…` (just the key) or `NAVIA_LLM_PROVIDER=openai_compatible` + `NAVIA_OPENAI_BASE_URL` + `NAVIA_OPENAI_API_KEY` + model names. Never in the app bundle or Git. |
| HTTPS backend (`apps/ai-backend`) | code ready | deploy anywhere with Node 20+; app gets `EXPO_PUBLIC_NAVIA_AI_BACKEND_URL` |
| Routing (Valhalla) | provider ready | `EXPO_PUBLIC_NAVIA_VALHALLA_URL` |
| Place search (OSM Overpass) | provider ready | `EXPO_PUBLIC_NAVIA_OVERPASS_URL`; offline POI index via `scripts/data` |
| Live traffic | interface only (`TrafficProvider`) | a traffic feed adapter; until then traffic answers say "unavailable" |
| Ratings, prices, fuel prices, Wi-Fi, queues | no source | would need a data provider; the AI says it doesn't have them |

## Running

```bash
ANTHROPIC_API_KEY=... npm run ai:backend               # :8787, GET /healthz shows provider + models
npm test                                               # no key needed
ANTHROPIC_API_KEY=... npm run eval:ai -- --suite all   # live: legacy + dev + holdout, per-suite report
npm run eval:ai -- --suite all --baseline-local        # grade the deterministic fallback alone
npx tsx packages/core/eval/model-in-the-loop.ts --holdout   # replay the recorded holdout sample
```

Evaluation details and results: `docs/AI_EVAL_REPORT.md`.
