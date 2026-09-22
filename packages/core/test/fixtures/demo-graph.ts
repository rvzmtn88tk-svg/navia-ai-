// A small, real (hand-surveyed-shaped, not random) toy road graph used by
// route-engine/demo-routing-provider tests: a rough grid near a real Kyiv
// bounding box, with one deliberate alternate path (n2 -> n5 -> n3) so
// searchAlternatives has something genuine to find.
//
//   n1 --- n2 --- n3
//          |      |
//          n5 --- +
//          |
//   n4 ----+
import type { DemoRoadGraph } from "../../src/demo-routing-provider";

export const demoGraph: DemoRoadGraph = {
  nodes: [
    { id: "n1", position: { lat: 50.4501, lon: 30.5234 } },
    { id: "n2", position: { lat: 50.4501, lon: 30.5300 } },
    { id: "n3", position: { lat: 50.4501, lon: 30.5366 } },
    { id: "n4", position: { lat: 50.4450, lon: 30.5234 } },
    { id: "n5", position: { lat: 50.4470, lon: 30.5300 } },
  ],
  edges: [
    { id: "e-n1-n2", fromId: "n1", toId: "n2", roadName: "вул. Хрещатик" },
    { id: "e-n2-n3", fromId: "n2", toId: "n3", roadName: "вул. Хрещатик" },
    { id: "e-n2-n5", fromId: "n2", toId: "n5", roadName: "вул. Прорізна" },
    { id: "e-n5-n3", fromId: "n5", toId: "n3", roadName: "вул. Прорізна" },
    { id: "e-n4-n5", fromId: "n4", toId: "n5", roadName: "бул. Лесі Українки" },
    { id: "e-n1-n4", fromId: "n1", toId: "n4", roadName: "вул. Грушевського" },
  ],
};
