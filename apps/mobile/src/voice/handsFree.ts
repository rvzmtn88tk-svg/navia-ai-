// Hands-free voice during navigation. After the driver turns the mode on
// once (one tap), nothing more needs a hand:
//   1. NAVIA listens continuously for its name ("NAVIA", "Навіа", "штурман")
//      — the wake phrase is found in the speech-to-text transcript.
//   2. "NAVIA, куди далі?" — the question after the name is answered at once;
//      just "NAVIA" — NAVIA says "Слухаю" and takes the next phrase.
//   3. After an answer (or a question back) there is a follow-up window: the
//      next phrase is taken without the name.
//   4. While NAVIA speaks, recognition is paused (so NAVIA does not hear
//      itself) and resumes after.
//   5. iOS ends a recognition session after about a minute or on silence —
//      it is restarted; repeated errors stop the mode with a message.
// Pure state machine; the recognizer and the clock are injected (tests).

export type HandsFreeState = "off" | "wake" | "command" | "followUp" | "paused";

export interface Recognizer {
  /** Starts a continuous session; final phrases come to onFinal. */
  start(onFinal: (text: string) => void, onEnd: () => void, onError: (message: string) => void): void;
  stop(): void;
}

export type HandsFreeEvents = {
  /** A question to answer (wake word removed). */
  onQuestion: (question: string) => void;
  /** Speak a short prompt ("Слухаю"). */
  onPrompt: (text: string) => void;
  onState?: (state: HandsFreeState) => void;
  onError?: (message: string) => void;
};

/** "NAVIA", "Навіа/Навия/Навія", "Нафія" (a common mishearing), "штурман/штурмане". */
const WAKE = /(^|[\s,.!?])(navia|nav[iy]a|нав[іиы]?[яа]|нав[іи]а|нафі[яа]|нафи[яа]|штурма(н|не))(?=$|[\s,.!?])/i;

/** The question after the wake phrase ("" when only the name was said), or null (no wake phrase). */
export function afterWake(text: string): string | null {
  const m = WAKE.exec(text);
  if (!m) return null;
  return text.slice(m.index + m[0].length).replace(/^[\s,.!?—-]+/, "").trim();
}

export const FOLLOW_UP_MS = 8000;
export const COMMAND_MS = 7000;
const MAX_ERRORS = 3;

export class HandsFree {
  private state: HandsFreeState = "off";
  private resumeTo: HandsFreeState = "wake";
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private errors = 0;
  private listening = false;

  constructor(
    private readonly rec: Recognizer,
    private readonly ev: HandsFreeEvents,
    private readonly timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
  ) {}

  get current(): HandsFreeState {
    return this.state;
  }

  enable(): void {
    if (this.state !== "off") return;
    this.errors = 0;
    this.set("wake");
    this.listen();
  }

  disable(): void {
    this.clearWindow();
    this.set("off");
    this.stopListening();
  }

  /** NAVIA starts speaking: stop hearing (so it does not answer itself). */
  speaking(): void {
    if (this.state === "off" || this.state === "paused") return;
    this.resumeTo = this.state === "command" ? "command" : this.state;
    this.clearWindow();
    this.set("paused");
    this.stopListening();
  }

  /** NAVIA finished speaking. `answered`: that was an answer (or a question back) — open the follow-up window. */
  doneSpeaking(answered: boolean): void {
    if (this.state !== "paused") return;
    const to = answered ? "followUp" : this.resumeTo;
    this.set(to);
    if (to === "followUp") this.openWindow(FOLLOW_UP_MS);
    if (to === "command") this.openWindow(COMMAND_MS);
    this.listen();
  }

  private listen(): void {
    if (this.listening || this.state === "off" || this.state === "paused") return;
    this.listening = true;
    this.rec.start((t) => this.heard(t), () => this.ended(), (m) => this.failed(m));
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    this.rec.stop();
  }

  private heard(text: string): void {
    const phrase = text.trim();
    if (!phrase || this.state === "off" || this.state === "paused") return;
    this.errors = 0;
    if (this.state === "followUp" || this.state === "command") {
      // No name needed; a name at the start is dropped.
      const q = afterWake(phrase) ?? phrase;
      this.clearWindow();
      if (q) { this.set("wake"); this.ev.onQuestion(q); }
      return;
    }
    const q = afterWake(phrase);
    if (q === null) return; // not addressed to NAVIA
    if (q) { this.ev.onQuestion(q); return; }
    this.set("command");
    this.ev.onPrompt("Слухаю");
  }

  private ended(): void {
    this.listening = false;
    // The session ended (time limit, silence): listen again while the mode is on.
    if (this.state !== "off" && this.state !== "paused") this.listen();
  }

  private failed(message: string): void {
    this.listening = false;
    this.errors++;
    if (this.errors >= MAX_ERRORS) {
      this.disable();
      this.ev.onError?.(message);
      return;
    }
    if (this.state !== "off" && this.state !== "paused") this.timers.set(() => this.listen(), 800);
  }

  private openWindow(ms: number): void {
    this.clearWindow();
    this.windowTimer = this.timers.set(() => { this.windowTimer = null; if (this.state === "followUp" || this.state === "command") this.set("wake"); }, ms);
  }

  private clearWindow(): void {
    if (this.windowTimer) { this.timers.clear(this.windowTimer); this.windowTimer = null; }
  }

  private set(s: HandsFreeState): void {
    this.state = s;
    this.ev.onState?.(s);
  }
}
