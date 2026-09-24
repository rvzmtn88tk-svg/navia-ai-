import type { AirAlertProvider, AirAlertStatus } from "@navia/core";

// The Kyiv City Open Data Portal exposes the current state published by the
// municipal "Kyiv Digital" platform. This endpoint is public and needs no
// client secret. It covers Kyiv city only, not Kyiv Oblast.
const KYIV_STATUS_URL =
  "https://data.kyivcity.gov.ua/dataset/statystyka-povitrianykh-tryvoh-u-misti-kyievi-dep-municipal/resource/e1216fe6-7cbd-41ad-b478-85983a2e2669/data/download";

type KyivStatusResponse = {
  current?: { state?: number | string; created_at?: string; causes?: unknown[] };
};

export class KyivAirAlertProvider implements AirAlertProvider {
  async fetchStatus(_region: string): Promise<AirAlertStatus> {
    let response: Response;
    try {
      response = await fetch(KYIV_STATUS_URL, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
    } catch (error) {
      throw new Error(`KyivAirAlertProvider: network request failed (${(error as Error).message})`);
    }

    if (!response.ok) {
      throw new Error(`KyivAirAlertProvider: source returned HTTP ${response.status}`);
    }

    const raw = await response.text();
    let data: KyivStatusResponse;
    try {
      data = JSON.parse(raw) as KyivStatusResponse;
    } catch {
      const state = raw.match(/<state>\s*(\d+)\s*<\/state>/i)?.[1];
      const createdAt = raw.match(/<created_at>\s*([^<]+)\s*<\/created_at>/i)?.[1]?.trim();
      if (state == null) throw new Error("KyivAirAlertProvider: response did not contain a valid alert state");
      data = { current: { state, ...(createdAt ? { created_at: createdAt } : {}) } };
    }
    const state = Number(data.current?.state);
    if (!Number.isFinite(state) || (state !== 0 && state !== 1)) {
      throw new Error("KyivAirAlertProvider: response did not contain a valid Kyiv alert state");
    }

    return {
      active: state === 1,
      region: "м. Київ",
      startedAt: data.current?.created_at ? Date.parse(data.current.created_at) : undefined,
      updatedAt: Date.now(),
      source: "Kyiv Digital / data.kyivcity.gov.ua",
    };
  }
}
