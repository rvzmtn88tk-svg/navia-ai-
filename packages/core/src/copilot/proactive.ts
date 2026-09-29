// ProactiveEngine — NAVIA speaking up on its own, rarely and usefully.
//
// It only NOTICES (deterministic triggers over real data); what to say, and
// whether to say anything at all, is the co-pilot's decision
// (NaviaCopilot.handleEvent → the LLM, or the local fallback). Triggers:
//   - a reminder the driver asked for is due (time or distance);
//   - live traffic ahead adds a lot of delay (only when a traffic provider is
//     connected — never guessed).
// GPS lost / spoofed / restored is announced by VoiceGuidance, not here.
//
// Anti-spam, because a distracted driver is worse than a silent co-pilot:
//   - at most one proactive message per `minIntervalMs`, and `maxPerWindow`
//     per `windowMs`;
//   - never within `quietBeforeManeuverS` of a maneuver, never while a
//     proposal is waiting for an answer or the co-pilot is busy;
//   - the driver's preference proactive_suggestions = off / important_only
//     (reminders they asked for are always delivered);
//   - each trigger fires once (a traffic alert once per route and 5-minute delay step).

import type { CopilotReply, CopilotEvent, NaviaCopilot } from "./copilot";
import type { CopilotRuntime, Reminder } from "./runtime";
import { buildRouteContext } from "./tool-executor";

export type ProactiveOptions = {
  minIntervalMs?: number;
  maxPerWindow?: number;
  windowMs?: number;
  quietBeforeManeuverS?: number;
  /** Traffic check period. */
  trafficEveryMs?: number;
  /** Minimum extra delay (minutes) ahead worth mentioning. */
  trafficDelayMin?: number;
};

export type ProactiveMessage = { event: CopilotEvent; reply: CopilotReply };

export class ProactiveEngine {
  private opts: Required<ProactiveOptions>;
  private spokenAt: number[] = [];
  private busy = false;
  private lastTrafficCheck = -Infinity;
  private trafficAlerted = new Set<string>();

  constructor(private copilot: NaviaCopilot, private runtime: CopilotRuntime, options: ProactiveOptions = {}) {
    this.opts = {
      minIntervalMs: 4 * 60_000, maxPerWindow: 3, windowMs: 30 * 60_000, quietBeforeManeuverS: 20,
      trafficEveryMs: 3 * 60_000, trafficDelayMin: 8, ...options,
    };
  }

  /** Why nothing may be said right now, or null if the driver can be addressed. */
  quietReason(nowMs: number): string | null {
    if (this.busy) return "busy";
    if (this.copilot.getPendingAction()) return "awaiting_answer";
    const last = this.spokenAt[this.spokenAt.length - 1];
    if (last != null && nowMs - last < this.opts.minIntervalMs) return "too_soon";
    if (this.spokenAt.filter((t) => nowMs - t < this.opts.windowMs).length >= this.opts.maxPerWindow) return "window_full";
    const { state } = this.runtime.getNavigation();
    const v = state.speedMps ?? 0;
    if (v > 2 && state.nextManeuverDistanceM != null && state.nextManeuverDistanceM / v < this.opts.quietBeforeManeuverS) return "maneuver_soon";
    return null;
  }

  /** Call about once a second. Resolves to a message to speak, or null. */
  async tick(): Promise<ProactiveMessage | null> {
    const now = this.runtime.now().getTime();
    if (this.quietReason(now)) return null;
    const pref = this.runtime.preferences?.()?.get("proactive_suggestions");
    const event = this.dueReminder(now) ?? (pref === "off" ? null : await this.trafficEvent(now, pref === "important_only" ? 15 : this.opts.trafficDelayMin));
    if (!event) return null;
    this.busy = true;
    try {
      const reply = await this.copilot.handleEvent(event);
      if (!reply) return null;
      this.spokenAt.push(now);
      return { event, reply };
    } finally {
      this.busy = false;
    }
  }

  private dueReminder(now: number): CopilotEvent | null {
    const session = this.copilot.session;
    const rc = buildRouteContext(this.runtime);
    const due = session.reminders.find((r) => (r.dueAtMs != null && now >= r.dueAtMs) || (r.dueAtAlongM != null && rc != null && rc.alongNowM >= r.dueAtAlongM));
    if (!due) return null;
    session.reminders = session.reminders.filter((r) => r.id !== due.id);
    return { type: "reminder_due", reminder: due, description: this.describeReminder(due, now) };
  }

  private describeReminder(r: Reminder, now: number): string {
    const minsAgo = Math.round((now - r.createdAt) / 60_000);
    return `Reminder ${r.id} is due: the driver asked ${minsAgo} min ago to be reminded about "${r.topic}"${r.categories.length ? ` (place categories: ${r.categories.join(", ")})` : ""}.`;
  }

  private async trafficEvent(now: number, minDelayMin: number): Promise<CopilotEvent | null> {
    if (now - this.lastTrafficCheck < this.opts.trafficEveryMs) return null;
    this.lastTrafficCheck = now;
    const rc = buildRouteContext(this.runtime);
    if (!rc) return null;
    let report;
    try { report = await this.runtime.traffic().getTrafficAlongRoute(rc.route, rc.alongNowM, rc.index.lengthM); } catch { return null; }
    if (!report.available) return null;
    const delayMin = Math.round(report.delays.reduce((a, d) => a + d.delayS, 0) / 60);
    if (delayMin < minDelayMin) return null;
    const key = `${rc.route.id}:${Math.floor(delayMin / 5)}`;
    if (this.trafficAlerted.has(key)) return null;
    this.trafficAlerted.add(key);
    return {
      type: "traffic_delay", delayMin,
      description: `Live traffic (${report.source}) shows about ${delayMin} min of extra delay ahead on the active route. compare_routes can check whether an alternative is faster.`,
    };
  }
}
