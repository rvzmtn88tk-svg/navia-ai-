// Internet reachability — kept separate from GPS on purpose: losing mobile
// data doesn't affect positioning, and GPS loss doesn't mean no internet.
//
// Rather than asking the OS "is there a network" (which says yes on a
// captive portal or a dead cell link), it checks what NAVIA actually needs:
// can it reach its own services (the AI backend health endpoint, else the
// routing server). A probe every 15 s, and immediately on request after a
// failed route/search call.
import { config } from "../config";

export type ConnectivityListener = (online: boolean) => void;

const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;

function probeUrl(): string | null {
  if (config.aiBackendUrl) return `${config.aiBackendUrl.replace(/\/+$/, "")}/healthz`;
  if (config.valhallaUrl) return `${config.valhallaUrl.replace(/\/+$/, "")}/status`;
  return null;
}

export class ConnectivityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private online: boolean | null = null;

  constructor(private onChange: ConnectivityListener) {}

  start(): void {
    if (this.timer) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isOnline(): boolean | null { return this.online; }

  /** Probe now (e.g. right after a network call failed). */
  async probe(): Promise<boolean | null> {
    const url = probeUrl();
    if (!url) return null; // nothing configured to check against: leave the state unknown
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let ok: boolean;
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal });
      ok = res.status < 500;
    } catch {
      ok = false;
    } finally {
      clearTimeout(t);
    }
    if (ok !== this.online) {
      this.online = ok;
      this.onChange(ok);
    }
    return ok;
  }
}
