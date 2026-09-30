// Network evidence: every failed request the app makes (host, path, HTTP status
// or error, how long it took) in a small ring buffer, plus a self-test that
// asks each service NAVIA depends on. Written to the app's Documents folder so
// a problem on the road ("stops working on mobile data") can be read back from
// the phone instead of guessed. No query strings, bodies or tokens are kept.
import * as FileSystem from "expo-file-system";
import { Settings } from "react-native";
import { config } from "../config";

export type NetFailure = { at: string; host: string; path: string; status: number | null; error: string | null; ms: number };
export type NetCheck = { name: string; host: string; ok: boolean; status: number | null; ms: number; error: string | null };

const MAX = 60;
const failures: NetFailure[] = [];
const FILE = `${FileSystem.documentDirectory ?? ""}net-log.json`;
let lastSelfTest: { at: string; checks: NetCheck[] } | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function split(url: string): { host: string; path: string } {
  const m = url.match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
  return m ? { host: m[1]!, path: (m[2] || "/").slice(0, 80) } : { host: "?", path: url.slice(0, 40) };
}

function persist(): void {
  if (!FileSystem.documentDirectory) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    void FileSystem.writeAsStringAsync(FILE, JSON.stringify({ savedAt: new Date().toISOString(), failures, selfTest: lastSelfTest }, null, 1)).catch(() => {});
  }, 1500);
}

function record(url: string, status: number | null, error: string | null, ms: number): void {
  const { host, path } = split(url);
  failures.push({ at: new Date().toISOString(), host, path, status, error: error ? error.slice(0, 160) : null, ms: Math.round(ms) });
  if (failures.length > MAX) failures.shift();
  persist();
}

/** Wraps global fetch once: failures (network errors and HTTP ≥ 400) go to the log. */
export function installNetLog(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const t0 = Date.now();
    try {
      const r = await real(input as RequestInfo, init);
      if (r.status >= 400) record(url, r.status, null, Date.now() - t0);
      return r;
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      record(url, null, aborted ? "timeout/aborted by the app" : String((e as Error)?.message ?? e), Date.now() - t0);
      throw e;
    }
  }) as typeof fetch;
}

export function recentNetFailures(): readonly NetFailure[] {
  return failures;
}

export function lastNetSelfTest(): { at: string; checks: NetCheck[] } | null {
  return lastSelfTest;
}

async function check(name: string, url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<NetCheck> {
  const { host } = split(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    // Read the body: a response that starts but never finishes is a failure too.
    await r.arrayBuffer().catch(() => null);
    return { name, host, ok: r.status < 400, status: r.status, ms: Date.now() - t0, error: null };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { name, host, ok: false, status: null, ms: Date.now() - t0, error: aborted ? `no answer in ${timeoutMs / 1000} s` : String((e as Error)?.message ?? e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/** Asks every service NAVIA uses, in parallel. */
export async function runNetSelfTest(): Promise<NetCheck[]> {
  const ua = { headers: { "User-Agent": "NAVIA/0.1 (navigation app; self-test)" } };
  const tile = await fetch("https://tiles.openfreemap.org/planet").then((r) => r.json() as Promise<{ tiles?: string[] }>).then((j) => j.tiles?.[0]?.replace("{z}", "14").replace("{x}", "9571").replace("{y}", "5544") ?? null).catch(() => null);
  const proxy = config.aiProxyUrl?.replace(/\/+$/, "");
  const checks = await Promise.all([
    proxy ? check("NAVIA server (co-pilot, voice)", `${proxy}/health`) : Promise.resolve({ name: "NAVIA server", host: "—", ok: false, status: null, ms: 0, error: "not configured in this build" }),
    check("Map style", config.mapStyleUrl),
    check("Map tiles (TileJSON)", "https://tiles.openfreemap.org/planet"),
    tile ? check("Map tile (Kyiv, z14)", tile) : Promise.resolve({ name: "Map tile (Kyiv, z14)", host: "tiles.openfreemap.org", ok: false, status: null, ms: 0, error: "TileJSON did not load" }),
    check("Routing (Valhalla)", `${config.valhallaUrl.replace(/\/+$/, "")}/status`),
    check("Address search (Photon)", `${config.autocompleteUrl}?q=${encodeURIComponent("Хрещатик")}&limit=1`),
    check("Geocoder (Nominatim)", `${config.geocoderUrl.replace(/\/+$/, "")}/search?q=Kyiv&format=json&limit=1`, ua),
    check("Air alerts (NEPTUN)", "https://neptun.in.ua/api/v1/alerts"),
    check("Kyiv alerts (data.kyivcity.gov.ua)", "https://data.kyivcity.gov.ua/", { method: "HEAD" }),
    check("Shelters (KMDA GIS)", "https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer?f=json"),
    check("Places (Overpass)", "https://overpass-api.de/api/status"),
  ]);
  lastSelfTest = { at: new Date().toISOString(), checks };
  persist();
  return checks;
}

/** Launch argument `-NaviaNetTest YES` (devicectl/Xcode): run the self-test at start and save it. */
export function selfTestRequestedAtLaunch(): boolean {
  try { return !!Settings.get("NaviaNetTest"); } catch { return false; }
}
