// Live traffic flow at a point through the NAVIA proxy (TomTom; the key stays
// on the server). Unconfigured or failing → null, and the co-pilot says live
// traffic is unavailable. Also gives dead reckoning the flow speed where the
// car is, when GPS is gone.
import { PointFlowTrafficProvider, UnavailableTrafficProvider, type LatLon, type PointFlow, type TrafficProvider } from "@navia/core";
import { config } from "../config";
import { device } from "../ai/navigator/languageEngine";

let pausedUntil = 0;

export async function flowAt(p: LatLon): Promise<PointFlow | null> {
  const base = config.aiProxyUrl?.replace(/\/+$/, "");
  if (!base || !config.aiClientToken || Date.now() < pausedUntil) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${base}/v1/traffic/flow`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.aiClientToken}`, "x-navia-device": device() },
      body: JSON.stringify({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) }),
      signal: controller.signal,
    });
    if (r.status === 503 || r.status === 502) { pausedUntil = Date.now() + 10 * 60_000; return null; }
    if (!r.ok) return null;
    const j = (await r.json()) as { currentKmh: number; freeFlowKmh: number; confidence: number; closed: boolean };
    return { currentMps: j.currentKmh / 3.6, freeFlowMps: j.freeFlowKmh / 3.6, confidence: j.confidence, closed: j.closed };
  } catch { return null; } finally { clearTimeout(timer); }
}

/** The co-pilot's traffic provider: live when the server has a traffic key, else honestly unavailable. */
export function trafficProvider(): TrafficProvider {
  return config.aiProxyUrl && config.aiClientToken
    ? new PointFlowTrafficProvider(flowAt, "TomTom live traffic (via NAVIA server)")
    : new UnavailableTrafficProvider("live traffic is not connected in this build");
}
