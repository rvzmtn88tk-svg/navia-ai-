// RecoveryEngine — the sequential-good-samples half of spec section 21's
// GNSS_LOST -> POSITION_UNCERTAIN -> GNSS_RECOVERED -> ACTIVE chain.
// Factored out of NavigationStateMachine so "how many good samples in a row
// count as recovered" is its own testable rule (hysteresis: one clean GNSS
// fix after a long outage should NOT immediately snap back to ACTIVE).

export type RecoveryConfig = {
  /** Consecutive NORMAL-integrity samples required before recovery is validated. */
  confirmSamples: number;
};

const DEFAULT_CONFIG: RecoveryConfig = { confirmSamples: 3 };

export class RecoveryEngine {
  private config: RecoveryConfig;
  private streak = 0;

  constructor(config: Partial<RecoveryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Feed one sample's GNSS-is-good/bad verdict; returns true once validated. */
  update(isGoodSample: boolean): boolean {
    this.streak = isGoodSample ? this.streak + 1 : 0;
    return this.streak >= this.config.confirmSamples;
  }

  reset(): void {
    this.streak = 0;
  }

  currentStreak(): number {
    return this.streak;
  }
}
