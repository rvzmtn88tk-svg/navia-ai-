// Real Kyiv-center -> Kyiv-Oblast coordinates (spec section 27: "Kyiv center
// -> Kyiv Oblast destination... Do not invent a route geometry just for
// UI"). Node positions are real places (approximate but genuine lat/lon for
// Maidan Nezalezhnosti through to Boryspil, along the actual Kyiv->Boryspil
// highway corridor); the road graph connecting them is a simplified
// (small, hand-authored) representation of that corridor, not a literal OSM
// extract — this sandbox cannot download OSM data (see LIMITATIONS.md), so
// this is the honest middle ground: real endpoints, a real routing engine
// run over them, not a straight line drawn for the UI.
import type { DemoRoadGraph } from "../../src/demo-routing-provider";

export const kyivToBoryspilGraph: DemoRoadGraph = {
  nodes: [
    { id: "maidan", position: { lat: 50.4501, lon: 30.5234 } }, // Maidan Nezalezhnosti, Kyiv center
    { id: "livoberezhna", position: { lat: 50.4519, lon: 30.5860 } }, // Left-bank Kyiv, Brovarskyi Ave.
    { id: "boryspil_hwy_1", position: { lat: 50.4200, lon: 30.6800 } }, // Boryspil highway waypoint
    { id: "boryspil_hwy_2", position: { lat: 50.3600, lon: 30.8200 } }, // Boryspil highway waypoint
    { id: "boryspil", position: { lat: 50.3450, lon: 30.9526 } }, // Boryspil, Kyiv Oblast
  ],
  edges: [
    { id: "e-maidan-livoberezhna", fromId: "maidan", toId: "livoberezhna", roadName: "вул. Хрещатик / просп. Броварський" },
    { id: "e-livoberezhna-hwy1", fromId: "livoberezhna", toId: "boryspil_hwy_1", roadName: "Бориспільське шосе" },
    { id: "e-hwy1-hwy2", fromId: "boryspil_hwy_1", toId: "boryspil_hwy_2", roadName: "Бориспільське шосе" },
    { id: "e-hwy2-boryspil", fromId: "boryspil_hwy_2", toId: "boryspil", roadName: "Бориспільське шосе" },
  ],
};
