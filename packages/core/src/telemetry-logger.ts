// TelemetryLogger — spec section 32 ("LOGGING").
// "Every navigation event gets [a NavigationEvent]. Allow export to JSON for testing."

import type { NavigationEvent } from "./types";

export class TelemetryLogger {
  private events: NavigationEvent[] = [];
  constructor(private maxEvents = 2000) {}

  log(type: NavigationEvent["type"], payload: Record<string, unknown> = {}, timestamp = Date.now()): NavigationEvent {
    const event: NavigationEvent = { timestamp, type, payload };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    return event;
  }

  getEvents(): readonly NavigationEvent[] {
    return this.events;
  }

  getEventsByType(type: NavigationEvent["type"]): NavigationEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  clear(): void {
    this.events = [];
  }

  exportJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }
}
