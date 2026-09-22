// Confirms the package's public barrel (./src/index.ts) resolves cleanly —
// i.e. that types.ts, geodesy.ts and gnss-monitor.ts's exports don't collide
// (a real bug caught here during scaffolding: both geodesy.ts and types.ts
// declared their own `LatLon`, and gnss-monitor.ts's flat GNSSSample
// collided with types.ts's nested GNSSSample; fixed by making geodesy.ts
// re-export types.ts's LatLon and renaming gnss-monitor.ts's local type to
// GNSSRawSample).
import {test} from "node:test";
import assert from "node:assert/strict";
import type {NavigationState, NavigationMode, Landmark} from "../src/types";
import {haversineMeters, type LatLon} from "../src/index";

test("types: NavigationState shape is usable and LatLon is shared across modules", () => {
  const origin: LatLon = {lat: 50.45, lon: 30.52};
  const mode: NavigationMode = "ACTIVE";
  const landmark: Landmark = {
    id: "lm1", name: "WOG", type: "fuel", location: origin,
    sideOfRoad: "right", distanceM: 120, routeRelevance: 0.8,
  };
  const state: NavigationState = {
    mode, position: null, trustedPosition: null, gnss: "NORMAL",
    confidence: 0.9, confidenceBand: "HIGH", speedMps: 10, headingDeg: 90,
    routeProgressM: 100, routeRemainingM: 900, nextStep: null,
    nearbyLandmarks: [landmark], offRoute: false, networkAvailable: true,
    offlineMapAvailable: false, lastTrustedFixAt: Date.now(), updatedAt: Date.now(),
  };
  assert.equal(state.mode, "ACTIVE");
  assert.equal(state.nearbyLandmarks[0]?.name, "WOG");
  assert.equal(haversineMeters(origin, origin), 0);
});
