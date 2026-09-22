// AirAlertLayer — spec section 19 ("AIR-RAID INFORMATION LAYER").
//
// "This is INFORMATIONAL ONLY. Do not calculate 'safe routes'. Do not advise
// tactical movement. Do not infer threat direction... No claim: 'Цей
// маршрут безпечний'." AirAlertLayer only stores and exposes the status; it
// has no route-scoring method and no tactical-advice method, by design —
// there is nothing here for a caller to misuse into a safety claim.

export type AirAlertStatus = {
  active: boolean;
  region?: string;
  startedAt?: number;
  updatedAt?: number;
  source?: string;
};

export interface AirAlertProvider {
  fetchStatus(region: string): Promise<AirAlertStatus>;
}

const UNKNOWN_STATUS: AirAlertStatus = { active: false, source: "unavailable" };

export class AirAlertLayer {
  private status: AirAlertStatus = UNKNOWN_STATUS;

  constructor(private provider: AirAlertProvider | null = null) {}

  getStatus(): AirAlertStatus {
    return this.status;
  }

  async refresh(region: string): Promise<AirAlertStatus> {
    if (!this.provider) {
      // No live source wired up — say so honestly rather than defaulting to "no alert".
      this.status = { active: false, region, source: "unavailable", updatedAt: Date.now() };
      return this.status;
    }
    this.status = await this.provider.fetchStatus(region);
    return this.status;
  }

  /** The one sentence this layer is allowed to say about routing — spec's explicit non-claim. */
  static readonly SAFETY_DISCLAIMER =
    "Це лише інформаційний статус повітряної тривоги. NAVIA не оцінює безпечність маршруту " +
    "і не радить тактичні дії — рішення про укриття чи маршрут приймає користувач самостійно.";
}

/**
 * Demo-only provider: a manually toggled status, used by DemoEngine. A real
 * provider (e.g. alerts.in.ua's API) needs outbound network this sandbox's
 * package-registry-only egress does not allow — see LIMITATIONS.md. Every
 * status this returns is tagged `source: "demo"` so nothing downstream can
 * mistake it for a live feed (spec section 40).
 */
export class DemoAirAlertProvider implements AirAlertProvider {
  constructor(private active = false) {}

  setActive(active: boolean): void {
    this.active = active;
  }

  async fetchStatus(region: string): Promise<AirAlertStatus> {
    const now = Date.now();
    return {
      active: this.active,
      region,
      startedAt: this.active ? now : undefined,
      updatedAt: now,
      source: "demo",
    };
  }
}
