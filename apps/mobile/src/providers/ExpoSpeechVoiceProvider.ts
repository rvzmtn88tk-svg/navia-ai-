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
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* not listening */ }
  }

  private stoppedAt: number | null = null;
  /** Timing of the last recognition: end of speech (or release) → final text. */
  lastTiming: { speechEndAt: number | null; finalAt: number | null; sttMs: number | null } = { speechEndAt: null, finalAt: null, sttMs: null };

  /** `hold`: keeps listening while the button is held (stopListening() ends it). */
  async startListening(onResult: (text: string) => void | Promise<void>, options: { language?: string; hold?: boolean } = {}): Promise<void> {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Надайте доступ до мікрофона й розпізнавання мовлення в налаштуваннях iPhone.");
    }

    await new Promise<void>((resolve, reject) => {
      let finalTranscript = "";
      let speechEndAt: number | null = null;
      this.stoppedAt = null;
      this.lastTiming = { speechEndAt: null, finalAt: null, sttMs: null };
      let resultTask: Promise<void> = Promise.resolve();
      let settled = false;
      const cleanup = () => {
        speechEndSubscription.remove();
        resultSubscription.remove();
        errorSubscription.remove();
        endSubscription.remove();
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      const speechEndSubscription = ExpoSpeechRecognitionModule.addListener("speechend", () => { speechEndAt = Date.now(); });
      const resultSubscription = ExpoSpeechRecognitionModule.addListener("result", (event) => {
        if (!event.isFinal) return;
        finalTranscript = event.results[0]?.transcript?.trim() ?? "";
        // STT latency: from the end of speech (or the button release) to the final text.
        const end = Math.min(...[speechEndAt, this.stoppedAt].filter((x): x is number => x != null));
        const finalAt = Date.now();
        this.lastTiming = { speechEndAt: Number.isFinite(end) ? end : null, finalAt, sttMs: Number.isFinite(end) ? finalAt - end : null };
        if (finalTranscript) resultTask = Promise.resolve(onResult(finalTranscript));
      });
      const errorSubscription = ExpoSpeechRecognitionModule.addListener("error", (event) => {
        finish(new Error(event.message || "Не вдалося розпізнати команду."));
      });
      const endSubscription = ExpoSpeechRecognitionModule.addListener("end", () => {
        if (!finalTranscript) {
          finish(new Error("Не почули команду. Спробуйте сказати її ще раз."));
          return;
        }
        void resultTask.then(() => finish()).catch((error: unknown) => finish(error as Error));
      });

      try {
        ExpoSpeechRecognitionModule.start({
          lang: options.language ?? "uk-UA",
          interimResults: false,
          maxAlternatives: 1,
          // Hold-to-talk: listen until the button is released.
          continuous: options.hold === true,
          iosTaskHint: "search",
        });
      } catch (error) {
        finish(error as Error);
      }
    });
  }
}
