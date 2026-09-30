// Shipped Demo Mode fixture data — the real Kyiv-center -> Boryspil demo
// graph and a couple of demo POIs, so apps/mobile's Demo Mode (spec section
// 26) doesn't need to duplicate this data; it imports it from @navia/core
// the same way packages/core's own E2E test does (see
// packages/core/test/fixtures/kyiv-oblast-graph.ts, which this mirrors —
// kept in sync manually since test fixtures aren't part of the published
// package output).
import type { DemoRoadGraph } from "./demo-routing-provider";
import type { POI } from "./landmark-engine";
import type { LatLon } from "./types";
import { RouteGeometryIndex } from "./route-geometry";
import { destinationPoint } from "./geodesy";

export const DEMO_ORIGIN: LatLon = { lat: 50.4501, lon: 30.5234 }; // Maidan Nezalezhnosti, Kyiv
export const DEMO_DESTINATION: LatLon = { lat: 50.3450, lon: 30.9526 }; // Boryspil, Kyiv Oblast

export const DEMO_KYIV_TO_BORYSPIL_GRAPH: DemoRoadGraph = {
  nodes: [
    { id: "maidan", position: DEMO_ORIGIN },
    { id: "livoberezhna", position: { lat: 50.4519, lon: 30.5860 } },
    { id: "boryspil_hwy_1", position: { lat: 50.4200, lon: 30.6800 } },
    { id: "boryspil_hwy_2", position: { lat: 50.3600, lon: 30.8200 } },
    { id: "boryspil", position: DEMO_DESTINATION },
  ],
  edges: [
    { id: "e-maidan-livoberezhna", fromId: "maidan", toId: "livoberezhna", roadName: "вул. Хрещатик / просп. Броварський" },
    { id: "e-livoberezhna-hwy1", fromId: "livoberezhna", toId: "boryspil_hwy_1", roadName: "Бориспільське шосе" },
    { id: "e-hwy1-hwy2", fromId: "boryspil_hwy_1", toId: "boryspil_hwy_2", roadName: "Бориспільське шосе" },
    { id: "e-hwy2-boryspil", fromId: "boryspil_hwy_2", toId: "boryspil", roadName: "Бориспільське шосе" },
  ],
};

export const DEMO_POIS: POI[] = [
  { id: "wog-1", name: "WOG", brand: "WOG", category: "fuel", location: { lat: 50.4503, lon: 30.5297 } },
  { id: "silpo-1", name: "Сільпо", brand: "Сільпо", category: "supermarket", location: { lat: 50.4380, lon: 30.6500 } },
];

// --- Demo trip-service POIs for the AI co-pilot (Demo Mode + tests) ---
//
// SYNTHETIC DEMO FIXTURE, not a POI database: these records exist so Demo
// Mode can exercise the co-pilot's along-route search, detour limits,
// opening hours and destination parking end to end. Each is positioned
// deterministically relative to the demo road polyline (distance along it +
// perpendicular offset), and every record is tagged `source: "demo"` so the
// co-pilot reports them as demo data. Real trips use OSM (Overpass) or the
// offline POI index instead.

const DEMO_POLYLINE = ["maidan", "livoberezhna", "boryspil_hwy_1", "boryspil_hwy_2", "boryspil"].map(
  (id) => DEMO_KYIV_TO_BORYSPIL_GRAPH.nodes.find((n) => n.id === id)!.position,
);

/** A point `offsetM` to the right (+) or left (−) of the demo road, `alongM` from Maidan. */
export function demoPointAlongRoad(alongM: number, offsetM: number): LatLon {
  const index = new RouteGeometryIndex(DEMO_POLYLINE);
  const onRoad = index.pointAt(alongM);
  if (offsetM === 0) return onRoad;
  const bearing = index.bearingAt(alongM);
  return destinationPoint(onRoad, (bearing + (offsetM > 0 ? 90 : -90) + 360) % 360, Math.abs(offsetM));
}

const demoPoi = (id: string, name: string, category: POI["category"], alongM: number, offsetM: number, extra: Partial<POI> = {}): POI => ({
  id, name, category, location: demoPointAlongRoad(alongM, offsetM), source: "demo", ...extra,
});

export const DEMO_ROUTE_POIS: POI[] = [
  demoPoi("demo-sm-fora", "Фора", "supermarket", 4_280, 45, { brand: "Фора", openingHours: "Mo-Su 08:00-22:00" }),
  demoPoi("demo-cafe-aroma", "Aroma Kava", "cafe", 6_000, 80, { brand: "Aroma Kava", openingHours: "Mo-Su 07:00-22:00" }),
  demoPoi("demo-rest-puzata", "Пузата Хата", "restaurant", 5_200, 220, { openingHours: "Mo-Su 09:00-22:00", cuisine: "ukrainian" }),
  demoPoi("demo-fuel-okko-1", "ОККО", "fuel", 9_000, 120, { brand: "OKKO", openingHours: "24/7" }),
  demoPoi("demo-ff-mcd-1", "McDonald's", "fast_food", 14_000, -700, { brand: "McDonald's", openingHours: "Mo-Su 07:00-23:00", cuisine: "burger" }),
  demoPoi("demo-fuel-wog-2", "WOG", "fuel", 18_000, 40, { brand: "WOG", openingHours: "24/7" }),
  demoPoi("demo-rest-kozak", "Ресторан Козак", "restaurant", 20_000, 300, { openingHours: "Mo-Su 10:00-23:00", cuisine: "ukrainian" }),
  demoPoi("demo-rest-night", "Нічний Гриль", "restaurant", 19_500, 150, { openingHours: "Mo-Su 20:00-04:00" }),
  demoPoi("demo-ff-mcd-2", "McDonald's", "fast_food", 22_000, 2_600, { brand: "McDonald's", openingHours: "24/7", cuisine: "burger" }),
  demoPoi("demo-cafe-kava", "Кава Кофі", "cafe", 25_000, -300, { openingHours: "Mo-Fr 08:00-18:00" }),
  demoPoi("demo-fuel-socar", "SOCAR", "fuel", 27_000, -900, { brand: "SOCAR", openingHours: "24/7" }),
  { id: "demo-park-center", name: "Паркінг Бориспіль-центр", category: "parking", location: destinationPoint(DEMO_DESTINATION, 40, 250), source: "demo" },
  { id: "demo-park-mall", name: "Паркінг ТРЦ", category: "parking", location: destinationPoint(DEMO_DESTINATION, 200, 600), source: "demo" },
  { id: "demo-park-far", name: "Паркінг Вокзал", category: "parking", location: destinationPoint(DEMO_DESTINATION, 300, 2100), source: "demo" },
];
