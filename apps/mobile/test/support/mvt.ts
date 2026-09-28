// Minimal Mapbox Vector Tile encoder for tests: points and lines with string
// properties, in tile coordinates (extent 4096). Enough to feed the real
// decoders (@mapbox/vector-tile) with known content.
import Pbf from "pbf";

export type TestFeature = { type: "point" | "line"; props: Record<string, string>; coords: [number, number][] };
export type TestLayer = { name: string; features: TestFeature[] };

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function geometry(f: TestFeature): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  const move = (cx: number, cy: number) => { out.push(zigzag(cx - x), zigzag(cy - y)); x = cx; y = cy; };
  const [first, ...rest] = f.coords;
  out.push((1 & 0x7) | (1 << 3));
  move(first![0], first![1]);
  if (f.type === "line") {
    out.push((2 & 0x7) | (rest.length << 3));
    for (const [cx, cy] of rest) move(cx, cy);
  }
  return out;
}

export function encodeTile(layers: TestLayer[]): ArrayBuffer {
  const pbf = new Pbf();
  for (const layer of layers) {
    pbf.writeMessage(3, (_: unknown, p: Pbf) => {
      const keys: string[] = [], values: string[] = [];
      const index = (list: string[], v: string) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
      const encoded = layer.features.map((f, id) => ({ f, id, tags: Object.entries(f.props).flatMap(([k, v]) => [index(keys, k), index(values, v)]) }));
      p.writeVarintField(15, 2);
      p.writeStringField(1, layer.name);
      for (const e of encoded) {
        p.writeMessage(2, (_f: unknown, fp: Pbf) => {
          fp.writeVarintField(1, e.id + 1);
          fp.writePackedVarint(2, e.tags);
          fp.writeVarintField(3, e.f.type === "point" ? 1 : 2);
          fp.writePackedVarint(4, geometry(e.f));
        }, null);
      }
      for (const k of keys) p.writeStringField(3, k);
      for (const v of values) p.writeMessage(4, (_v: unknown, vp: Pbf) => vp.writeStringField(1, v), null);
      p.writeVarintField(5, 4096);
    }, null);
  }
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
