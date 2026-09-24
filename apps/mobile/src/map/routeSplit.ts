// Splits a route polyline at the distance already travelled, so the map can
// dim the part behind the user. Pure; unit-tested.
export type Pt = { lat: number; lon: number };

function metres(a: Pt, b: Pt): number {
  const R = 6_371_000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function splitRoute(geometry: Pt[], progressM: number): { traveled: Pt[]; remaining: Pt[] } {
  if (geometry.length < 2 || progressM <= 0) return { traveled: [], remaining: geometry };
  let walked = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1]!;
    const b = geometry[i]!;
    const seg = metres(a, b);
    if (walked + seg >= progressM) {
      const k = seg === 0 ? 0 : (progressM - walked) / seg;
      const cut = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
      return { traveled: [...geometry.slice(0, i), cut], remaining: [cut, ...geometry.slice(i)] };
    }
    walked += seg;
  }
  return { traveled: geometry, remaining: [] };
}
