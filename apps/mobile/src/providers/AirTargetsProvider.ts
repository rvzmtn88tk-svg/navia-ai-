// Air targets (drones, missiles) from NEPTUN's open API — community
// monitoring aggregated from public channels, NOT an official military or
// radar source. Positions are approximate (the source gives an uncertainty
// in km and a position quality), headings are presumed courses. The screen
// must say so, with the source name, a visible link (the API's only
// condition of use) and the update time.
//   GET https://neptun.in.ua/api/v1/threats — no key; CDN-cached ~5 s;
//   the source asks for at most one request per 5 s.
// Parsing and the track history are pure (unit-tested on a real response).

import { formatClock } from "../i18n/format";
import type { StringKey } from "../i18n/strings";

export const TARGETS_URL = "https://neptun.in.ua/api/v1/threats";
export const TARGETS_SOURCE = "NEPTUN";
export const TARGETS_SOURCE_URL = "https://neptun.in.ua/";

export type AirTargetKind = "uav" | "recon" | "missile" | "ballistic" | "kab" | "aircraft" | "unknown";

export type AirTarget = {
  id: string;
  kind: AirTargetKind;
  lat: number;
  lon: number;
  /** Presumed course, degrees from north (null = unknown). */
  headingDeg: number | null;
  speedKmh: number | null;
  /** How far off the position may be. */
  uncertaintyKm: number | null;
  /** "confirmed" = reported at a place; "approx" = estimated; "area" = only the region is known. */
  quality: "confirmed" | "approx" | "area";
  confidence: "low" | "medium" | "high" | "unknown";
  /** How many reports confirm it. */
  reports: number;
  /** Group size, when the source knows it. */
  count: number | null;
  region: string;
  locality: string;
  /** The source's own one-line explanation. */
  note: string;
  updatedAt: number;
  /** The source still lists it but has not updated it for a while. */
  stale: boolean;
};

export type AirTargetsSnapshot = { serverTime: number; targets: AirTarget[] };

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function kindOf(type: string): AirTargetKind {
  switch (type) {
    case "uav": case "shahed": return "uav";
    case "recon": return "recon";
    case "missile": case "cruise_missile": return "missile";
    case "ballistic": case "ballistic_missile": return "ballistic";
    case "kab": return "kab";
    case "mig31k": case "aircraft": return "aircraft";
    default: return "unknown";
  }
}

/** A track not updated for this long is shown as stale; after DROP_AFTER it is not shown. */
export const STALE_AFTER_MS = 10 * 60_000;
export const DROP_AFTER_MS = 30 * 60_000;
/** A snapshot older than this is not "current" (the source stopped updating). */
export const MAX_SERVER_AGE_MS = 3 * 60_000;

/** Validates and converts the source's response; throws on anything that is not a usable snapshot. */
export function parseTargets(json: unknown, now: number): AirTargetsSnapshot {
  if (!json || typeof json !== "object") throw new Error("відповідь джерела не є JSON-об'єктом");
  const data = json as { serverTime?: unknown; threats?: unknown };
  const serverTime = Date.parse(str(data.serverTime));
  if (!Number.isFinite(serverTime)) throw new Error("у відповіді немає часу сервера");
  if (!Array.isArray(data.threats)) throw new Error("у відповіді немає списку цілей");
  if (now - serverTime > MAX_SERVER_AGE_MS) throw new Error(`знімок джерела застарів (${Math.round((now - serverTime) / 60_000)} хв)`);
  const targets: AirTarget[] = [];
  for (const item of data.threats as Raw[]) {
    if (!item || typeof item !== "object") continue;
    const lat = num(item.lat), lon = num(item.lon);
    const id = str(item.id);
    const status = str(item.status);
    if (!id || lat == null || lon == null || status === "resolved") continue;
    // Ukraine and its approaches only (a bad coordinate must not land elsewhere).
    if (lat < 43 || lat > 53.5 || lon < 21 || lon > 41.5) continue;
    const updatedAt = Date.parse(str(item.updatedAt));
    if (!Number.isFinite(updatedAt) || serverTime - updatedAt > DROP_AFTER_MS) continue;
    const velocity = (item.velocity && typeof item.velocity === "object" ? item.velocity : {}) as Raw;
    const heading = num(item.heading) ?? num(velocity.bearingDeg);
    const conf = str(item.displayConfidence) || str(item.confidenceLevel);
    targets.push({
      id,
      kind: kindOf(str(item.type)),
      lat, lon,
      headingDeg: heading == null ? null : ((heading % 360) + 360) % 360,
      speedKmh: num(velocity.speedKmh),
      uncertaintyKm: num(item.uncertaintyKm),
      quality: item.areaOnly === true ? "area" : str(item.positionQuality) === "confirmed" ? "confirmed" : "approx",
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "unknown",
      reports: num(item.sourceCount) ?? 1,
      count: num(item.count),
      region: str(item.region),
      locality: str(item.locality),
      note: str(item.explanationShort),
      updatedAt,
      stale: status === "stale" || serverTime - updatedAt > STALE_AFTER_MS,
    });
  }
  return { serverTime, targets };
}

export type TrackPoint = { lat: number; lon: number; at: number };
export type Tracks = Record<string, TrackPoint[]>;

/**
 * The path each target was actually reported along: a new point only when
 * the source moved it (not interpolated, not predicted). Tracks of targets
 * the source no longer lists are dropped.
 */
export function mergeTracks(prev: Tracks, targets: AirTarget[], maxPoints = 12): Tracks {
  const next: Tracks = {};
  for (const t of targets) {
    const old = prev[t.id] ?? [];
    const last = old[old.length - 1];
    const moved = !last || Math.abs(last.lat - t.lat) > 1e-4 || Math.abs(last.lon - t.lon) > 1e-4;
    next[t.id] = moved ? [...old, { lat: t.lat, lon: t.lon, at: t.updatedAt }].slice(-maxPoints) : old;
  }
  return next;
}

/** Development builds only: EXPO_PUBLIC_NAVIA_TARGETS_URL points elsewhere (to test "source down"). */
function sourceUrl(): string {
  const dev = typeof __DEV__ !== "undefined" && __DEV__;
  return (dev && process.env.EXPO_PUBLIC_NAVIA_TARGETS_URL) || TARGETS_URL;
}

export async function fetchTargets(now = Date.now, timeoutMs = 10_000): Promise<AirTargetsSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(sourceUrl(), { headers: { Accept: "application/json" }, signal: controller.signal });
    } catch (e) {
      throw new Error((e as Error).name === "AbortError" ? "джерело не відповіло за 10 с" : "немає зв'язку з джерелом");
    }
    if (!response.ok) throw new Error(`джерело повернуло помилку ${response.status}`);
    let json: unknown;
    try { json = await response.json(); } catch { throw new Error("відповідь джерела не читається"); }
    return parseTargets(json, now());
  } finally {
    clearTimeout(timer);
  }
}

export type TargetsView = {
  status: "idle" | "loading" | "ready" | "error";
  targets: AirTarget[];
  serverTime: number | null;
  error: string | null;
};

/** The one-line status for the sheet row and the overlay (exported for tests). */
export function targetsLine(v: TargetsView, t: (key: StringKey, params?: Record<string, string | number>) => string, lang: "uk" | "en"): { text: string; tone: "normal" | "warning" } {
  if (!v.serverTime) {
    if (v.status === "error") return { text: t("targets.unavailableWhy", { why: v.error ?? "—" }), tone: "warning" };
    return { text: t("targets.loading"), tone: "normal" };
  }
  const time = formatClock(v.serverTime, lang);
  if (v.status === "error") return { text: t("targets.outdated", { time, why: v.error ?? "—" }), tone: "warning" };
  const n = v.targets.length;
  // Ukrainian plural: 1, 21 ціль; 2–4, 22–24 цілі; the rest цілей.
  const noun = n % 10 === 1 && n % 100 !== 11 ? "targets.noun.one" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "targets.noun.few" : "targets.noun.many";
  return { text: n ? t("targets.count", { count: n, noun: t(noun), time }) : t("targets.none", { time }), tone: "normal" };
}

