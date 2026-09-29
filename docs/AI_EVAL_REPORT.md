# NAVIA co-pilot — evaluation report

Date: 2026-09-29. Everything below is reproducible from the repo:

```bash
npm test              # 165 tests, incl. transcript replay, negative controls, usefulness claims
npm run eval:replay   # model-in-the-loop scenarios: pass/fail, tiers, estimated tokens/cost
npm run bench:ai      # usefulness benchmark vs. baselines (writes packages/core/eval/benchmark-report.json)
ANTHROPIC_API_KEY=... npm run eval:ai   # same scenarios against the production models (not run here: no key)
```

## What was and was not measured

| Evidence | Method | Status |
|---|---|---|
| Tool layer computes the right facts | unit tests on the demo world | ✅ measured |
| A capable model can solve all scenarios with these tools + prompt | **model-in-the-loop**: Claude (Opus 5.5, in the Claude Code session) played the co-pilot model, seeing only what the model sees (system prompt, `<trip_state>`, driver text, tool results); real tools and grader | ✅ 26/26 — but this is not the production Haiku 4.5 / Opus 5.5 configuration, and the decider knew the scenario checks |
| Grader actually catches bad answers | negative controls (injected hallucinations) | ✅ 5/5 caught |
| Route-aware search beats what drivers get without it | benchmark on seeded synthetic places, ground truth from the routing engine | ✅ measured (synthetic data) |
| Production model pass rate, latency, real token cost | `npm run eval:ai` with an API key | ❌ not measured — no Claude API key in this environment |
| Live OSM (Overpass) and Valhalla | — | ❌ unreachable from this environment |

## 1. Scenario evaluation (model-in-the-loop)

26 scenarios, 36 driver turns, 72 LLM calls. All pass every deterministic
check: required/forbidden tools, tool constraints (e.g.
`max_detour_minutes <= 10`), pending vs. applied actions, waypoints on the
route, must/must-not phrases, answer length, no markdown, and **unit-aware
number grounding** (every km / m / minute / clock time spoken must match a
fact of the same kind in `trip_state` or a tool result).

Categories covered: normal requests (8 from the product brief + Russian),
multi-step (McDonald's ≤ 10 min → propose → add; coffee first), ambiguous
("хочу їсти", "додому" without a saved home), API errors (place search 504,
routing down mid-action), no results (KFC, no place database), route change
(new destination with confirmation), long dialogue (5 turns: add → check →
remove → repeat; "давай другу"), safety (LOW position confidence, air-alert
"is it safe?").

Transcripts: `packages/core/eval/transcripts/*.json` — replayed in `npm test`.

## 2. Negative controls (does the grader discriminate?)

| Injected failure | Caught by |
|---|---|
| "ОККО через 5 км, гак 4 хв" (invented numbers) | number grounding |
| "Заторів немає" without traffic data | must-not phrase |
| naming a station while place search is down | must-not phrase |
| "через 2440 метрів" under LOW confidence | must-not phrase |
| answering McDonald's from memory, no tools | 5 checks (tools, pending, grounding, waypoints) |

The first control initially **passed** — the grader's number check was too
lenient (any number anywhere in the request JSON counted). It was rewritten
to be unit-aware before the results above were produced.

## 3. Usefulness benchmark

Seeded synthetic places along the demo Kyiv→Boryspil road (dense: 300,
sparse: 60), 40 positions along the drive, four requests. For each method's
pick, ground truth from the routing engine: true extra driving time, behind
the car or not, open now or not. *useful* = pick satisfies the request
(ahead, within the detour limit, open if asked) ÷ cases where such an option
exists.

Sparse field (60 places):

| Request | Method | useful | picks behind the car | picks closed now | mean true detour |
|---|---|---:|---:|---:|---:|
| fuel, ≤5 min | **NAVIA co-pilot** | **100 %** | **0 %** | **0 %** | 0.0 min |
| | NAVIA offline (no LLM) | 100 % | 0 % | 0 % | 0.2 min |
| | "nearby" (straight line) | 57.5 % | 42.5 % | 7.5 % | 2.3 min |
| | "nearby ahead" (heading ±60°) | 100 % | 0 % | 5 % | 0.8 min |
| | previous NAVIA AI (regex) | 0 % (no answer) | — | — | — |
| open restaurant, ≤10 min | **NAVIA co-pilot** | **100 %** | **0 %** | **0 %** | 0.1 min |
| | NAVIA offline (no LLM) | 100 % | 0 % | 0 % | 0.1 min |
| | "nearby" (straight line) | 44.7 % | 47.5 % | 25 % | 2.7 min |
| | "nearby ahead" | 81.6 % | 0 % | 17.5 % | 0.6 min |
| | previous NAVIA AI (regex) | 0 % | — | — | — |

Full tables (dense + sparse, 4 requests, regret vs. the best valid option):
`packages/core/eval/benchmark-report.json`. Tool latency on local data:
p50 0.2–0.4 ms (demo router; with Valhalla add one parallel round of
routing calls for the routed detours).

Caveats: synthetic places on a single-road demo network; ground truth uses
the same routing engine NAVIA uses, so NAVIA's own detours are exact by
construction — the benchmark shows what *not* having route awareness costs.
A heading filter alone ("nearby ahead") is a strong baseline for fuel; the
co-pilot's advantage there is opening hours and exact detours.

## 4. What the evaluation changed

Defects found by running the scenarios / benchmark and fixed:

1. `check_landmark` said "after it — turn right" without the distance; the turn was 5.9 km later. Now returns `next_maneuver_after_landmark_m`.
2. `main_roads_ahead` counted the already-driven part of the current street.
3. Searching with a small fuel range cut the window at the range and returned nothing, hiding "the nearest station is 7 km — just past your range". Now searches past the range and marks `reachable:false`; unreachable options are ordered nearest-first.
4. Results were ordered by detour, so "давай другу" meant different places to the driver and the model. Results are now presented in driving order.
5. Known-closed places ranked by detour alone: in the sparse benchmark the co-pilot picked a **closed** fast-food place in 50 % of cases. Closed places now rank last → 2.5 %.
6. A stop within 30 m of the car's road position crashed the demo router ("same point"), so such a stop could not be added.
7. Demo geocoder required exact substring order ("аеропорт Бориспіль" ≠ "Бориспіль, аеропорт").
8. Two grader regexes rejected correct answers (word order); the number grounding was too lenient (see §2).

Improvements:

- No match for a brand → the tool returns same-category alternatives (saves a round-trip: "KFC немає, є McDonald's через 12 км").
- `set_destination` preview now gives the routed time and arrival, not a straight-line distance.
- **Offline fallback**: with no LLM (backend down, consent off), common place requests are still answered from the real tools — 0 % → 100 % useful in the benchmark.
- **Model routing retuned**: the old cascade sent 23/72 calls to the smart tier, mostly to phrase results or handle "так"/"повтори". Now 33/36 turns stay on the fast tier; smart is used for tool-error recovery, long requests, ≥3 tools, 4+ calls. Estimated cost per turn $0.0125 → $0.0100.

## 5. Cost estimate (character-based, not measured)

From the recorded requests (≈3 chars/token; static prompt + 13 tools ≈ 4k tokens):

| Turn type | LLM calls | est. cost |
|---|---:|---:|
| status question ("скільки ще?") | 1 fast | ≈ $0.005 |
| one search + answer | 2 fast | ≈ $0.010 |
| search → propose → answer | 3 fast | ≈ $0.015 |
| tool error recovery | 1 fast + 1 smart | ≈ $0.014 |

Average over the 36 turns: **≈ $0.010 per driver question**. The static
prompt dominates; Haiku 4.5 only caches prompts ≥ 4096 tokens, so measure
with the live eval before trimming or padding it.

## 6. Still to prove with a key

Run `npm run eval:ai` three ways (`--policy auto`, `always_fast`,
`always_smart`) and compare pass rate / p50–p90 latency / measured cost.
Go/no-go suggestion: ship `auto` if it is within 1 scenario of
`always_smart` on pass rate.
