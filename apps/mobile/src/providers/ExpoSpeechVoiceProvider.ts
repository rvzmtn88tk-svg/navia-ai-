import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

export class ExpoSpeechVoiceProvider {
  async speak(text: string, options: { language?: string } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      Speech.speak(text, {
        language: options.language ?? "uk-UA",
        onDone: () => resolve(),
        onError: (err) => reject(err),
      });
    });
  }

  stopSpeaking(): void {
    Speech.stop();
  }

  async isSpeaking(): Promise<boolean> {
    return Speech.isSpeakingAsync();
  }

  /** Stop listening now (hold-to-talk: the button was released); the final result follows. */
  stopListening(): void {
    this.stoppedAt = Date.now();
    this.stopNow?.();
  }

  private stoppedAt: number | null = null;
  private stopNow: (() => void) | null = null;
  /** Timing of the last recognition: end of speech (or release) → final text. */
  lastTiming: { speechEndAt: number | null; finalAt: number | null; sttMs: number | null } = { speechEndAt: null, finalAt: null, sttMs: null };

  /**
   * Listens for one question. The microphone is ready only when audio really
   * flows (`onReady` on "audiostart" — the UI says "говоріть" then, not
   * before). The end of the phrase is decided here, not by iOS: 1.2 s after
   * the last recognised words (tap), or on release (hold). No speech in 7 s →
   * a clear message in Ukrainian. Every attempt is logged (recognised or not).
   */
  async startListening(onResult: (text: string) => void | Promise<void>, options: { language?: string; hold?: boolean; onReady?: () => void } = {}): Promise<void> {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Надайте доступ до мікрофона й розпізнавання мовлення в налаштуваннях iPhone.");
    }
    const lang = options.language ?? "uk-UA";
    const onDevice = await onDeviceFor(lang);
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      let heard = "";
      let speechEndAt: number | null = null;
      let lastWordsAt: number | null = null;
      let audioAt: number | null = null;
      let settled = false;
      this.stoppedAt = null;
      this.lastTiming = { speechEndAt: null, finalAt: null, sttMs: null };
      const subs: { remove(): void }[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const cleanup = () => { for (const x of subs) x.remove(); for (const t of timers) clearTimeout(t); this.stopNow = null; };
      const finish = (error?: Error, code?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        void logAttempt({ at: startedAt, ok: !error, text: heard, error: code ?? (error ? error.message : null), audioStartMs: audioAt != null ? audioAt - startedAt : null, onDevice, hold: options.hold === true });
        if (error) reject(error); else resolve();
      };
      const deliver = () => {
        const text = heard.trim();
        if (!text) {
          // The driver stopped the microphone before saying anything: no error message.
          if (this.stoppedAt != null) { const e = new Error(""); e.name = "VoiceCancelled"; finish(e, "cancelled"); return; }
          finish(new Error(message("no-speech")), "no-speech");
          return;
        }
        const end = this.stoppedAt ?? speechEndAt ?? lastWordsAt ?? Date.now();
        const finalAt = Date.now();
        this.lastTiming = { speechEndAt: end, finalAt, sttMs: finalAt - end };
        Promise.resolve(onResult(text)).then(() => finish(), (e: unknown) => finish(e as Error));
      };
      this.stopNow = () => { try { ExpoSpeechRecognitionModule.stop(); } catch { /* not running */ } };
      subs.push(
        ExpoSpeechRecognitionModule.addListener("audiostart", () => { audioAt = Date.now(); options.onReady?.(); }),
        ExpoSpeechRecognitionModule.addListener("speechend", () => { speechEndAt = Date.now(); }),
        ExpoSpeechRecognitionModule.addListener("result", (event) => {
          const t = event.results[0]?.transcript?.trim() ?? "";
          if (t) { heard = t; lastWordsAt = Date.now(); }
          if (event.isFinal && !options.hold) deliver();
          // Tap mode: a pause of 1.2 s after the last words ends the phrase.
          if (!event.isFinal && !options.hold) {
            timers.push(setTimeout(() => { if (lastWordsAt != null && Date.now() - lastWordsAt >= 1150) this.stopNow?.(); }, 1200));
          }
        }),
        ExpoSpeechRecognitionModule.addListener("error", (event) => {
          // A stop with words already heard is a normal end, not an error.
          // So is the driver's own stop before any words (deliver() treats it as cancelled).
          if ((heard || this.stoppedAt != null) && (event.error === "no-speech" || event.error === "aborted")) { deliver(); return; }
          finish(new Error(message(event.error)), event.error);
        }),
        ExpoSpeechRecognitionModule.addListener("end", () => { if (!settled) deliver(); }),
      );
      // Tap mode: nothing heard in 7 s → stop (the message says to speak right after the signal).
      if (!options.hold) timers.push(setTimeout(() => { if (!heard) this.stopNow?.(); }, 7000));
      try {
        ExpoSpeechRecognitionModule.start({
          lang,
          interimResults: true,
          maxAlternatives: 1,
          // NAVIA decides the end of the phrase (above), so iOS keeps listening.
          continuous: true,
          requiresOnDeviceRecognition: onDevice,
          addsPunctuation: false,
          contextualStrings: ["NAVIA", "укриття", "маршрут", "сигнал", "тривога", "поворот", "пункт незламності", "АЗС", "аптека"],
          iosTaskHint: "search",
        });
      } catch (error) {
        finish(error as Error, "start-failed");
      }
    });
  }
}

/** Speech recognition errors in plain Ukrainian (never the raw iOS text). */
export function message(code: string | undefined): string {
  switch (code) {
    case "no-speech": return "Не вдалося почути питання. Натисніть мікрофон і почніть говорити після слова «Говоріть».";
    case "not-allowed": case "service-not-allowed": return "Немає доступу до мікрофона чи розпізнавання мовлення — дозвольте його в налаштуваннях iPhone.";
    case "audio-capture": return "Мікрофон зайнятий іншим застосунком або дзвінком. Спробуйте ще раз.";
    case "network": return "Для розпізнавання мовлення потрібен інтернет (на цьому iPhone українська не розпізнається без мережі).";
    case "language-not-supported": return "Розпізнавання української на цьому iPhone недоступне — оновіть iOS або введіть питання текстом.";
    case "busy": return "Розпізнавання ще зайняте — спробуйте за секунду.";
    case "aborted": return "Прослуховування зупинено.";
    default: return "Не вдалося розпізнати питання. Спробуйте ще раз або введіть текстом.";
  }
}

export type VoiceAttempt = { at: number; ok: boolean; text: string; error: string | null; audioStartMs: number | null; onDevice: boolean; hold: boolean };
const ATTEMPTS_KEY = "navia.voice.attempts.v1";
/** Every recognition attempt, kept on the phone (last 100) — to count real recognition rates. */
async function logAttempt(a: VoiceAttempt): Promise<void> {
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { getItemAsync(k: string): Promise<string | null>; setItemAsync(k: string, v: string): Promise<void> } }).default;
    const old = JSON.parse((await kv.getItemAsync(ATTEMPTS_KEY)) ?? "[]") as VoiceAttempt[];
    await kv.setItemAsync(ATTEMPTS_KEY, JSON.stringify([...old, a].slice(-100)));
  } catch { /* storage unavailable */ }
}

/** On-device recognition only when the phone supports it AND has this language installed. */
export async function onDeviceFor(lang: string): Promise<boolean> {
  try {
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) return false;
    const r = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return (r.installedLocales ?? []).some((l: string) => l.toLowerCase().replace("_", "-") === lang.toLowerCase());
  } catch { return false; }
}
