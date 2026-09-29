// VoiceConversation — voice-first control of the co-pilot, independent of
// any UI:  speech-to-text → AI core → tools → answer → text-to-speech.
//
//   hands-free: listens continuously; an utterance is for NAVIA when it
//     starts with the wake word ("Навіа, …") — or when it comes within the
//     follow-up window after NAVIA asked something ("…Додати зупинку?" →
//     "так").
//   push-to-talk: one utterance, no wake word needed.
//   barge-in: the driver speaking while NAVIA talks stops the speech.
//   announcements (proactive messages, guidance) are spoken when the loop is
//     idle, never over the driver.
//
// The wake word is the one place a fixed word list is right: it is an
// addressing signal, not language understanding. Everything after it goes
// to the co-pilot as is.

export interface UtteranceListener {
  /** Listen for one utterance; exactly one of the callbacks fires. */
  listen(onResult: (text: string) => void, onError: (message: string) => void): Promise<{ stop: () => void }>;
}
export interface Speaker {
  speak(text: string): Promise<void>;
  stop(): void;
}
export interface ConversationBrain {
  ask(text: string): Promise<{ text: string; pendingAction: unknown | null }>;
}

export type VoiceState = "off" | "waiting_for_wake" | "listening" | "thinking" | "speaking";

export type VoiceOptions = {
  wakeWords?: string[];
  /** After NAVIA asks something, the next utterance within this window needs no wake word. */
  followUpMs?: number;
  now?: () => number;
  onState?: (s: VoiceState) => void;
  onExchange?: (user: string, reply: string) => void;
};

const DEFAULT_WAKE = ["навіа", "навиа", "навія", "навия", "навіє", "навья", "navia", "navya"];

function norm(s: string): string {
  return s.toLowerCase().replace(/[’'`ʼ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length]![b.length]!;
}

/** Does the utterance start with the wake word (tolerating one recognition error, "ей/hey" before it)? Returns what follows it. */
export function matchWakeWord(text: string, wakeWords: string[] = DEFAULT_WAKE): { matched: boolean; rest: string } {
  const words = norm(text).split(" ").filter(Boolean);
  let i = 0;
  if (words[0] && ["ей", "эй", "hey", "гей", "ok", "ок", "окей"].includes(words[0])) i = 1;
  const w = words[i];
  if (!w) return { matched: false, rest: text };
  const hit = wakeWords.some((k) => editDistance(w, k) <= (k.length >= 5 ? 1 : 0));
  if (!hit) return { matched: false, rest: text };
  // Keep the original wording of the rest (the co-pilot gets the driver's words, not a normalised form).
  const raw = text.trim().split(/\s+/);
  return { matched: true, rest: raw.slice(i + 1).join(" ").replace(/^[,.!?:;\s-]+/, "").trim() };
}

export class VoiceConversation {
  private state: VoiceState = "off";
  private handsFree = false;
  private followUpUntil = 0;
  private awaitingCommandUntil = 0;
  private handle: { stop: () => void } | null = null;
  private queue: string[] = [];
  private opts: Required<Omit<VoiceOptions, "onState" | "onExchange">> & Pick<VoiceOptions, "onState" | "onExchange">;

  constructor(private brain: ConversationBrain, private listener: UtteranceListener, private speaker: Speaker, options: VoiceOptions = {}) {
    this.opts = { wakeWords: DEFAULT_WAKE, followUpMs: 8_000, now: () => Date.now(), ...options };
  }

  getState(): VoiceState { return this.state; }

  private set(s: VoiceState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Continuous listening; only wake-word (or follow-up) utterances go to the co-pilot. */
  async startHandsFree(): Promise<void> {
    this.handsFree = true;
    await this.listenNext();
  }

  stop(): void {
    this.handsFree = false;
    this.handle?.stop();
    this.handle = null;
    this.speaker.stop();
    this.set("off");
  }

  /** One utterance, no wake word (the mic button). */
  async pushToTalk(): Promise<void> {
    this.speaker.stop();
    this.awaitingCommandUntil = this.opts.now() + 10_000;
    await this.listenNext(true);
  }

  /** Speak something NAVIA decided to say (proactive message, guidance) when not talking with the driver. */
  async announce(text: string): Promise<void> {
    if (this.state === "thinking" || this.state === "speaking") { this.queue.push(text); return; }
    await this.say(text, false);
  }

  /** Decide what an utterance is and act on it. Public for tests and for text input. */
  async handleUtterance(text: string): Promise<void> {
    const now = this.opts.now();
    if (this.state === "speaking") this.speaker.stop(); // barge-in
    let command: string | null = null;
    const wake = matchWakeWord(text, this.opts.wakeWords);
    if (wake.matched) {
      if (wake.rest) command = wake.rest;
      else { this.awaitingCommandUntil = now + 8_000; await this.say("Слухаю.", false); return; }
    } else if (now < this.followUpUntil || now < this.awaitingCommandUntil) {
      command = text.trim();
    }
    if (!command) return; // conversation in the car not addressed to NAVIA
    this.awaitingCommandUntil = 0;
    this.set("thinking");
    let reply: { text: string; pendingAction: unknown | null };
    try {
      reply = await this.brain.ask(command);
    } catch {
      reply = { text: "Вибачте, зараз не можу відповісти.", pendingAction: null };
    }
    this.opts.onExchange?.(command, reply.text);
    // NAVIA asked something: the answer needs no wake word.
    const asked = reply.pendingAction != null || /\?\s*$/.test(reply.text);
    await this.say(reply.text, asked);
  }

  private async say(text: string, openFollowUp: boolean): Promise<void> {
    this.set("speaking");
    try { await this.speaker.speak(text); } catch { /* TTS failure: nothing more to do */ }
    if (openFollowUp) this.followUpUntil = this.opts.now() + this.opts.followUpMs;
    const next = this.queue.shift();
    if (next) { await this.say(next, false); return; }
    this.set(this.handsFree ? "waiting_for_wake" : "off");
  }

  private async listenNext(once = false): Promise<void> {
    if (!once && !this.handsFree) return;
    this.set(once ? "listening" : "waiting_for_wake");
    this.handle = await this.listener.listen(
      (text) => { void this.handleUtterance(text).finally(() => { if (this.handsFree) void this.listenNext(); }); },
      () => { if (this.handsFree) void this.listenNext(); else this.set("off"); },
    );
  }
}
