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

  async startListening(onResult: (text: string) => void | Promise<void>, options: { language?: string } = {}): Promise<void> {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Надайте доступ до мікрофона й розпізнавання мовлення в налаштуваннях iPhone.");
    }

    await new Promise<void>((resolve, reject) => {
      let finalTranscript = "";
      let resultTask: Promise<void> = Promise.resolve();
      let settled = false;
      const cleanup = () => {
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

      const resultSubscription = ExpoSpeechRecognitionModule.addListener("result", (event) => {
        if (!event.isFinal) return;
        finalTranscript = event.results[0]?.transcript?.trim() ?? "";
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
          continuous: false,
        });
      } catch (error) {
        finish(error as Error);
      }
    });
  }
}
