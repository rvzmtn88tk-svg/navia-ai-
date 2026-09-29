// Usefulness claims, locked in as tests:
//  - the offline (no-LLM) fallback answers common place requests from the real tools;
//  - on a seeded synthetic place field, the co-pilot's picks are never behind the
//    car, never over the detour limit, and (almost) never closed, while a
//    straight-line "nearby" search often is, and the previous regex assistant
//    cannot answer at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocalPlaceIntent } from "../src/copilot/local-place-intent";
import { NaviaCopilot } from "../src/copilot/copilot";
import { buildWorld } from "../eval/world";
import { runBenchmark } from "../eval/benchmark";

test("local intent parser: category, brand, detour limit, range, near-destination; ignores non-place questions", () => {
  assert.deepEqual(parseLocalPlaceIntent("Знайди заправку по дорозі, гак не більше 5 хвилин")?.input, { categories: ["fuel"], limit: 2, max_detour_minutes: 5 });
  assert.deepEqual(parseLocalPlaceIntent("Найди Макдональдс по пути")?.input.name_variants, ["McDonald's", "Макдональдз"]);
  assert.equal(parseLocalPlaceIntent("Мені залишилось 40 км пального")?.input.vehicle_range_km, 40);
  assert.equal(parseLocalPlaceIntent("Знайди парковку біля місця призначення")?.tool, "search_near");
  assert.equal(parseLocalPlaceIntent("Есть ли впереди пробки?"), null);
  assert.equal(parseLocalPlaceIntent("Що з GPS?"), null);
  assert.equal(parseLocalPlaceIntent("Де наступний поворот?"), null);
});

test("offline fallback: with the smart mode off, 'find fuel' is still answered from the real tools", async () => {
  const w = await buildWorld();
  const copilot = new NaviaCopilot({ runtime: w.runtime, llm: null });
  const r = await copilot.ask("Знайди заправку по дорозі");
  assert.equal(r.mode, "local");
  assert.equal(r.trace[0]?.tool, "search_along_route");
  assert.match(r.text, /ОККО праворуч через 7 км, майже без гаку/);
  const parking = await copilot.ask("Де припаркуватись біля місця призначення?");
  assert.match(parking.text, /Паркінг Бориспіль-центр за 250 метрів/);
  const gps = await copilot.ask("Що з GPS?");
  assert.match(gps.text, /GNSS-сигнал у нормі/);
});

test("benchmark (sparse synthetic field): co-pilot picks beat straight-line 'nearby' search; legacy AI answers nothing", async () => {
  const run = await runBenchmark(60);
  const row = (q: string, m: string) => run.summary.find((s) => s.query === q && s.method === m)! as unknown as Record<string, number>;
  for (const q of ["fuel<=2min", "fuel<=5min", "fastfood<=10min", "restaurant-open<=10min"]) {
    const navia = row(q, "navia");
    assert.equal(navia.useful_answer_pct, 100, `${q}: navia useful`);
    assert.equal(navia.behind_pct, 0, `${q}: navia never behind`);
    assert.equal(navia.over_detour_limit_pct, 0, `${q}: navia never over the limit`);
    assert.ok((navia.closed_pct ?? 0) <= 5, `${q}: navia closed ${navia.closed_pct}%`);
    assert.equal(row(q, "navia_offline").useful_answer_pct, 100, `${q}: offline fallback useful`);
    assert.ok((row(q, "nearby").behind_pct ?? 0) >= 30, `${q}: straight-line nearby sends the driver back`);
    assert.equal(row(q, "legacy_ai").answered_pct, 0, `${q}: legacy regex AI cannot answer`);
  }
});
