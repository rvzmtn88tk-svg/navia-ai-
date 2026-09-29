export type AirThreatSummary = {
  state: "reported" | "advisory" | "none" | "unavailable";
  region: string;
  district: string;
  count: number;
  advisoryCount: number;
  threatKinds: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  checkedAt: number;
  sourceUpdatedAt?: number;
  source: string;
  sourceUrl: string;
  detail?: string;
};

type RawThreat = {
  type?: string;
  region?: string;
  district?: string;
  updatedAt?: string;
  status?: string;
  advisory?: boolean;
  areaOnly?: boolean;
  sourceCount?: number;
  displayConfidence?: string;
  confidenceLevel?: string;
};
type ThreatResponse = { serverTime?: string; threats?: RawThreat[] };

const THREATS_URL = "https://neptun.in.ua/api/v1/threats";
const SOURCE = "NEPTUN";
const SOURCE_URL = "https://neptun.in.ua/";
const MAX_SERVER_AGE_MS = 3 * 60_000;
const MAX_REPORT_AGE_MS = 15 * 60_000;

function normalize(value: string): string {
  return value.toLocaleLowerCase("uk-UA").replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();
}

function normalizedRegion(value: string): string {
  const normalized = normalize(value);
  return ["київ", "м київ", "місто київ"].includes(normalized) ? "м київ" : normalized;
}

function sameAreaName(left: string, right: string): boolean {
  return normalize(left).replace(/ район$/, "") === normalize(right).replace(/ район$/, "");
}

function classifyKind(type: string | undefined): string {
  switch (type) {
    case "uav": return "uav";
    case "fpv": return "fpv";
    case "recon": return "recon";
    case "kab": return "kab";
    case "cruise_missile": return "cruise_missile";
    case "ballistic": case "ballistic_missile": return "ballistic_missile";
    case "missile": return "missile";
    case "aircraft": return "aircraft";
    case "mig31k": return "aircraft";
    case "unknown": return "other";
    default: return "other";
  }
}

function confidenceRank(value: string | undefined): number {
  const confidence = value?.toLowerCase();
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : confidence === "low" ? 1 : 0;
}

/**
 * Returns a region-only summary for the alert card. The approximate tracks
 * themselves are shown only on the separate "Цілі" map (AirTargetsProvider),
 * with the source, the update time and the disclaimer — never predicted.
 */
export class AirThreatSummaryProvider {
  async fetchForRegion(region: string, district = ""): Promise<AirThreatSummary> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const checkedAt = Date.now();
    try {
      const response = await fetch(THREATS_URL, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as ThreatResponse;
      const serverTime = Date.parse(data.serverTime ?? "");
      if (!Number.isFinite(serverTime) || checkedAt - serverTime > MAX_SERVER_AGE_MS || serverTime - checkedAt > 60_000 || !Array.isArray(data.threats)) {
        throw new Error("NEPTUN не надав свіжого знімка повідомлень.");
      }

      const regionKey = normalizedRegion(region);
      const recent = data.threats.filter((item) => {
        if (!item.region || normalizedRegion(item.region) !== regionKey || item.status !== "active") return false;
        if (item.district && (!district || !sameAreaName(item.district, district))) return false;
        const updatedAt = Date.parse(item.updatedAt ?? "");
        return Number.isFinite(updatedAt) && checkedAt - updatedAt >= -60_000 && checkedAt - updatedAt <= MAX_REPORT_AGE_MS;
      });
      const confidence = recent.reduce((best, item) => {
        const value = item.displayConfidence ?? item.confidenceLevel;
        return confidenceRank(value) > confidenceRank(best) ? value : best;
      }, undefined as string | undefined);
      const advisoryCount = recent.filter((item) => item.advisory === true).length;
      const confirmedReports = recent.length - advisoryCount;

      return {
        state: confirmedReports ? "reported" : advisoryCount ? "advisory" : "none",
        region,
        district,
        count: recent.length,
        advisoryCount,
        threatKinds: [...new Set(recent.map((item) => classifyKind(item.type)))],
        confidence: confidence === "high" ? "high" : confidence === "medium" ? "medium" : confidence === "low" ? "low" : "unknown",
        checkedAt,
        sourceUpdatedAt: serverTime,
        source: SOURCE,
        sourceUrl: SOURCE_URL,
        detail: "Регіональні повідомлення агрегатора, не офіційний радар і не сигнал тривоги.",
      };
    } catch (error) {
      return {
        state: "unavailable",
        region,
        district,
        count: 0,
        advisoryCount: 0,
        threatKinds: [],
        confidence: "unknown",
        checkedAt,
        source: SOURCE,
        sourceUrl: SOURCE_URL,
        detail: error instanceof Error ? error.message : "Джерело тимчасово недоступне.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
