// Spec section 36 ("E2E TEST"): the full deterministic scenario, driven
// against the real Kyiv-center -> Kyiv-Oblast (Boryspil) demo route.
// "The test must output a report" — this writes the report as JSON next to
// the test output (packages/core/test/e2e-report.json) in addition to
// asserting on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runE2ESimulation } from "../src/e2e-simulation";
import { kyivToBoryspilGraph } from "./fixtures/kyiv-oblast-graph";
import type { POI } from "../src/landmark-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("E2E: full Kyiv -> Boryspil drive through GNSS degradation, loss, recovery, and arrival", async () => {
  // Placed ~450m into the first leg (maidan -> livoberezhna), i.e. genuinely
  // ahead of where the simulated drive is by the time the landmark step
  // runs (~32s in at 11 m/s = ~352m traveled) — a real on-route landmark,
  // not one invented to make the assertion pass.
  const pois: POI[] = [
    { id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: { lat: 50.4503, lon: 30.5297 } },
  ];

  const report = await runE2ESimulation({
    graph: kyivToBoryspilGraph,
    origin: { lat: 50.4501, lon: 30.5234 }, // Maidan Nezalezhnosti
    destination: { lat: 50.3450, lon: 30.9526 }, // Boryspil
    pois,
    landmarkQuery: "WOG",
    maxTicks: 5000,
  });

  writeFileSync(join(__dirname, "e2e-report.json"), JSON.stringify(report, null, 2));

  for (const step of report.steps) {
    assert.ok(step.passed, `E2E step failed: ${step.step} — ${step.detail}`);
  }
  assert.equal(report.success, true);
  assert.equal(report.finalMode, "ARRIVED");
  // The landmark step should have genuinely confirmed (not just "didn't crash") —
  // it's a real on-route POI, so a no_match/ambiguous result here would mean a bug.
  const landmarkStep = report.steps.find((s) => s.step === "landmark-confirmed-only-with-data")!;
  assert.match(landmarkStep.detail, /^confirmed:/);
  // Real telemetry was recorded throughout (GNSS_FIX/DEGRADED/LOST/RECOVERY events).
  assert.ok(report.events.some((e) => e.type === "GNSS_LOST"));
  assert.ok(report.events.some((e) => e.type === "RECOVERY"));
});
