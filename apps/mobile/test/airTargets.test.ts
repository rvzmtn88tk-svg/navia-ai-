// Air targets from NEPTUN's open API, checked on a real response captured on
// 2026-09-29 18:41 UTC (test/fixtures/neptun-threats-2026-09-29.json):
// every listed track becomes a marker with its real coordinates, course and
// uncertainty; bad or finished tracks are dropped; a stale snapshot is an
// error, not "no targets"; the reported path grows only when a target moved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distanceToTarget, mergeTracks, parseTargets, targetsLine, type TargetsView } from "../src/providers/AirTargetsProvider";
import { uk, type StringKey } from "../src/i18n/strings";

const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", "neptun-threats-2026-09-29.json"), "utf8")) as { serverTime: string; threats: Record<string, unknown>[] };
const serverTime = Date.parse(raw.serverTime);
const t = (key: StringKey, params?: Record<string, string | number>) => uk[key].replace(/\{(\w+)\}/g, (m, n: string) => (params && n in params ? String(params[n]) : m));

test("a real NEPTUN snapshot becomes markers with the source's own values", () => {
  const snap = parseTargets(raw, serverTime + 2000);
  assert.equal(snap.targets.length, 32);
  const first = snap.targets.find((x) => x.id === "trk_00226917")!;
  assert.equal(first.kind, "uav");
  assert.equal(first.lat, 50.266507099690905);
  assert.equal(first.lon, 35.140450314231174);
  assert.equal(first.headingDeg, 230);
  assert.equal(first.uncertaintyKm, 4);
  assert.equal(first.quality, "approx");
  assert.equal(first.reports, 9);
  assert.equal(first.locality, "Котельва");
  for (const x of snap.targets) assert.ok(x.lat > 43 && x.lat < 53.5 && x.lon > 21 && x.lon < 41.5);
});

test("finished, broken and far-away tracks are not shown; old ones are marked stale", () => {
  const base = raw.threats[0]!;
  const now = serverTime + 1000;
  const snap = parseTargets({
    serverTime: raw.serverTime,
    threats: [
      { ...base, id: "resolved", status: "resolved" },
      { ...base, id: "nolat", lat: null },
      { ...base, id: "moscow", lat: 55.75, lon: 37.6 },
      { ...base, id: "old", updatedAt: new Date(serverTime - 40 * 60_000).toISOString() },
      { ...base, id: "quiet", updatedAt: new Date(serverTime - 12 * 60_000).toISOString() },
      { ...base, id: "area", areaOnly: true },
    ],
  }, now);
  assert.deepEqual(snap.targets.map((x) => x.id), ["quiet", "area"]);
  assert.equal(snap.targets[0]!.stale, true);
  assert.equal(snap.targets[1]!.quality, "area");
});

test("a snapshot the source stopped updating is an error, never an empty map", () => {
  assert.throws(() => parseTargets(raw, serverTime + 10 * 60_000), /застарів/);
  assert.throws(() => parseTargets({ serverTime: raw.serverTime }, serverTime), /немає списку/);
  assert.throws(() => parseTargets("<html>", serverTime), /не є JSON/);
  const down: TargetsView = { status: "error", targets: [], serverTime: null, error: "немає зв'язку з джерелом" };
  assert.match(targetsLine(down, t, "uk").text, /тимчасово недоступні.*не означає, що цілей немає/);
  const outdated: TargetsView = { status: "error", targets: [], serverTime, error: "немає зв'язку з джерелом" };
  assert.match(targetsLine(outdated, t, "uk").text, /Показано дані на .* не означає, що цілей немає/);
  const none: TargetsView = { status: "ready", targets: [], serverTime, error: null };
  assert.match(targetsLine(none, t, "uk").text, /Активних цілей у джерелі зараз немає · оновлено/);
});

test("the path is only what the source reported: a point per real move", () => {
  const snap = parseTargets(raw, serverTime + 1000);
  const a = snap.targets[0]!;
  let tracks = mergeTracks({}, [a]);
  tracks = mergeTracks(tracks, [a]); // same position again: no new point
  assert.equal(tracks[a.id]!.length, 1);
  tracks = mergeTracks(tracks, [{ ...a, lat: a.lat - 0.05, lon: a.lon - 0.06, updatedAt: a.updatedAt + 90_000 }]);
  assert.equal(tracks[a.id]!.length, 2);
  assert.deepEqual(Object.keys(mergeTracks(tracks, [])), [], "a track the source dropped is dropped");
});

test("distance from me to a tapped target: rounded like the source's own accuracy, with the side", () => {
  const kyiv = { lat: 50.4501, lon: 30.5234 };
  const kotelva = { lat: 50.266507099690905, lon: 35.140450314231174 }; // trk_00226917 from the real snapshot
  const d = distanceToTarget(kyiv, kotelva);
  assert.equal(d.km, 330, "≈ 329 km, rounded to 5 km past 50 km");
  assert.ok(d.bearingDeg > 90 && d.bearingDeg < 100, `east of Kyiv, got ${d.bearingDeg}`);
  assert.equal(distanceToTarget(kyiv, { lat: 50.52, lon: 30.52 }).km, 8);
  assert.equal(distanceToTarget(kyiv, kyiv).km, 1, "never 0 — the target's position is not that exact");
});
