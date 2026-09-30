// Live traffic from point flow samples (a TomTom-style feed): slowdowns only
// where the feed says so; an unanswering feed is "unavailable", not "no jams".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PointFlowTrafficProvider } from "../src/traffic";
import type { Route } from "../src/route-engine";

const route = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "osm-kyiv-kharkivska-pozniaky.json"), "utf8")) as { routes: { route: Route }[] }).routes[0]!.route;

test("a slow sample becomes a delay with the extra time; free flow gives none", async () => {
  let i = 0;
  const p = new PointFlowTrafficProvider(async () => (i++ === 2 ? { currentMps: 3, freeFlowMps: 15, confidence: 0.9 } : { currentMps: 14, freeFlowMps: 15, confidence: 0.9 }), "test feed");
  const r = await p.getTrafficAlongRoute(route, 0, 6000);
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.delays.length, 1);
  assert.equal(r.delays[0]!.severity, "heavy");
  assert.ok(r.delays[0]!.delayS > 200 && r.delays[0]!.delayS < 300, String(r.delays[0]!.delayS));
});

test("a feed that answers nothing is unavailable (never 'no traffic')", async () => {
  const r = await new PointFlowTrafficProvider(async () => null, "test feed").getTrafficAlongRoute(route, 0, 5000);
  assert.equal(r.available, false);
});
