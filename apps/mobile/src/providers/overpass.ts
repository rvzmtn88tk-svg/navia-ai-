// Overpass (OpenStreetMap) client with mirror fallback. The main public
// server regularly answers 504 "too busy"; one mirror being down must never
// leave the user with an empty map. The mirror that answered last is tried
// first next time.

export const OVERPASS_ENDPOINTS = [
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

let preferred = 0;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function overpass(query: string, options: { perEndpointTimeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<OverpassElement[]> {
  const timeoutMs = options.perEndpointTimeoutMs ?? 9_000;
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const order = OVERPASS_ENDPOINTS.map((_, i) => (preferred + i) % OVERPASS_ENDPOINTS.length);
  // Two mirrors at a time, first good answer wins; then the next two.
  let lastError: unknown = null;
  for (let i = 0; i < order.length; i += 2) {
    const batch = order.slice(i, i + 2);
    const controllers = batch.map(() => new AbortController());
    try {
      const { elements, index } = await firstSuccess(batch.map((endpoint, k) => ask(endpoint, controllers[k]!)));
      preferred = index;
      return elements;
    } catch (error) {
      lastError = error;
    } finally {
      controllers.forEach((c) => c.abort());
    }
  }
  throw lastError ?? new Error("Overpass: all mirrors failed");

  async function ask(index: number, controller: AbortController): Promise<{ elements: OverpassElement[]; index: number }> {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(OVERPASS_ENDPOINTS[index]!, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json", "User-Agent": "NAVIA/0.1 (navigation app)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const data = await response.json() as { elements?: OverpassElement[]; remark?: string };
      // A runtime error inside Overpass comes back as 200 with a remark and no data.
      if (!data.elements || (data.elements.length === 0 && data.remark && /error|timed out/i.test(data.remark))) throw new Error(`Overpass: ${data.remark ?? "no elements"}`);
      return { elements: data.elements, index };
    } finally {
      clearTimeout(timer);
    }
  }
}

function firstSuccess<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let failed = 0;
    let lastError: unknown = null;
    for (const p of promises) {
      p.then(resolve, (error) => { lastError = error; failed += 1; if (failed === promises.length) reject(lastError); });
    }
  });
}

/** For tests. */
export function resetOverpassPreference(): void {
  preferred = 0;
}
