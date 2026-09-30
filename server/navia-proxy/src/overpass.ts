// OpenStreetMap place data (Overpass) through the proxy. Some networks the
// app runs on cannot reach any public Overpass server at all (the owner's
// home network refuses every mirror), so the app asks here and Cloudflare
// tries the mirrors. The query is passed through unchanged.

export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export const OVERPASS_MAX_QUERY = 8_000;

/** The Overpass QL query from a form body (`data=…`) or a raw body. */
export function overpassQuery(body: string): string | null {
  const q = body.startsWith("data=") ? new URLSearchParams(body).get("data") ?? "" : body;
  const t = q.trim();
  if (!t || t.length > OVERPASS_MAX_QUERY) return null;
  // Read-only JSON queries only.
  if (!/\[out:json\]/.test(t)) return null;
  return t;
}

export async function askOverpass(query: string, signal?: AbortSignal, perMirrorMs = 12_000): Promise<Response> {
  const tried: string[] = [];
  for (const url of OVERPASS_MIRRORS) {
    const host = new URL(url).host;
    const timeout = AbortSignal.timeout(perMirrorMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json", "user-agent": "NAVIA/0.1 (navigation app; via navia-proxy)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (r.ok) {
        const text = await r.text();
        if (text.trimStart().startsWith("{")) return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "x-overpass-mirror": host } });
        tried.push(`${host}: not JSON`);
      } else {
        tried.push(`${host}: HTTP ${r.status}`);
      }
    } catch (e) {
      tried.push(`${host}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`);
    }
  }
  return new Response(JSON.stringify({ error: "overpass unavailable", tried }), { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
}
