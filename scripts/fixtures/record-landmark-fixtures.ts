// Records REAL map data for the landmark-localization tests: map features and
// road junctions from the OpenFreeMap vector tiles (OpenStreetMap data, the
// same tiles the app reads) and real routes from Valhalla. Output files carry
// the source, tile version, date and the ODbL notice.
//   npx tsx scripts/fixtures/record-landmark-fixtures.ts
import { writeFileSync } from "node:fs";
import { tileLocalizationData, tileTemplate } from "../../apps/mobile/src/providers/vectorTiles";
import { OnlineValhallaProvider } from "../../apps/mobile/src/providers/OnlineValhallaProvider";
import type { LatLon } from "../../packages/core/src/types";

const VALHALLA = "https://valhalla1.openstreetmap.de";

const AREAS: { name: string; note: string; center: LatLon; radiusM: number; routes: { name: string; from: LatLon; to: LatLon }[] }[] = [
  {
    name: "kyiv-kharkivska-pozniaky",
    note: "Metro Pozniaky and Kharkivska (~1.4 km apart on Mykoly Bazhana Ave), each with a Dnipro-M store next to an entrance.",
    center: { lat: 50.4003, lon: 30.6432 },
    radiusM: 1700,
    routes: [{ name: "bazhana-west-east", from: { lat: 50.3975, lon: 30.6180 }, to: { lat: 50.4045, lon: 30.6680 } }],
  },
  {
    name: "kyiv-two-fora",
    note: "Two Fora supermarkets about 150-250 m apart (Sviatoshyn area).",
    center: { lat: 50.4681, lon: 30.4147 },
    radiusM: 900,
    routes: [{ name: "past-the-fora-stores", from: { lat: 50.4718, lon: 30.4138 }, to: { lat: 50.4648, lon: 30.4162 } }],
  },
];

async function main() {
  const template = await tileTemplate();
  const router = new OnlineValhallaProvider(VALHALLA);
  for (const area of AREAS) {
    const { features, junctions } = await tileLocalizationData(area.center, area.radiusM);
    const routes = [];
    for (const r of area.routes) routes.push({ name: r.name, route: await router.route({ origin: r.from, destination: r.to, mode: "car" }) });
    const out = {
      source: {
        features: `OpenFreeMap vector tiles z14 (${template.replace("{z}/{x}/{y}.pbf", "")}), layers poi + transportation`,
        routes: `Valhalla ${VALHALLA} (costing auto)`,
        recordedAt: new Date().toISOString(),
        license: "Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
        recordedBy: "scripts/fixtures/record-landmark-fixtures.ts",
      },
      area: { name: area.name, note: area.note, center: area.center, radiusM: area.radiusM },
      features: features.map((f) => ({ ...f, location: { lat: +f.location.lat.toFixed(6), lon: +f.location.lon.toFixed(6) } })),
      junctions: junctions.map((j) => ({ lat: +j.lat.toFixed(6), lon: +j.lon.toFixed(6) })),
      routes,
    };
    const file = `packages/core/test/fixtures/osm-${area.name}.json`;
    writeFileSync(file, JSON.stringify(out));
    console.log(`${file}: ${features.length} features, ${junctions.length} junctions, routes ${routes.map((r) => `${r.name} ${Math.round(r.route.distanceM)} m`).join(", ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
