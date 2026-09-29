// The iPhone's speech recognition (expo-speech-recognition → SFSpeechRecognizer)
// as a continuous recognizer for hands-free mode. On-device recognition is
// used when the phone supports it for the language (no network, no Apple
// server limits); otherwise Apple's server recognition. The wake phrase and
// NAVIA's vocabulary are given as contextual hints.
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type { Recognizer } from "./handsFree";

export async function handsFreePermission(): Promise<boolean> {
  try { return (await ExpoSpeechRecognitionModule.requestPermissionsAsync()).granted; } catch { return false; }
}

export function expoRecognizer(lang: "uk" | "en"): Recognizer & { onDevice: boolean } {
  const locale = lang === "uk" ? "uk-UA" : "en-US";
  let onDevice = false;
  try { onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(); } catch { onDevice = false; }
  let subs: { remove(): void }[] = [];
  const clear = () => { for (const s of subs) s.remove(); subs = []; };
  return {
    onDevice,
    start(onFinal, onEnd, onError) {
      clear();
      subs = [
        ExpoSpeechRecognitionModule.addListener("result", (e) => { if (e.isFinal) { const t = e.results[0]?.transcript?.trim(); if (t) onFinal(t); } }),
        ExpoSpeechRecognitionModule.addListener("end", () => { clear(); onEnd(); }),
        ExpoSpeechRecognitionModule.addListener("error", (e) => { clear(); if (e.error === "no-speech" || e.error === "aborted") onEnd(); else onError(e.message || e.error); }),
      ];
      try {
        ExpoSpeechRecognitionModule.start({
          lang: locale, continuous: true, interimResults: false, maxAlternatives: 1,
          requiresOnDeviceRecognition: onDevice,
          contextualStrings: ["NAVIA", "Навіа", "штурман", "укриття", "маршрут", "сигнал", "тривога"],
          iosTaskHint: "dictation",
        });
      } catch (err) { clear(); onError((err as Error).message); }
    },
    stop() {
      clear();
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ }
    },
  };
}
