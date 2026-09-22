// Voice I/O adapter — spec section 17 ("VOICE"). Text-to-speech via
// expo-speech (well-established, stable API); speech-to-text is left as a
// documented not-implemented method, since Expo's built-in APIs don't cover
// STT and a third-party module choice (e.g. expo-speech-recognition) needs
// picking against real device testing this sandbox cannot do — see
// LIMITATIONS.md. TTS itself is UNBUILT/UNTESTED here for the same reason
// (no device/simulator to actually hear it), but the wiring is standard.
import * as Speech from "expo-speech";

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

  /** Not implemented in this pass — see file header. */
  startListening(_onResult: (text: string) => void): never {
    throw new Error(
      "ExpoSpeechVoiceProvider.startListening is not implemented: speech-to-text needs a " +
      "concrete native module choice validated on a real device, which this sandbox has no " +
      "way to test. Wire in a chosen STT module (e.g. expo-speech-recognition) here."
    );
  }
}
