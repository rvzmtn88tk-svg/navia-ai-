// Usefulness benchmark: does the co-pilot's route-aware search pick better
// places than what a driver gets without it?
//
// A seeded synthetic field of places (clearly synthetic — random positions
// along the demo Kyiv->Boryspil road) is queried from many positions along
// the drive with three typical requests. Each method's pick is judged
// against ground truth from the routing engine itself: the real extra
// driving time to stop there (route with the stop minus route without),
// whether the place is behind the car, and whether it is open now.
//
// Methods:
//   navia        — the co-pilot tool (search_along_route), top result
//   nearby       — nearest place of the category by straight-line distance
//                  (what a generic "nearby" search / location-aware chatbot does)
//   nearby_ahead — nearest by straight line among places within ±60° of heading
//   legacy_ai    — NAVIA's previous regex assistant (DeterministicDemoAIProvider)
//
//   npx tsx packages/core/eval/benchmark.ts     (writes eval/benchmark-report.json)

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { POI, LandmarkCategory } from "../src/landmark-engine";
import { haversineMeters, initialBearing, angleDeltaDeg } from "../src/geodesy";
import { RouteGeometryIndex } from "../src/route-geometry";
import { evaluateOpeningHours } from "../src/place-search";
import { demoPointAlongRoad } from "../src/demo-data";
import { DeterministicDemoAIProvider } from "../src/ai-engine";
import { executeCopilotTool } from "../src/copilot/tool-executor";
import { CopilotSession, EntityRegistry } from "../src/copilot/runtime";
import { NaviaCopilot } from "../src/copilot/copilot";
import { buildWorld, WORLD_DEFAULT_NOW } from "./world";

// --- deterministic synthetic place field ---

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOURS = ["24/7", "Mo-Su 07:00-22:00", "Mo-Su 08:00-21:00", "Mo-Fr 09:00-18:00", "Mo-Su 18:00-02:00", "Mo-Su 06:00-11:00"];

export function syntheticPlaces(count = 300, seed = 20260929): POI[] {
  const rnd = mulberry32(seed);
  const cats: LandmarkCategory[] = ["fuel", "cafe", "restaurant", "fast_food"];
  const out: POI[] = [];
  for (let i = 0; i < count; i++) {
    const category = cats[i % cats.length]!;
    const along = rnd() * 33_000;
    // Most places are close to the road, some well off it (log-uniform 20 m .. 1.4 km,
    // the demo road network's access coverage).
    const offset = 20 * Math.pow(70, rnd()) * (rnd() < 0.5 ? -1 : 1);
    out.push({
      id: `syn-${i}`, name: `${category}-${i}`, category,
      location: demoPointAlongRoad(along, offset),
      openingHours: HOURS[Math.floor(rnd() * HOURS.length)]!,
      source: "demo",
    });
  }
  return out;
}

type Query = { id: string; text: string; category: LandmarkCategory; maxDetourMin: number; openOnly: boolean };

const QUERIES: Query[] = [
  { id: "fuel<=2min", text: "Заправка по дорозі, але гак максимум 2 хвилини", category: "fuel", maxDetourMin: 2, openOnly: false },
  { id: "fuel<=5min", text: "Знайди заправку по дорозі, гак не більше 5 хвилин", category: "fuel", maxDetourMin: 5, openOnly: false },
  { id: "fastfood<=10min", text: "Знайди фастфуд по дорозі, щоб додав не більше 10 хвилин", category: "fast_food", maxDetourMin: 10, openOnly: false },
  { id: "restaurant-open<=10min", text: "Знайди відчинений ресторан по дорозі, не більше 10 хвилин гаку", category: "restaurant", maxDetourMin: 10, openOnly: true },
];

type Verdict = { answered: boolean; behind: boolean; closed: boolean; detourMin: number | null; valid: boolean };

export async function runBenchmark(placeCount: number) {
  const places = syntheticPlaces(placeCount);
  const positions = Array.from({ length: 40 }, (_, i) => 500 + i * 750); // 0.5 .. 29.75 km
  const legacy = new DeterministicDemoAIProvider();
  const methods = ["navia", "navia_offline", "nearby", "nearby_ahead", "legacy_ai"] as const;
  type Method = (typeof methods)[number];
  const rows: Record<string, Record<Method, Verdict[]> & { bestValidExists: number; regret: Record<Method, number[]> }> = {};
  const toolMs: number[] = [];

  for (const q of QUERIES) {
    rows[q.id] = { navia: [], navia_offline: [], nearby: [], nearby_ahead: [], legacy_ai: [], bestValidExists: 0, regret: { navia: [], navia_offline: [], nearby: [], nearby_ahead: [], legacy_ai: [] } };
    for (const alongM of positions) {
      const world = await buildWorld({ alongM, places });
      const runtime = world.runtime;
      const here = world.position;
      const route = world.host.route!;
      const index = new RouteGeometryIndex(route.geometry);
      const alongNow = index.project(here)!.alongM;
      const heading = index.bearingAt(alongNow);
      const baseline = await world.planner.route(here);
      const now = WORLD_DEFAULT_NOW;

      const detourCache = new Map<string, number>();
      const trueDetourMin = async (p: POI): Promise<number> => {
        if (!detourCache.has(p.id)) {
          const withStop = await world.planner.route(here, { stops: [{ id: "x", label: p.name, location: p.location, addedAt: 0 }] });
          detourCache.set(p.id, Math.max(0, (withStop.durationS - baseline.durationS) / 60));
        }
        return detourCache.get(p.id)!;
      };
      const judge = async (p: POI | null): Promise<Verdict> => {
        if (!p) return { answered: false, behind: false, closed: false, detourMin: null, valid: false };
        const proj = index.project(p.location)!;
        const behind = proj.alongM < alongNow - 30;
        const closed = evaluateOpeningHours(p.openingHours, now) === false;
        const detourMin = await trueDetourMin(p);
        const valid = !behind && detourMin <= q.maxDetourMin + 0.05 && !(q.openOnly && closed);
        return { answered: true, behind, closed, detourMin, valid };
      };

      // Ground truth: the best valid choice (min true detour) among all places of the category ahead.
      const ofCat = places.filter((p) => p.category === q.category);
      const candidates = ofCat.filter((p) => index.project(p.location)!.alongM >= alongNow - 30 && index.project(p.location)!.offsetM < 1500);
      let best: number | null = null;
      for (const p of candidates) {
        const v = await judge(p);
        if (v.valid && (best == null || v.detourMin! < best)) best = v.detourMin!;
      }
      if (best != null) rows[q.id]!.bestValidExists++;

      // navia
      const ctx = { runtime, registry: new EntityRegistry(), session: new CopilotSession() };
      ctx.session.beginTurn(0);
      const t0 = performance.now();
      const out = await executeCopilotTool("search_along_route", {
        categories: [q.category], max_detour_minutes: q.maxDetourMin, ...(q.openOnly ? { open_now_only: true } : {}), limit: 3,
      }, ctx);
      toolMs.push(performance.now() - t0);
      const results = (out.content.results as { id: string; detour_min: number; open_now: boolean | string }[] | undefined) ?? [];
      // The co-pilot recommends by detour and opening hours (system prompt):
      // the smallest-detour result not known to be closed, else the smallest detour.
      const byDetour = [...results].sort((a, b) => a.detour_min - b.detour_min);
      const pick = byDetour.find((r) => r.open_now !== false) ?? byDetour[0];
      const naviaPoi = pick ? ((ctx.registry.get(pick.id) as { poi?: POI } | undefined)?.poi ?? null) : null;

      // nearby: nearest by straight line
      const nearest = [...ofCat].sort((a, b) => haversineMeters(here, a.location) - haversineMeters(here, b.location))[0] ?? null;
      // nearby_ahead: nearest within ±60° of heading
      const ahead = ofCat.filter((p) => angleDeltaDeg(initialBearing(here, p.location), heading) <= 60)
        .sort((a, b) => haversineMeters(here, a.location) - haversineMeters(here, b.location))[0] ?? null;
      // legacy regex AI: does it name any place at all?
      const legacyText = await legacy.answer({ state: world.host.getState(), route, nearbyLandmarks: [], nearbyPOI: places, recentEvents: [] }, q.text);
      const legacyNamed = places.find((p) => legacyText.includes(p.name)) ?? null;

      // navia_offline: the co-pilot with no LLM (backend down / consent off) — the local fallback.
      const offline = new NaviaCopilot({ runtime, llm: null });
      const offlineReply = await offline.ask(q.text);
      const offlineResults = (offlineReply.trace[0]?.result.results as { id: string }[] | undefined) ?? [];
      const offlinePoi = offlineResults[0] ? ((offline.registry.get(offlineResults[0].id) as { poi?: POI } | undefined)?.poi ?? null) : null;

      const picks: Record<Method, POI | null> = { navia: naviaPoi, navia_offline: offlinePoi, nearby: nearest, nearby_ahead: ahead, legacy_ai: legacyNamed };
      for (const m of methods) {
        const v = await judge(picks[m]);
        rows[q.id]![m].push(v);
        if (best != null && v.valid) rows[q.id]!.regret[m].push(v.detourMin! - best);
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);
  const summary: Record<string, unknown>[] = [];
  for (const q of QUERIES) {
    const r = rows[q.id]!;
    for (const m of methods) {
      const vs = r[m];
      const n = vs.length;
      const detours = vs.filter((v) => v.detourMin != null).map((v) => v.detourMin!);
      summary.push({
        query: q.id, method: m, cases: n,
        useful_answer_pct: pct(vs.filter((v) => v.valid).length, r.bestValidExists),
        answered_pct: pct(vs.filter((v) => v.answered).length, n),
        behind_pct: pct(vs.filter((v) => v.behind).length, n),
        over_detour_limit_pct: pct(vs.filter((v) => v.answered && !v.behind && v.detourMin! > q.maxDetourMin + 0.05).length, n),
        closed_pct: pct(vs.filter((v) => v.closed).length, n),
        mean_true_detour_min: detours.length ? Math.round((10 * detours.reduce((a, b) => a + b, 0)) / detours.length) / 10 : null,
        mean_regret_min: r.regret[m].length ? Math.round((100 * r.regret[m].reduce((a, b) => a + b, 0)) / r.regret[m].length) / 100 : null,
        cases_with_a_valid_option: r.bestValidExists,
      });
    }
  }
  toolMs.sort((a, b) => a - b);
  return {
    places: placeCount,
    positions: positions.length,
    toolLatencyMs: { p50: Math.round(toolMs[Math.floor(toolMs.length / 2)]! * 10) / 10, p90: Math.round(toolMs[Math.floor(toolMs.length * 0.9)]! * 10) / 10 },
    summary,
  };
}

async function main() {
  const runs = [await runBenchmark(300), await runBenchmark(60)];
  const report = {
    note: "Synthetic place fields (seeded random places along the demo road; dense = 300, sparse = 60), 40 positions each, ground truth from the routing engine. useful_answer_pct = valid picks / cases where a valid option exists.",
    runs,
  };
  const out = join(dirname(fileURLToPath(import.meta.url)), "benchmark-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(report.note);
  for (const run of runs) {
    console.log(`\n== ${run.places} places · search_along_route p50 ${run.toolLatencyMs.p50} ms, p90 ${run.toolLatencyMs.p90} ms (demo router, local data)`);
    console.log("query                   method        useful%  behind%  >limit%  closed%  meanDetour  regret");
    for (const s of run.summary) {
      console.log(`${String(s.query).padEnd(24)}${String(s.method).padEnd(14)}${String(s.useful_answer_pct).padStart(7)}${String(s.behind_pct).padStart(9)}${String(s.over_detour_limit_pct).padStart(9)}${String(s.closed_pct).padStart(9)}${String(s.mean_true_detour_min ?? "—").padStart(12)}${String(s.mean_regret_min ?? "—").padStart(8)}`);
    }
  }
  console.log(`\nReport: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
