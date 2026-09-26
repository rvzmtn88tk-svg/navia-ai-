// Fix 3/10: the HUD's next maneuver must be the turn that really comes next.
// Real Valhalla responses (recorded 2026-09-26 from valhalla1.openstreetmap.de,
// Kyiv) are driven through the real NavigationEngine with GNSS samples every
// 5 m, and state.nextStep (what the HUD card, arrow and voice read) is compared
// with the route geometry at every sample.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEMO_DESTINATION, DEMO_KYIV_TO_BORYSPIL_GRAPH, DEMO_ORIGIN, DEMO_POIS, DemoEngine, NavigationEngine, haversineMeters, initialBearing, positionAtDistance, signedTurnDeg, type Route, type RoutingProvider } from "@navia/core";
import { mapManeuverType, valhallaLegToRoute, type ValhallaLeg } from "../src/providers/OnlineValhallaProvider";
import { instructionPhrase } from "../src/voice/guidance";

const DIR = join(__dirname, "fixtures/valhalla-routes");

type Fixture = { name: string; leg: ValhallaLeg; route: Route; cum: number[]; starts: number[] };

function load(name: string): Fixture {
  const json = JSON.parse(readFileSync(join(DIR, name), "utf8")) as { trip: { legs: ValhallaLeg[]; summary: { length: number; time: number } } };
  const leg = json.trip.legs[0]!;
  const route = valhallaLegToRoute(leg, json.trip.summary, name);
  const g = route.geometry;
  const cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1]! + haversineMeters(g[i - 1]!, g[i]!));
  // Where each maneuver really is on the line: Valhalla's begin_shape_index.
  const starts = leg.maneuvers.map((m) => cum[m.begin_shape_index]!);
  return { name, leg, route, cum, starts };
}

/** The maneuver that geometrically comes next after `alongM` metres. */
function truthAt(f: Fixture, alongM: number): number {
  return f.starts.findIndex((s) => s > alongM);
}

/** Drives the route through NavigationEngine (GNSS every 5 m at 10 m/s) up to `untilM`; calls `onSample` with the engine state. */
async function drive(f: Fixture, untilM: number, onSample?: (alongM: number, engine: NavigationEngine) => void, noiseM = 0): Promise<NavigationEngine> {
  const provider: RoutingProvider = { route: async () => f.route, match: async () => ({ matchedPoints: [], roadSegmentIds: [] }), searchAlternatives: async () => [f.route] };
  const engine = new NavigationEngine({ routingProvider: provider });
  const g = f.route.geometry;
  await engine.requestRoute(g[0]!, g[g.length - 1]!, "car");
  const t0 = 1_000_000;
  for (let d = 0, k = 0; d <= untilM; d += 5, k++) {
    const onLine = positionAtDistance(g, d);
    const ahead = positionAtDistance(g, Math.min(d + 5, f.cum[f.cum.length - 1]!));
    // Deterministic GPS-like error across the road (±noiseM).
    const off = noiseM * Math.sin(k * 1.7) * Math.cos(k * 0.37);
    const brg = (initialBearing(onLine, ahead) + 90) * Math.PI / 180;
    const here = noiseM ? { lat: onLine.lat + (off * Math.cos(brg)) / 111_320, lon: onLine.lon + (off * Math.sin(brg)) / (111_320 * Math.cos(onLine.lat * Math.PI / 180)) } : onLine;
    const t = t0 + k * 500;
    engine.pushGnssSample({ lat: here.lat, lon: here.lon, timestamp: t, accuracyM: 5, speedMps: 10, headingDeg: haversineMeters(onLine, ahead) > 1 ? initialBearing(onLine, ahead) : null }, t);
    engine.tick(t);
    onSample?.(d, engine);
  }
  return engine;
}

function hudText(engine: NavigationEngine): string {
  const s = engine.getState();
  return instructionPhrase(s.nextStep!, s.nextStepDistanceM ?? null, "uk");
}

test("explicit RIGHT turn (Коперника → «Поверніть праворуч», route with a U-turn and return): the HUD says right", async () => {
  const f = load("kyiv_kopernyka_uturn.json");
  assert.equal(f.leg.maneuvers[2]!.type, 10, "Valhalla: kRight");
  const engine = await drive(f, 120);
  const s = engine.getState();
  assert.equal(s.nextStep?.id, f.route.steps[2]!.id, `HUD shows ${s.nextStep?.maneuver} (${s.nextStep?.roadName || "—"})`);
  assert.equal(s.nextStep?.maneuver, "right");
  assert.match(hudText(engine), /праворуч/);
});

test("explicit LEFT turn (Ярославів Вал loop → «Поверніть ліворуч на Рейтарська вулиця»): the HUD says left", async () => {
  const f = load("kyiv_yaroslaviv_val_loop.json");
  assert.equal(f.leg.maneuvers[6]!.type, 15, "Valhalla: kLeft");
  const engine = await drive(f, 1145);
  const s = engine.getState();
  assert.equal(s.nextStep?.id, f.route.steps[6]!.id, `HUD shows ${s.nextStep?.maneuver} (${s.nextStep?.roadName || "—"})`);
  assert.equal(s.nextStep?.maneuver, "left");
  assert.equal(s.nextStep?.roadName, "Рейтарська вулиця");
  assert.match(hudText(engine), /ліворуч/);
});

test("U-TURN (Костянтинівська → «Розверніться ліворуч»): the HUD says U-turn, not arrival", async () => {
  const f = load("kyiv_kostiantynivska_uturn.json");
  assert.equal(f.leg.maneuvers[11]!.type, 13, "Valhalla: kUturnLeft");
  const engine = await drive(f, 1690);
  const s = engine.getState();
  assert.equal(s.nextStep?.id, f.route.steps[11]!.id, `HUD shows ${s.nextStep?.maneuver}`);
  assert.equal(s.nextStep?.maneuver, "uturn");
  assert.match(hudText(engine), /розвертайтеся|розверніться/i);
});

test("Valhalla type → left/right agrees with the geometry of every turn on all recorded routes", () => {
  let checked = 0;
  for (const name of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
    const f = load(name);
    for (const [i, m] of f.leg.maneuvers.entries()) {
      const mapped = mapManeuverType(m.type);
      const side = /left/.test(mapped) ? "left" : /right/.test(mapped) ? "right" : mapped === "uturn" ? "uturn" : null;
      if (!side || i === 0) continue;
      // Geometry only (not Valhalla's own bearings): direction of travel
      // 15 m before → 15 m after the maneuver point. A U-turn can run along a
      // wide arc (Оболонський проспект: 172° → 1° over ~90 m), so for U-turns
      // the largest change of direction up to the next maneuver (≤ 100 m) counts.
      const at = f.starts[i]!;
      const g = f.route.geometry;
      const approach = initialBearing(positionAtDistance(g, Math.max(0, at - 15)), positionAtDistance(g, at));
      let turn = signedTurnDeg(approach, initialBearing(positionAtDistance(g, at), positionAtDistance(g, at + 15)));
      if (side === "uturn") {
        const end = Math.min(at + 100, f.starts[i + 1] ?? at + 100);
        for (let d = at; d + 5 <= end; d += 1) {
          const t = signedTurnDeg(approach, initialBearing(positionAtDistance(g, d), positionAtDistance(g, d + 5)));
          if (Math.abs(t) > Math.abs(turn)) turn = t;
        }
      }
      if (side === "uturn") assert.ok(Math.abs(turn) > 120, `${name} #${i} ${m.instruction}: U-turn but the line turns ${turn.toFixed(0)}°`);
      else if (Math.abs(turn) > 20) assert.equal(turn > 0 ? "right" : "left", side, `${name} #${i} ${m.instruction}: ${mapped} but the line turns ${turn.toFixed(0)}°`);
      checked++;
    }
  }
  console.log(`type ↔ geometry: ${checked} turns checked on ${readdirSync(DIR).length} routes`);
  assert.ok(checked > 100, `checked ${checked} turns`);
});

test("whole-route simulation, 11 real routes (≈160 km): the HUD's next maneuver matches the geometry at every 5 m", async () => {
  const log: string[] = [];
  let samples = 0, wrong = 0;
  for (const name of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
    const f = load(name);
    const total = f.cum[f.cum.length - 1]!;
    let lastShown = "";
    let routeWrong = 0;
    const examples: string[] = [];
    await drive(f, total - 1, (d, engine) => {
      if (f.starts.some((s) => Math.abs(s - d) < 1)) return; // exactly on a maneuver point: either answer is right
      const truth = truthAt(f, d);
      if (truth < 0) return;
      const s = engine.getState();
      samples++;
      const shownIdx = f.route.steps.findIndex((st) => st.id === s.nextStep?.id);
      const shown = `#${shownIdx} ${s.nextStep?.maneuver}`;
      if (shown !== lastShown) { log.push(`  ${name.replace(".json", "")} ${String(d).padStart(6)} m → HUD ${shown} ${s.nextStep?.roadName ?? ""}`.trimEnd()); lastShown = shown; }
      if (shownIdx !== truth) {
        routeWrong++;
        if (examples.length < 3) examples.push(`${d} m: HUD #${shownIdx} ${s.nextStep?.maneuver}, real #${truth} ${f.route.steps[truth]!.maneuver}`);
      }
    });
    wrong += routeWrong;
    log.push(`${name}: ${(total / 1000).toFixed(1)} km, ${f.route.steps.length} maneuvers, wrong HUD samples: ${routeWrong}${examples.length ? " — " + examples.join("; ") : ""}`);
  }
  console.log(log.filter((l) => !l.startsWith("  ") || process.env.HUD_LOG).join("\n"));
  console.log(`whole routes: ${samples} samples, wrong: ${wrong}`);
  assert.equal(wrong, 0, `${wrong} of ${samples} samples show the wrong next maneuver`);
});

test("whole-route simulation with GPS error ±5 m across the road: still no wrong next maneuver", async () => {
  let samples = 0, wrong = 0;
  const examples: string[] = [];
  for (const name of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
    const f = load(name);
    await drive(f, f.cum[f.cum.length - 1]! - 1, (d, engine) => {
      // Within twice the GPS error of a maneuver point (a corner: the
      // position can be on either street) either answer is acceptable.
      if (f.starts.some((s) => Math.abs(s - d) < 10)) return;
      const truth = truthAt(f, d);
      if (truth < 0) return;
      samples++;
      const shownIdx = f.route.steps.findIndex((st) => st.id === engine.getState().nextStep?.id);
      if (shownIdx !== truth) { wrong++; if (examples.length < 5) examples.push(`${name} ${d} m: HUD #${shownIdx}, real #${truth}`); }
    }, 5);
  }
  console.log(`GPS ±5 m: ${samples} samples, wrong: ${wrong}${examples.length ? " — " + examples.join("; ") : ""}`);
  assert.equal(wrong, 0);
});

test("Demo Mode (DemoEngine, Київ → Бориспіль) from start to arrival: every HUD maneuver matches the route line", async () => {
  const demo = new DemoEngine({ graph: DEMO_KYIV_TO_BORYSPIL_GRAPH, origin: DEMO_ORIGIN, destination: DEMO_DESTINATION, pois: DEMO_POIS });
  await demo.start();
  const route = demo.getRoute()!;
  const g = route.geometry;
  const cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1]! + haversineMeters(g[i - 1]!, g[i]!));
  const starts = route.steps.map((s) => cum[s.geometryIndex!]!);
  const log: string[] = [];
  let lastShown = "", checked = 0;
  for (let k = 0; k < 4000; k++) {
    const s = demo.tick(1);
    const along = s.routeProgressM;
    if (s.nextStep?.id !== lastShown) {
      lastShown = s.nextStep?.id ?? "";
      log.push(`  ${String(Math.round(along)).padStart(6)} m → HUD ${s.nextStep?.maneuver} ${s.nextStep?.roadName ?? ""} (${instructionPhrase(s.nextStep!, s.nextStepDistanceM ?? null, "uk")})`);
    }
    if (!starts.some((st) => Math.abs(st - along) < 1)) {
      const truth = starts.findIndex((st) => st > along);
      if (truth >= 0) { assert.equal(s.nextStep?.id, route.steps[truth]!.id, `${along.toFixed(0)} m`); checked++; }
    }
    if (s.mode === "ARRIVED" || route.distanceM - along < 1) break;
  }
  // The turns themselves, from the line (not from the maneuver table).
  for (const [i, st] of route.steps.entries()) {
    if (!/left|right/.test(st.maneuver)) continue;
    const turn = signedTurnDeg(initialBearing(g[st.geometryIndex! - 1]!, g[st.geometryIndex!]!), initialBearing(g[st.geometryIndex!]!, g[st.geometryIndex! + 1]!));
    assert.equal(turn > 0 ? "right" : "left", /left/.test(st.maneuver) ? "left" : "right", `demo step ${i}: ${st.maneuver} but the line turns ${turn.toFixed(0)}°`);
  }
  console.log(`Demo Mode: ${checked} ticks checked\n${log.join("\n")}`);
  assert.ok(checked > 100);
});
