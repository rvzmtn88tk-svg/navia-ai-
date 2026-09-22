// Spec section 16's "never invent" policy: never invent POIs, never claim
// GPS healthy without data, must say so when confidence is low, must never
// give a precise turn distance when position is untrustworthy.
import {test} from "node:test";
import assert from "node:assert/strict";
import {AIEngine, DeterministicDemoAIProvider, RemoteLLMProvider, type NavigationContext} from "../src/ai-engine";
import {DemoRoutingProvider} from "../src/demo-routing-provider";
import type {POI} from "../src/landmark-engine";
import type {NavigationState} from "../src/types";
import {demoGraph} from "./fixtures/demo-graph";

const provider = new DemoRoutingProvider(demoGraph);

async function buildContext(overrides: Partial<NavigationState> = {}, pois: POI[] = []): Promise<NavigationContext> {
  const route = await provider.route({origin: {lat: 50.4501, lon: 30.5234}, destination: {lat: 50.4501, lon: 30.5366}});
  const state: NavigationState = {
    mode: "ACTIVE",
    position: null,
    trustedPosition: {
      position: {lat: 50.4501, lon: 30.5250, timestamp: Date.now(), accuracyM: 5, source: "GNSS"},
      confidence: 0.9, band: "HIGH", source: "GNSS",
    },
    gnss: "NORMAL",
    confidence: 0.9,
    confidenceBand: "HIGH",
    speedMps: 10,
    headingDeg: 90,
    routeProgressM: 100,
    routeRemainingM: route.distanceM - 100,
    nextStep: route.steps[1] ?? null,
    nearbyLandmarks: [],
    offRoute: false,
    networkAvailable: true,
    offlineMapAvailable: true,
    lastTrustedFixAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  return { state, route, nearbyLandmarks: [], nearbyPOI: pois, recentEvents: [] };
}

test("AIEngine getters: return exactly the context's own data, nothing invented", async () => {
  const ctx = await buildContext();
  assert.equal(AIEngine.getNavigationState(ctx), "ACTIVE");
  assert.equal(AIEngine.getGNSSState(ctx), "NORMAL");
  assert.deepEqual(AIEngine.getPositionConfidence(ctx), {confidence: 0.9, band: "HIGH"});
  assert.equal(AIEngine.getOffRouteStatus(ctx), false);
  assert.deepEqual(AIEngine.getLastTrustedPosition(ctx), ctx.state.trustedPosition);
  const dest = AIEngine.getDestination(ctx);
  assert.deepEqual(dest, ctx.route!.geometry[ctx.route!.geometry.length - 1]);
});

test("AIEngine.searchNearbyPOI: only returns POIs actually present in context (cannot invent)", async () => {
  const pois: POI[] = [{id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.45, lon: 30.53}}];
  const ctx = await buildContext({}, pois);
  const found = AIEngine.searchNearbyPOI(ctx, "WOG");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "wog-1");
  const notFound = AIEngine.searchNearbyPOI(ctx, "Silpo"); // not in context at all
  assert.equal(notFound.length, 0);
});

const ai = new DeterministicDemoAIProvider();

test("AI provider: gives a precise next-turn distance when confidence is HIGH", async () => {
  const ctx = await buildContext({confidenceBand: "HIGH"});
  const reply = await ai.answer(ctx, "Куди наступний поворот?");
  assert.match(reply, /за \d+ м/);
});

test("AI provider: policy — refuses to give a precise turn distance under LOW confidence, says so", async () => {
  const ctx = await buildContext({confidenceBand: "LOW"});
  const reply = await ai.answer(ctx, "Куди наступний поворот?");
  assert.doesNotMatch(reply, /за \d+ м/);
  assert.match(reply, /неточна/);
});

test("AI provider: policy — never claims GPS is healthy without data (GNSS lost)", async () => {
  const ctx = await buildContext({gnss: "LOST", confidenceBand: "UNKNOWN", confidence: 0.1});
  const reply = await ai.answer(ctx, "Який зараз сигнал GPS?");
  assert.match(reply, /втрачено/);
  assert.doesNotMatch(reply, /у нормі/);
});

test("AI provider: honestly reports low confidence when asked about position", async () => {
  const ctx = await buildContext({confidenceBand: "UNKNOWN", confidence: 0.1});
  const reply = await ai.answer(ctx, "Де я зараз?");
  assert.match(reply, /Не можу надійно визначити позицію/);
});

test("AI provider: landmark query only confirms a POI that's genuinely in context and on-route", async () => {
  const pois: POI[] = [{id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: {lat: 50.4501, lon: 30.5260}}];
  const ctx = await buildContext({}, pois);
  const reply = await ai.answer(ctx, "Я бачу WOG. Це моя заправка?");
  assert.match(reply, /WOG/);
  assert.match(reply, /метрів/);
});

test("AI provider: does not fabricate a landmark answer for a brand never mentioned in context", async () => {
  const ctx = await buildContext({}, []); // no POIs at all
  const reply = await ai.answer(ctx, "Я бачу Silpo. Це поруч з маршрутом?");
  // Falls through to the generic fallback rather than inventing a POI.
  assert.match(reply, /позиці|GNSS|маршрут|орієнтир/i);
});

test("RemoteLLMProvider: honest not-implemented stub, never silently answers", async () => {
  const provider2 = new RemoteLLMProvider("https://example.invalid/ai-proxy");
  const ctx = await buildContext();
  await assert.rejects(() => provider2.answer(ctx, "Де я?"), /not implemented/);
});
