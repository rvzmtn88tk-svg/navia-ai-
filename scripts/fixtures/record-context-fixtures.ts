// Records REAL context around the Bazhana test route for live dialogue checks:
// street/district at points along the route (OpenStreetMap Nominatim reverse,
// 1 request per second per its policy) and official Kyiv shelters nearby
// (KMDA GIS, the same query the app makes).
//   npx tsx scripts/fixtures/record-context-fixtures.ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseKyivFeatures, KYIV_GIS_BASE } from "../../apps/mobile/src/providers/NearbyPlacesProvider";
import type { Route } from "../../packages/core/src/route-engine";
import { haversineMeters } from "../../packages/core/src/geodesy";

const fx = JSON.parse(readFileSync("packages/core/test/fixtures/osm-kyiv-kharkivska-pozniaky.json", "utf8")) as { routes: { route: Route }[] };
const g = fx.routes[0]!.route.geometry;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Points every ~400 m along the route.
  const points = [g[0]!];
  let acc = 0;
  for (let i = 1; i < g.length; i++) { acc += haversineMeters(g[i - 1]!, g[i]!); if (acc >= 400) { points.push(g[i]!); acc = 0; } }
  const reverse = [];
  for (const p of points) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=uk&lat=${p.lat}&lon=${p.lon}`;
    const r = await fetch(url, { headers: { "User-Agent": "NAVIA/0.1 (fixture recording)" } });
    const a = ((await r.json()) as { address?: Record<string, string> }).address ?? {};
    const road = a.road ?? a.pedestrian ?? a.footway ?? null;
    reverse.push({ at: p, street: road ? `${road}${a.house_number ? `, ${a.house_number}` : ""}` : null, area: a.suburb ?? a.city_district ?? a.city ?? null });
    await sleep(1100);
  }
  const center = { lat: 50.4003, lon: 30.6432 };
  const u = new URL(`${KYIV_GIS_BASE}/0/query`);
  for (const [k, v] of Object.entries({ where: "1=1", outFields: "*", returnGeometry: "true", f: "json", outSR: "4326", geometry: `${center.lon},${center.lat}`, geometryType: "esriGeometryPoint", inSR: "4326", distance: "2500", units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects" })) u.searchParams.set(k, v);
  const data = await (await fetch(u.toString(), { headers: { Accept: "application/json" } })).json() as { features?: unknown[] };
  const shelters = parseKyivFeatures(data.features as never, "shelter", center).map((s) => ({ id: s.id, name: s.name, address: s.address ?? null, location: s.location, kind: "shelter", source: s.source }));
  writeFileSync("packages/core/test/fixtures/kyiv-bazhana-context.json", JSON.stringify({
    source: { reverse: "OpenStreetMap Nominatim reverse (accept-language=uk)", shelters: `${KYIV_GIS_BASE}/0 (KMDA open data)`, recordedAt: new Date().toISOString(), license: "OSM data © OpenStreetMap contributors, ODbL; shelters: Kyiv City open data" },
    reverse, shelters,
  }));
  console.log(`reverse ${reverse.length} points (${reverse.filter((r) => r.street).length} with a street), shelters ${shelters.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
