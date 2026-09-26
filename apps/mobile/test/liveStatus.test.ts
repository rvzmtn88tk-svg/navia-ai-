// Map beacons and the details panel read one shared status logic: the same
// colours on the home map and in navigation, and panel values straight from
// the engine state.
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine, type NavigationState } from "@navia/core";
import { alertPhase, gpsDetails, gpsTone, healthFrom, nextAlertEndedAt } from "../src/engine/liveStatus";
import type { GeolocatedAirAlert } from "../src/providers/GeolocatedAirAlertProvider";

const alert = (active: boolean | null, over: Partial<GeolocatedAirAlert> = {}): GeolocatedAirAlert =>
  ({ active, locationLabel: "Київ", region: "Київ", source: "alerts.in.ua", sourceUrl: "https://alerts.in.ua", updatedAt: 1_000, ...over });

test("beacon colour: green / yellow / red from the GNSS state; neutral before the first fix", () => {
  assert.deepEqual(gpsTone("ready", healthFrom("NORMAL")), { tone: "success", key: "gps.stable" });
  assert.deepEqual(gpsTone("ready", healthFrom("DEGRADED")), { tone: "warning", key: "gps.unstable" });
  assert.deepEqual(gpsTone("ready", healthFrom("LOST")), { tone: "critical", key: "gps.lost" });
  assert.equal(gpsTone("searching", "lost").tone, "neutral");
  assert.equal(gpsTone("permission", "lost").tone, "neutral");
});

test("alert end is remembered: active → clear gives 'ended', a new alert clears it", () => {
  let ended = nextAlertEndedAt(null, alert(true), null, 0);
  assert.equal(ended, null);
  ended = nextAlertEndedAt(alert(true), alert(false, { updatedAt: 5_000 }), ended, 6_000);
  assert.equal(ended, 5_000);
  assert.equal(alertPhase(alert(false), ended, 10_000), "ended");
  assert.equal(alertPhase(alert(false), ended, 5_000 + 31 * 60_000), "none", "after 30 min it is just 'no alert'");
  assert.equal(nextAlertEndedAt(alert(false), alert(true), ended, 20_000), null);
  assert.equal(alertPhase(alert(true), null, 0), "active");
  assert.equal(alertPhase(null, null, 0), "unknown", "no data is never reported as 'no alert'");
  assert.equal(alertPhase(alert(null), null, 0), "unknown");
});

test("demo route, GNSS normal → degraded → lost: panel values and beacon colour follow the engine", async () => {
  const demo = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await demo.start();
  const seen: string[] = [];
  const snap = (s: NavigationState) => {
    const d = gpsDetails(s);
    seen.push(`${s.gnss} ${gpsTone("ready", healthFrom(s.gnss)).tone} src=${d.source} acc=${d.accuracyM ?? "-"} unc=${d.uncertaintyM != null ? Math.round(d.uncertaintyM) : "-"} age=${d.lastTrustedFixAgeS ?? "-"}s`);
    return d;
  };
  for (let i = 0; i < 5; i++) demo.tick(1);
  const normal = snap(demo.getState());
  assert.equal(demo.getState().gnss, "NORMAL");
  assert.equal(normal.source, "GNSS");
  assert.equal(normal.accuracyM, 5);
  assert.equal(normal.lastTrustedFixAgeS, 0);

  demo.simulateGnssDegradation();
  for (let i = 0; i < 5; i++) demo.tick(1);
  const degraded = snap(demo.getState());
  assert.equal(demo.getState().gnss, "DEGRADED");
  assert.equal(gpsTone("ready", healthFrom(demo.getState().gnss)).tone, "warning");
  assert.equal(degraded.accuracyM, 60, "degraded demo GNSS reports ±60 m");

  demo.simulateGnssLoss();
  for (let i = 0; i < 8; i++) demo.tick(1);
  const lost = snap(demo.getState());
  assert.equal(demo.getState().gnss, "LOST");
  assert.equal(gpsTone("ready", healthFrom(demo.getState().gnss)).tone, "critical");
  assert.notEqual(lost.source, "GNSS", "without GNSS the source is not reported as GNSS");
  assert.equal(lost.accuracyM, null, "no GNSS accuracy is shown without GNSS");
  assert.ok((lost.lastTrustedFixAgeS ?? 0) >= 5, `fix age grows: ${lost.lastTrustedFixAgeS}`);
  console.log(seen.join("\n"));
});
