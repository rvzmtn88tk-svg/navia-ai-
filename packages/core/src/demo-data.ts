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
