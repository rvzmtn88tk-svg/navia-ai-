// Live traffic flow at a point (TomTom Flow Segment Data) through the proxy:
// the key is a Worker secret (TOMTOM_API_KEY) and never reaches the app.
// Without a key the route answers 503 "traffic not configured" and the app
// says live traffic is unavailable — never a guessed jam.

export type FlowAnswer = { currentKmh: number; freeFlowKmh: number; confidence: number; closed: boolean };

export function parseFlowRequest(body: unknown): { lat: number; lon: number } | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return "lat/lon required";
  return { lat, lon };
}

export async function tomtomFlow(p: { lat: number; lon: number }, key: string, signal?: AbortSignal): Promise<FlowAnswer | { error: string; status: number }> {
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&unit=kmph&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (r.status === 403 || r.status === 401) return { error: "traffic key invalid", status: 502 };
  if (r.status === 429) return { error: "traffic busy", status: 503 };
  if (!r.ok) return { error: `traffic error ${r.status}`, status: 502 };
  const j = (await r.json()) as { flowSegmentData?: { currentSpeed?: number; freeFlowSpeed?: number; confidence?: number; roadClosure?: boolean } };
  const f = j.flowSegmentData;
  if (!f || !Number.isFinite(f.currentSpeed) || !Number.isFinite(f.freeFlowSpeed)) return { error: "no flow data here", status: 404 };
  return { currentKmh: f.currentSpeed!, freeFlowKmh: f.freeFlowSpeed!, confidence: f.confidence ?? 0, closed: !!f.roadClosure };
}
