// Minimal typings for @mapbox/vector-tile 1.x and pbf 3.x (pure JS decoders).
declare module "pbf" {
  export default class Pbf {
    constructor(buffer?: ArrayBuffer | Uint8Array);
  }
}

declare module "@mapbox/vector-tile" {
  import type Pbf from "pbf";
  export type Point = { x: number; y: number };
  export class VectorTileFeature {
    type: 1 | 2 | 3;
    extent: number;
    id?: number;
    properties: Record<string, string | number | boolean>;
    loadGeometry(): Point[][];
  }
  export class VectorTileLayer {
    length: number;
    extent: number;
    feature(i: number): VectorTileFeature;
  }
  export class VectorTile {
    constructor(pbf: Pbf);
    layers: Record<string, VectorTileLayer>;
  }
}
