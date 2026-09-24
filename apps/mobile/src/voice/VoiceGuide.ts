// Spoken guidance. One queue for all NAVIA speech: new maneuver prompts
// interrupt stale ones, and music is ducked (not stopped) while speaking.
// Provider: the iPhone's built-in voices. A neural cloud voice plugs in behind
// the same `speak` call once a provider is chosen (see docs/NAVIA_TZ.md §10).
import * as Speech from "expo-speech";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import type { VoiceGender } from "../settings/AppSettings";

type Lang = "uk" | "en";

let voicesPromise: Promise<Speech.Voice[]> | null = null;
let audioModeReady = false;

async function voices(): Promise<Speech.Voice[]> {
  voicesPromise ??= Speech.getAvailableVoicesAsync().catch(() => []);
  return voicesPromise;
}

// Heuristic on iOS voice identifiers/names; iOS ships few Ukrainian voices,
// so gender falls back to whatever Ukrainian voice exists.
const MALE_HINTS = /(male|man|daniel|yuri|aaron|fred|arthur|gordon|reed|rocko|eddy|grandpa|oliver)/i;
const FEMALE_HINTS = /(female|lesya|milena|samantha|karen|kathy|shelley|flo|sandy|grandma|victoria)/i;

export async function pickVoice(lang: Lang, gender: VoiceGender): Promise<Speech.Voice | null> {
  const all = await voices();
  const prefix = lang === "uk" ? "uk" : "en";
  const candidates = all.filter((v) => v.language.toLowerCase().startsWith(prefix));
  if (candidates.length === 0) return null;
  const hint = gender === "male" ? MALE_HINTS : FEMALE_HINTS;
  const byQuality = [...candidates].sort((a, b) => qualityRank(b) - qualityRank(a));
  return byQuality.find((v) => hint.test(`${v.identifier} ${v.name}`)) ?? byQuality[0] ?? null;
}

function qualityRank(v: Speech.Voice): number {
  return v.quality === Speech.VoiceQuality.Enhanced ? 1 : 0;
}

/** Whether a voice of the requested gender exists on this device for the language. */
export async function hasGenderVoice(lang: Lang, gender: VoiceGender): Promise<boolean> {
  const all = await voices();
  const prefix = lang === "uk" ? "uk" : "en";
  const hint = gender === "male" ? MALE_HINTS : FEMALE_HINTS;
  return all.some((v) => v.language.toLowerCase().startsWith(prefix) && hint.test(`${v.identifier} ${v.name}`));
}

async function ensureAudioMode(): Promise<void> {
  if (audioModeReady) return;
  await Audio.setAudioModeAsync({
    playsInSilentModeIOS: true,
    interruptionModeIOS: InterruptionModeIOS.DuckOthers,
    interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
    shouldDuckAndroid: true,
    staysActiveInBackground: false,
  }).catch(() => {});
  audioModeReady = true;
}

export type SpeakOptions = { lang: Lang; gender: VoiceGender; interrupt?: boolean };

export async function speak(text: string, { lang, gender, interrupt = true }: SpeakOptions): Promise<void> {
  await ensureAudioMode();
  const voice = await pickVoice(lang, gender);
  if (interrupt) Speech.stop();
  await new Promise<void>((resolve) => {
    Speech.speak(text, {
      language: lang === "uk" ? "uk-UA" : "en-US",
      voice: voice?.identifier,
      rate: lang === "uk" ? 0.98 : 1,
      onDone: () => resolve(),
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

export function stopSpeaking(): void {
  Speech.stop();
}
