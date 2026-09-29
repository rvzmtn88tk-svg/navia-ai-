# NAVIA AI co-pilot

NAVIA's AI is a conversational layer over the navigation engine: the driver
speaks naturally ("find a McDonald's on the way that adds at most 10
minutes and add it as a stop"), the model works out which tools to call and
in what order, the navigation stack computes every fact, and the model turns
the results into one or two spoken sentences.

```
 driver ──► VoicePanel ──► NaviaCopilot.ask()            (on the phone, @navia/core)
                              │  <trip_state> snapshot + short dialogue memory
                              ▼
                     BackendLLMClient ──HTTPS──► apps/ai-backend ──► Claude API
                              ▲                  (API key, system prompt,
                              │ tool_use          tool schemas, tier→model)
                              ▼
                     executeCopilotTool()  ──► RouteGeometryIndex / RouteTimeline
                              │                 TripPlanner ─► RoutingProvider (Valhalla/demo)
                              │                 PlaceSearchProvider (Overpass/offline/demo)
                              │                 TrafficProvider, GeocoderProvider, LandmarkEngine
                              ▼
                     navigation engine applyRoute()  (NavigationEngine / DemoEngine)
```

## Division of labour

| Layer | Owns |
|---|---|
| **LLM** | understanding the request (any phrasing, uk/ru/en), choosing tools and constraints, multi-step planning, weighing results, clarifying questions, phrasing a short spoken answer |
| **Tools** (`packages/core/src/copilot/tool-executor.ts`) | fetching facts and performing trip actions; every number is computed here |
| **Navigation stack** | position, GNSS integrity, route geometry, progress, ETA, maneuvers, routing, rerouting — unchanged, deterministic |
| **App/UI** | trip state, confirmation card, TTS, consent switch |

The model never receives or produces coordinates: places, stops and routes
are referred to by short ids (`p3`, `s1`, `r2`) that the on-device
`EntityRegistry` maps back to real objects. A made-up id is rejected by the
tool. This makes "never invent a place/coordinate" structural, not just a
prompt rule.

## Tools

| Tool | What it does | Deterministic core |
|---|---|---|
| `search_along_route` | places ahead on the route: category/brand, time window ("in ~30 min"), distance window, max detour, remaining range, open now | corridor search → projection onto the route → minutes ahead from the provider's step durations → **routed detour** (route with the stop minus baseline) for the best candidates, labelled geometric estimate otherwise → reachability with 85 % range reserve → `opening_hours` evaluation |
| `search_near` | places around destination / current position / a found place | straight-line distance, walking minutes |
| `get_route_overview` | provider, remaining km/min, arrival, stops, applied/unsupported preferences, main roads ahead, next maneuvers | maneuver distances withheld when position confidence is LOW/UNKNOWN |
| `compare_routes` | alternatives from the routing engine with time/distance deltas and roads | alternatives not starting at the car are discarded |
| `get_traffic_ahead` | live delays if a `TrafficProvider` is connected | returns `available:false` today (no traffic feed) |
| `find_destination` | saved home/work or address search | geocoder |
| `check_landmark` | "I see WOG — is it mine?" | `LandmarkEngine` (confirmed / ambiguous / no_match) |
| `add_stop`, `set_destination`, `switch_route` | trip actions | **confirmation-gated** (below) |
| `remove_stop`, `set_route_preferences` | trip actions the driver asked for explicitly | run immediately; `set_route_preferences` reports unsupported preferences and leaves the route unchanged if nothing can be honoured |
| `cancel_pending_action` | driver said no | |

### Confirmation gate

`add_stop`, `set_destination` and `switch_route` never execute on the first
call: they return `awaiting_user_confirmation` with the time impact and
store a pending action. They execute only when (a) the driver taps **Так**
on the card (`confirmPendingAction()`, no LLM round-trip), or (b) the model
repeats the *same* action in a *later* turn — i.e. after the driver has
spoken. The model cannot confirm its own proposal within one turn. Pending
actions expire after 2 turns or 5 minutes.

## Context: `<trip_state>`

Every driver message carries a compact snapshot (~400 characters, roughly
100–150 tokens) so simple questions need zero tools:

```
<trip_state>
time: 14:00
nav: mode=ACTIVE gnss=NORMAL position_confidence=HIGH network=online
speed: 60 km/h
road: вул. Хрещатик / просп. Броварський
next_maneuver: right onto Бориспільське шосе in 2440 m
destination: Бориспіль | remaining: 31 km, 48 min, arrival 14:48 (routing-engine estimate)
stops: none
route: provider=demo avoid=none
data: places=demo traffic=unavailable
pending_action: add_stop — "Додати зупинку: McDonald's (+3 хв)" — awaiting driver's yes/no
last_results: p1 McDonald's (fast_food) 12 km ahead, +2.8 min
</trip_state>
```

No polylines, no POI dumps, no coordinates. Anything bigger is fetched by
a tool only when needed. Earlier turns are replayed as plain text only
(last 6 exchanges, ≤3000 chars) — no stale tool payloads and no thinking
blocks from earlier turns, which keeps the history append-only within a
turn and cheap across turns.

## Models, latency and cost

The backend maps two tiers to models (`apps/ai-backend/src/config.ts`,
overridable by env):

| Tier | Default model | Used for |
|---|---|---|
| `fast` | `claude-haiku-4-5` ($1 / $5 per MTok) | almost everything: status questions, one search + answer, search → propose → answer, "так" confirmations |
| `smart` | `claude-opus-5-5` ($4 / $20 per MTok), effort `medium`, server-side refusal fallback | turns that hit a tool error, long multi-constraint requests (>160 chars), ≥3 different tools, or a 4th+ LLM call |

The cascade (`copilot/model-router.ts`) uses structural signals of the turn,
not keywords, and never downgrades within a turn. It was tuned with the
model-in-the-loop replay (`docs/AI_EVAL_REPORT.md`): 33 of 36 evaluated turns
stay on the fast tier. `always_fast` / `always_smart` policies exist for
measurement (`npm run eval:ai -- --policy …`), and `stickySmartMs` can keep
follow-ups on the smart tier if the live eval shows a quality gain.
`NAVIA_AI_MODEL_SMART=claude-sonnet-5-5` is the cheaper smart-tier option to
evaluate.

Estimated cost from the recorded scenario requests (≈3 chars/token; static
prompt ≈ 4k tokens = system prompt + 13 tool schemas; not yet measured with
the API): status question ≈ $0.005, one search + answer ≈ $0.010,
search → propose → answer ≈ $0.015, average ≈ **$0.010 per driver question**.
Haiku 4.5 caches only prompts ≥ 4096 tokens, so whether the static prefix is
cached on the fast tier must be checked with `usage.cache_read_input_tokens`
in the live eval.

Latency budget per turn: 30 s hard deadline, ≤6 LLM calls, ≤12 tool calls;
independent tools run in parallel and all results return in one message.

## Privacy (spec section 30)

* The smart co-pilot is used only when the backend is configured **and**
  the driver turns on *"Надсилати контекст поїздки ШІ"* (default **off**).
  Otherwise the on-device `DeterministicDemoAIProvider` answers.
* No coordinates are ever sent to the model; road names, place names,
  distances and times are.
* The backend accepts only co-pilot conversations: no custom system prompt
  or model, no images/documents, known tool names only, size limits,
  optional bearer token, per-IP rate limit, protocol-version check.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| backend unreachable / 5xx / rate-limited before any tool ran | local answer, prefixed "Розумний режим штурмана зараз недоступний.": place requests ("заправка по дорозі", "кава", "парковка біля місця призначення", "McDonald's, не більше 10 хв") still run the real tools via a small offline parser (`copilot/local-place-intent.ts`); everything else gets the deterministic status answers |
| backend fails after tools ran | honest partial-failure message, nothing invented |
| place search down (Overpass 5xx) | tool error → model says place search is unavailable |
| no place database (offline, no index) | `place_search_unavailable` |
| routing down during an action | action rolled back (stop not half-added, preferences reverted) and reported |
| model refuses | "Я не можу допомогти з цим запитом." |
| model loops on tools | budget exhausted → forced to answer with what it has |

## Voice

The 🎤 button runs on-device speech recognition (`expo-speech-recognition`,
uk-UA) for one utterance; the transcript goes to `NaviaCopilot.ask()` and the
answer is spoken with `expo-speech`. Pending actions can be confirmed by
voice ("так") or with the Yes/No card. A text field is available for a
passenger. iOS setup: see `docs/HANDOFF_IOS.md`.

## Running

```bash
# backend (needs a Claude API key on the server, never in the app)
ANTHROPIC_API_KEY=... npm run ai:backend          # :8787, GET /healthz
# app: EXPO_PUBLIC_NAVIA_AI_BACKEND_URL=https://<backend>  (+ optional EXPO_PUBLIC_NAVIA_OVERPASS_URL)

# tests (no key needed): scripted-LLM agent tests + tools + backend
npm test

# live evaluation against the real model (spends API credit)
ANTHROPIC_API_KEY=... npm run eval:ai
npm run eval:ai -- --dry-run                       # no API calls
```

## Evaluation

See `docs/AI_EVAL_REPORT.md` for results: 26/26 model-in-the-loop
scenarios, 5/5 negative controls caught, and a usefulness benchmark against
straight-line "nearby" search and the previous regex assistant.

## Evaluation set

`packages/core/eval/scenarios.ts` — 26 real driver requests across normal,
multi-step, ambiguous, API-error, no-results, route-change, long-dialog and
safety categories (the eight requests from the product brief included
verbatim in Ukrainian). `eval/grader.ts` grades deterministically: required /
forbidden tools, tool constraints (e.g. `max_detour_minutes <= 10`), pending
vs. applied actions, route waypoints, must/must-not phrases, answer length,
no markdown, and **number grounding** — every number spoken must trace to
trip_state, a tool result, the driver's words or an earlier answer.
