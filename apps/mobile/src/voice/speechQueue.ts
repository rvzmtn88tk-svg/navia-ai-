// One queue for everything NAVIA says (programme 2.4): a phrase that is
// already being spoken is finished; then the most urgent waiting phrase goes
// first — a proactive message (alert, GPS lost, off route) before an answer
// to a question, an answer before small talk. Equal urgency: in order.
// A new phrase of the same `slot` replaces a stale one still waiting (a turn
// prompt that is no longer current). Pure; the player is injected (tests).

export const PRIORITY = { proactiveCritical: 100, proactive: 60, guidance: 40, answer: 20, chatter: 0 } as const;

export type QueueItem = { text: string; priority: number; slot?: string; enqueuedAt: number; done?: () => void };
type Player = (text: string) => Promise<void>;

export class SpeechQueue {
  private waiting: QueueItem[] = [];
  private current: QueueItem | null = null;
  /** Every phrase with when it started playing (for tests / latency logs). */
  readonly played: (QueueItem & { startedAt: number })[] = [];

  constructor(private readonly play: Player, private readonly clock: () => number = () => Date.now()) {}

  get speaking(): QueueItem | null {
    return this.current;
  }

  get pending(): readonly QueueItem[] {
    return this.waiting;
  }

  /** Resolves when the phrase has been spoken (or dropped as stale). */
  say(text: string, priority: number, slot?: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    if (slot) { for (const w of this.waiting.filter((x) => x.slot === slot)) w.done?.(); this.waiting = this.waiting.filter((w) => w.slot !== slot); }
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => { done = resolve; });
    const item: QueueItem = { text, priority, enqueuedAt: this.clock(), done, ...(slot ? { slot } : {}) };
    // Stable insert by priority (higher first).
    const at = this.waiting.findIndex((w) => w.priority < priority);
    if (at < 0) this.waiting.push(item); else this.waiting.splice(at, 0, item);
    if (!this.current) void this.next();
    return finished;
  }

  /** Drop everything waiting (not the phrase being spoken). */
  clear(): void {
    for (const w of this.waiting) w.done?.();
    this.waiting = [];
  }

  private async next(): Promise<void> {
    const item = this.waiting.shift();
    if (!item) { this.current = null; return; }
    this.current = item;
    this.played.push({ ...item, startedAt: this.clock() });
    try { await this.play(item.text); } catch { /* a failed phrase must not stop the queue */ }
    item.done?.();
    await this.next();
  }
}
