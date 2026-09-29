// Voice I/O adapter — spec section 17 ("VOICE"). Text-to-speech via
// expo-speech; speech-to-text via expo-speech-recognition (Apple Speech
// framework on iOS, Android SpeechRecognizer), Ukrainian by default. Both
// are native modules: they work in a development/production build, not in
// Expo Go, and have not been exercised on a device from the cloud sandbox
// (see LIMITATIONS.md). Permissions (microphone + speech recognition) are
// requested at the moment the driver taps the mic; the iOS usage strings
// come from the expo-speech-recognition config plugin in app.json.
import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule, addSpeechRecognitionListener } from "expo-speech-recognition";

export type ListeningHandle = { stop: () => void };

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

  /**
   * Listen for one utterance. Calls `onResult` once with the final
   * transcript, or `onError` with a Ukrainian, driver-readable reason
   * (permission denied, recognition unavailable, nothing heard). Throws only
   * if the native module is missing from the build.
   */
  async startListening(
    onResult: (text: string) => void,
    onError: (message: string) => void,
    options: { lang?: string } = {},
  ): Promise<ListeningHandle> {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      onError("Розпізнавання мовлення недоступне на цьому пристрої.");
      return { stop: () => {} };
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      onError("Немає дозволу на мікрофон або розпізнавання мовлення. Увімкніть його в Налаштуваннях.");
      return { stop: () => {} };
    }
    Speech.stop(); // don't transcribe our own TTS
    let delivered = false;
    const subs = [
      addSpeechRecognitionListener("result", (event) => {
        if (!event.isFinal || delivered) return;
        const text = event.results[0]?.transcript?.trim() ?? "";
        delivered = true;
        cleanup();
        if (text) onResult(text);
        else onError("Не почула запитання.");
      }),
      addSpeechRecognitionListener("error", (event) => {
        if (delivered) return;
        delivered = true;
        cleanup();
        onError(event.error === "no-speech" || event.error === "speech-timeout"
          ? "Не почула запитання."
          : event.error === "not-allowed"
            ? "Немає дозволу на розпізнавання мовлення."
            : `Розпізнавання мовлення не вдалося (${event.error}).`);
      }),
      addSpeechRecognitionListener("end", () => {
        if (!delivered) { delivered = true; cleanup(); onError("Не почула запитання."); }
      }),
    ];
    function cleanup() { for (const s of subs) s.remove(); }
    ExpoSpeechRecognitionModule.start({ lang: options.lang ?? "uk-UA", interimResults: false, continuous: false });
    return {
      stop: () => { ExpoSpeechRecognitionModule.stop(); },
    };
  }
}
