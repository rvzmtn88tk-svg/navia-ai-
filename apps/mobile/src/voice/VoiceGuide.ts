// Spoken guidance. One queue for all NAVIA speech: new maneuver prompts
// interrupt stale ones, and music is ducked (not stopped) while speaking.
// Provider: the iPhone's built-in voices. A neural cloud voice plugs in behind
// the same `speak` call once a provider is chosen (see docs/NAVIA_TZ.md §10).
import * as Speech from "expo-speech";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import type { VoiceGender } from "../settings/AppSettings";
import { SpeechQueue } from "./speechQueue";

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
  // iOS ships no male Ukrainian voice. Until the neural server voice is
  // connected, "male" lowers the pitch of the available voice.
  const lowered = gender === "male" && !(await hasGenderVoice(lang, "male"));
  if (interrupt) Speech.stop();
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    Speech.speak(text, {
      language: lang === "uk" ? "uk-UA" : "en-US",
      voice: voice?.identifier,
      rate: lang === "uk" ? 0.98 : 1,
      pitch: lowered ? 0.72 : 1,
      onStart: () => { lastTtsStartMs = Date.now() - t0; const w = startWaiters.splice(0); for (const f of w) f(lastTtsStartMs); },
      onDone: () => resolve(),
      onStopped: () => resolve(),
      onError: () => resolve(),
    });
  });
}

/** Time from the speak call to the first sound of the last phrase (ms). */
let lastTtsStartMs: number | null = null;
const startWaiters: ((ms: number) => void)[] = [];
/** Resolves with the speak → first sound time of the next phrase that starts. */
export function nextTtsStart(): Promise<number> {
  return new Promise((resolve) => startWaiters.push(resolve));
}
export function lastTtsStartLatencyMs(): number | null {
  return lastTtsStartMs;
}

// ——— the shared queue (programme 2.4): nothing NAVIA says cuts a phrase short ———
let queueOpts: SpeakOptions = { lang: "uk", gender: "female" };
/** What kind of phrase is being spoken (hands-free opens a follow-up window after an answer). */
export type SpeechTag = "answer" | "prompt" | "proactive" | "guidance";
const tags = new Map<string, SpeechTag>();
type SpeechListener = (speaking: boolean, tag: SpeechTag | null) => void;
const speechListeners = new Set<SpeechListener>();
/** Called when NAVIA starts / stops speaking (hands-free pauses listening meanwhile). */
export function onSpeech(listener: SpeechListener): () => void {
  speechListeners.add(listener);
  return () => { speechListeners.delete(listener); };
}
const queue = new SpeechQueue(async (text) => {
  const tag = tags.get(text) ?? null;
  for (const l of speechListeners) l(true, tag);
  try { await speak(text, { ...queueOpts, interrupt: false }); } finally {
    tags.delete(text);
    // Idle only when nothing else waits in the queue.
    if (queue.pending.length === 0) for (const l of speechListeners) l(false, tag);
  }
});

/** Say through the shared queue: the current phrase is finished, then the most urgent. */
export function say(text: string, priority: number, opts: { lang: Lang; gender: VoiceGender }, slot?: string, tag?: SpeechTag): Promise<void> {
  queueOpts = { ...opts, interrupt: false };
  if (tag) tags.set(text, tag);
  return queue.say(text, priority, slot);
}

export function clearSpeechQueue(): void {
  queue.clear();
}

export function stopSpeaking(): void {
  Speech.stop();
}
