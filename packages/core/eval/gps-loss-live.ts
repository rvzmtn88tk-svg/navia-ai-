// LIVE check of the "GPS is gone — where am I?" dialogue: the real model
// (through the NAVIA proxy), the app's NavigationEngine in route dead
// reckoning, REAL recorded map data of Kyiv (test/fixtures/osm-*.json).
// Every check is deterministic over the tool trace and the reply text.
//   NAVIA_BACKEND_URL=https://… NAVIA_BACKEND_TOKEN=… npx tsx packages/core/eval/gps-loss-live.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NaviaCopilot } from "../src/copilot/copilot";
import { EngineCopilotRuntime } from "../src/copilot/runtime";
import { BackendLLMClient } from "../src/copilot/backend-client";
import { TripPlanner } from "../src/trip-planner";
import { NavigationEngine } from "../src/navigation-engine";
import { haversineMeters, destinationPoint, initialBearing } from "../src/geodesy";
import type { Route, RoutingProvider } from "../src/route-engine";
import type { MapFeature } from "../src/landmark-localizer";
import type { LatLon } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
type Fx = { features: MapFeature[]; junctions: LatLon[]; routes: { route: Route }[] };
const load = (n: string): Fx => JSON.parse(readFileSync(join(here, "..", "test", "fixtures", `osm-${n}.json`), "utf8"));
const METRO = load("kyiv-kharkivska-pozniaky");
const FORA = load("kyiv-two-fora");

function along(route: Route, m: number): LatLon {
  let acc = 0; const g = route.geometry;
  for (let i = 1; i < g.length; i++) { const seg = haversineMeters(g[i - 1]!, g[i]!); if (acc + seg >= m) return destinationPoint(g[i - 1]!, initialBearing(g[i - 1]!, g[i]!), m - acc); acc += seg; }
  return g[g.length - 1]!;
}
const noRouting: RoutingProvider = { route: () => Promise.reject(new Error("offline")), match: () => Promise.reject(new Error("offline")), searchAlternatives: () => Promise.reject(new Error("offline")) };

function world(fx: Fx, lostAtM: number, lostS: number) {
  const route = fx.routes[0]!.route;
  const engine = new NavigationEngine({ routingProvider: noRouting, resilient: false });
  engine.applyRoute(route);
  let seed = 11;
  const vib = (a: number) => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * a; };
  const imu = (t: number) => { for (let k = 0; k < 10; k++) engine.pushImuSample({ timestamp: t + k * 100, accelX: vib(0.6), accelY: vib(0.6), accelZ: -9.81 + vib(0.8), gyroX: vib(0.02), gyroY: vib(0.02), gyroZ: vib(0.02) }); };
  let t = Date.now() - (lostS + 40) * 1000;
  for (let m = Math.max(0, lostAtM - 360); m <= lostAtM; m += 12, t += 1000) {
    const p = along(route, m);
    engine.pushGnssSample({ lat: p.lat, lon: p.lon, timestamp: t, accuracyM: 5, speedMps: 12, headingDeg: null }, t);
    imu(t); engine.tick(t);
  }
  for (let i = 0; i < lostS; i++, t += 1000) { imu(t); engine.tick(t); }
  const now = t;
  const runtime = new EngineCopilotRuntime({
    host: engine, planner: new TripPlanner(noRouting), now: () => new Date(now),
    mapFeatures: async (c, r) => ({ features: fx.features.filter((f) => haversineMeters(c, f.location) <= r), junctions: fx.junctions.filter((j) => haversineMeters(c, j) <= r) }),
  });
  const llm = new BackendLLMClient({ baseUrl: process.env.NAVIA_BACKEND_URL!, clientToken: process.env.NAVIA_BACKEND_TOKEN, timeoutMs: 60_000 });
  return new NaviaCopilot({ runtime, llm, aiEnabled: () => true });
}

type Turn = { say: string; checks: [string, (r: { text: string; tools: { tool: string; isError: boolean; status?: string; input: unknown }[] }) => boolean][] };
type Scenario = { name: string; make: () => NaviaCopilot; turns: Turn[] };

const called = (r: { tools: { tool: string }[] }, name: string) => r.tools.some((x) => x.tool === name);
const ok = (r: { tools: { tool: string; isError: boolean }[] }, name: string) => r.tools.some((x) => x.tool === name && !x.isError);
/** No maneuver distance in metres ("in 60 m", "через 80 метрів"); an honest "accuracy about 100 m" is fine. */
const noMetres = (t: string) => !/(через|in|за)\s+(приблизно\s+|примерно\s+|около\s+)?\d+\s*(м\b|m\b|метр)/i.test(t);
/** A question or a request to name what they see ("назовіть…", "скажите, что видите"). */
const asks = (t: string) => t.includes("?") || /(скаж|назов|назв|дайте (мені |мне )?знати|дайте знать|бачите|видите|розкажіть|расскажите|опишіть|опишите|підтвердіть|подтвердите)/i.test(t);

const khPos = 3910, pzPos = 2639; // along the Bazhana route (fixture)
const SCENARIOS: Scenario[] = [
  {
    name: "S1 GPS lost: «Пропал навигатор» → honest state + asks what the driver sees",
    make: () => world(METRO, khPos - 900, 60),
    turns: [{ say: "Пропал навигатор, что делать?", checks: [
      ["no position fix without evidence", (r) => !called(r, "confirm_position")],
      ["asks what the driver sees", (r) => asks(r.text)],
      ["no exact metres", (r) => noMetres(r.text)],
    ] }],
  },
  {
    name: "S2 metro + Дніпро-М opposite, estimate near Kharkivska → locate, fix, guide",
    make: () => world(METRO, khPos - 900, 60),
    turns: [
      { say: "Вижу станцию метро, хз какая, а напротив магазин Днипро-М", checks: [
        ["locate_by_description called", (r) => called(r, "locate_by_description")],
        ["position fixed", (r) => ok(r, "confirm_position")],
        ["names Kharkivska", (r) => /Харків|Харьков/i.test(r.text)],
        ["does not name Pozniaky", (r) => !/Позняк/i.test(r.text)],
      ] },
      { say: "Нет, я не там", checks: [["undo_position_fix called", (r) => ok(r, "undo_position_fix")]] },
    ],
  },
  {
    name: "S3 same words between the stations → one question (Pozniaky or Kharkivska), then the answer fixes it",
    make: () => world(METRO, (khPos + pzPos) / 2 - 1800, 150),
    turns: [
      { say: "Вижу станцию метро, хз какая, а напротив магазин Днипро-М", checks: [
        ["locate_by_description called", (r) => called(r, "locate_by_description")],
        ["no fix while ambiguous", (r) => !ok(r, "confirm_position")],
        ["asks Pozniaky or Kharkivska", (r) => /Позняк/i.test(r.text) && /Харків|Харьков/i.test(r.text) && r.text.includes("?")],
      ] },
      { say: "Харьковская", checks: [["fixed after the answer", (r) => ok(r, "confirm_position")]] },
    ],
  },
  {
    name: "S4 a landmark the map does not have → says so, asks for another, invents nothing",
    make: () => world(METRO, khPos - 900, 60),
    turns: [{ say: "Вижу справа Икею", checks: [
      ["locate_by_description called", (r) => called(r, "locate_by_description")],
      ["no fix", (r) => !called(r, "confirm_position")],
      ["asks for something else", (r) => asks(r.text)],
    ] }],
  },
  {
    name: "S5 two Fora stores (Russian) → asks the side of the road",
    make: () => world(FORA, 450, 25),
    turns: [{ say: "Вижу Фору, а за ней перекрёсток", checks: [
      ["locate_by_description called", (r) => called(r, "locate_by_description")],
      ["no fix while ambiguous", (r) => !ok(r, "confirm_position")],
      ["asks left or right", (r) => /(справа|слева|праворуч|ліворуч|right|left)/i.test(r.text) && r.text.includes("?")],
    ] }],
  },
];

async function main() {
  if (!process.env.NAVIA_BACKEND_URL) { console.error("Set NAVIA_BACKEND_URL and NAVIA_BACKEND_TOKEN"); process.exit(2); }
  const lines: string[] = [`# Live check: GPS loss → locate by what the driver sees`, ``, `Run ${new Date().toISOString()} · real model through the NAVIA proxy · real OSM data of Kyiv (fixtures) · NavigationEngine route dead reckoning.`, ``];
  let pass = 0, total = 0;
  for (const s of SCENARIOS) {
    const copilot = s.make();
    lines.push(`## ${s.name}`, ``);
    for (const turn of s.turns) {
      const t0 = Date.now();
      const reply = await copilot.ask(turn.say);
      const tools = (reply.trace ?? []).map((x) => ({ tool: x.tool, isError: x.isError, status: (x.result as { status?: string; error?: string } | null)?.status ?? (x.result as { error?: string } | null)?.error, input: x.input }));
      const r = { text: reply.text, tools };
      lines.push(`**Водій:** ${turn.say}`, ``, `**NAVIA:** ${reply.text}`, ``, `Tools: ${tools.map((x) => `${x.tool}${x.status ? `→${x.status}` : ""}${x.isError ? " (refused)" : ""}`).join(", ") || "none"} · ${((Date.now() - t0) / 1000).toFixed(1)} s`, ``);
      for (const [name, check] of turn.checks) {
        const good = check(r); total++; if (good) pass++;
        lines.push(`- ${good ? "PASS" : "FAIL"} ${name}`);
      }
      lines.push(``);
    }
  }
  lines.splice(3, 0, `**Result: ${pass}/${total} checks pass.**`, ``);
  writeFileSync(join(here, "..", "..", "..", "docs", "AI_GPS_LOSS_LIVE.md"), lines.join("\n"));
  console.log(`${pass}/${total} checks pass → docs/AI_GPS_LOSS_LIVE.md`);
}
main().catch((e) => { console.error(e); process.exit(1); });
