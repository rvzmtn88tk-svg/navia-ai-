// "Away from home the dot disappears": at home the iPhone has the owner's Wi-Fi
// (10–30 m); elsewhere it often reports ~65 m for a while. The navigation
// engine rightly does not navigate by that — but the home map must still show
// where the phone is, with its error circle, and must not follow a jump.
import test from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine, destinationPoint, type GNSSRawSample, type RoutingProvider } from "@navia/core";
import { plausibleApproxFix, shownFix } from "../src/engine/approxFix";

const noRouting = {} as RoutingProvider;
const HOME = { lat: 50.4501, lon: 30.5234 };
const AWAY = destinationPoint(HOME, 90, 5000);
const fix = (p: { lat: number; lon: number }, t: number, accuracyM: number): GNSSRawSample => ({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM, speedMps: null, headingDeg: null });

test("reproduced: 65 m fixes away from home are never trusted by the engine (the old home map showed nothing)", () => {
  const engine = new NavigationEngine({ routingProvider: noRouting });
  let t = 1_000_000;
  for (let i = 0; i < 20; i++, t += 1000) {
    engine.pushGnssSample(fix(AWAY, t, 65), t);
    engine.tick(t);
  }
  assert.equal(engine.getState().trustedPosition, null);
  // The same place with the home Wi-Fi accuracy is trusted at once.
  engine.pushGnssSample(fix(AWAY, t, 20), t);
  assert.ok(engine.tick(t).trustedPosition);
});

test("the home map shows a plausible approximate fix with its error circle", () => {
  const now = 2_000_000;
  assert.equal(plausibleApproxFix(fix(AWAY, now - 500, 65), null, now), true);
  assert.equal(plausibleApproxFix(fix(AWAY, now - 500, 900), null, now), true);
  // A city-wide guess or a stale fix is not a position.
  assert.equal(plausibleApproxFix(fix(AWAY, now - 500, 3000), null, now), false);
  assert.equal(plausibleApproxFix(fix(AWAY, now - 20_000, 65), null, now), false);
  // Walked 5 km with the app closed (an hour later): fine.
  assert.equal(plausibleApproxFix(fix(AWAY, now, 65), fix(HOME, now - 3_600_000, 15), now), true);
  // 5 km in 2 seconds: a jump (spoofing / garbage) — not drawn.
  assert.equal(plausibleApproxFix(fix(AWAY, now, 65), fix(HOME, now - 2000, 15), now), false);
});

test("a trusted fix wins unless the approximate one is clearly newer", () => {
  const trusted = fix(HOME, 1_000_000, 10);
  assert.equal(shownFix(trusted, null), trusted);
  assert.equal(shownFix(null, fix(AWAY, 1_000_000, 65))?.accuracyM, 65);
  assert.equal(shownFix(trusted, fix(AWAY, 1_005_000, 65)), trusted);
  assert.equal(shownFix(trusted, fix(AWAY, 1_060_000, 65))?.accuracyM, 65);
});
