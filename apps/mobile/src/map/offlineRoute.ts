// Saves the map along a route for offline use when the trip starts, so the
// map stays visible if the network drops (jamming, no coverage). Split into
// corridor chunks so a long trip never becomes one huge rectangle.
import MapLibreGL from "@maplibre/maplibre-react-native";
import type { LatLon } from "@navia/core";

const PREFIX = "navia-route-";
const CHUNK_M = 6000;
const PAD_DEG_LAT = 0.007; // ~780 m either side of the route

function metres(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/** Splits the route into corridor boxes [[neLon, neLat], [swLon, swLat]]. */
export function corridorBoxes(geometry: LatLon[]): [[number, number], [number, number]][] {
  const boxes: [[number, number], [number, number]][] = [];
  let chunk: LatLon[] = [];
  let length = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const lats = chunk.map((p) => p.lat);
    const lons = chunk.map((p) => p.lon);
    const padLon = PAD_DEG_LAT / Math.cos((lats[0]! * Math.PI) / 180);
    boxes.push([[Math.max(...lons) + padLon, Math.max(...lats) + PAD_DEG_LAT], [Math.min(...lons) - padLon, Math.min(...lats) - PAD_DEG_LAT]]);
  };
  geometry.forEach((p, i) => {
    chunk.push(p);
    if (i > 0) length += metres(geometry[i - 1]!, p);
    if (length >= CHUNK_M) { flush(); chunk = [p]; length = 0; }
  });
  flush();
  return boxes;
}

export type OfflineProgress = { state: "idle" | "saving" | "saved" | "failed"; percent: number };

/** Replaces any previously saved route corridor with this route's. */
export async function saveRouteOffline(geometry: LatLon[], styleURL: string, onProgress: (p: OfflineProgress) => void): Promise<void> {
  const manager = MapLibreGL.OfflineManager;
  try {
    for (const pack of await manager.getPacks()) {
      if (pack.name?.startsWith(PREFIX)) await manager.deletePack(pack.name);
    }
    manager.setTileCountLimit(30_000);
    const boxes = corridorBoxes(geometry);
    const done = new Array(boxes.length).fill(0);
    onProgress({ state: "saving", percent: 0 });
    await Promise.all(boxes.map((bounds, i) => new Promise<void>((resolve) => {
      void manager.createPack(
        { name: `${PREFIX}${Date.now()}-${i}`, styleURL, bounds, minZoom: 11, maxZoom: 16 },
        (_pack, status) => {
          done[i] = status.percentage ?? 0;
          onProgress({ state: "saving", percent: Math.round(done.reduce((a, b) => a + b, 0) / boxes.length) });
          if ((status.percentage ?? 0) >= 100) resolve();
        },
        () => resolve(),
      ).catch(() => resolve());
    })));
    onProgress({ state: "saved", percent: 100 });
  } catch {
    onProgress({ state: "failed", percent: 0 });
  }
}
