// NAVIA's neural voice: natural male (Ostap) and female (Polina) voices from
// the NAVIA proxy (/v1/tts, Azure AI Speech; the key stays on the server).
// Every phrase is cached on the phone, so repeated prompts play instantly and
// work offline. When the server, the network or the time budget fails, the
// caller falls back to the iPhone's own voice — speech never goes silent.
import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";
import { Audio } from "expo-av";
import { config } from "../config";
import { device } from "../ai/navigator/languageEngine";
import type { VoiceGender } from "../settings/AppSettings";
import { bytesToBase64 } from "./base64";

type Lang = "uk" | "en";

const DIR = `${FileSystem.cacheDirectory ?? ""}navia-tts/`;
const MAX_CACHED = 600;
/** After "not configured" / "key invalid" the server is not asked again for a while. */
let pausedUntil = 0;
let dirChecked = false;
let stopCurrent: (() => void) | null = null;

function base(): string | null {
  const url = config.aiProxyUrl;
  return url && config.aiClientToken ? url.replace(/\/+$/, "") : null;
}

export function cloudVoiceUsable(): boolean {
  return !!base() && Date.now() >= pausedUntil && !!FileSystem.cacheDirectory;
}

/** Whether the server has the neural voice switched on (Settings shows it). */
export async function cloudVoiceOnServer(): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const r = await fetch(`${b}/health`);
    const j = (await r.json()) as { tts?: boolean };
    return j.tts === true;
  } catch { return false; }
}

async function prepareDir(): Promise<void> {
  if (dirChecked) return;
  dirChecked = true;
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const files = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
  if (files.length > MAX_CACHED) await Promise.all(files.map((f) => FileSystem.deleteAsync(DIR + f, { idempotent: true }).catch(() => {})));
}

const inflight = new Map<string, Promise<string | null>>();

async function download(text: string, lang: Lang, gender: VoiceGender, uri: string): Promise<string | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(`${b}/v1/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.aiClientToken}`, "x-navia-device": device() },
      body: JSON.stringify({ text, lang, gender }),
    });
    if (!r.ok) {
      const err = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "";
      // Not set up on the server, or a bad key: stop asking for 10 minutes; busy: 30 s.
      pausedUntil = Date.now() + (/not configured|invalid|forbidden/.test(err) ? 10 * 60_000 : 30_000);
      return null;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length < 200) return null;
    await FileSystem.writeAsStringAsync(uri, bytesToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
    return uri;
  } catch { return null; }
}

/**
 * The phrase as a local audio file, or null. Waits at most `waitMs` for the
 * network; a download that finishes later is still cached for next time.
 */
export async function cloudSpeechFile(text: string, lang: Lang, gender: VoiceGender, waitMs: number): Promise<string | null> {
  if (!cloudVoiceUsable()) return null;
  await prepareDir();
  const key = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `v1|${lang}|${gender}|${text}`);
  const uri = `${DIR}${key}.mp3`;
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  if (info?.exists) return uri;
  let job = inflight.get(uri);
  if (!job) {
    job = download(text, lang, gender, uri).finally(() => inflight.delete(uri));
    inflight.set(uri, job);
  }
  return Promise.race([job, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs))]);
}

/** Plays the file to the end. False when it could not start (the caller then uses the device voice). */
export function playSpeechFile(uri: string, onStart: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    let sound: Audio.Sound | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (stopCurrent === stop) stopCurrent = null;
      if (sound) { sound.setOnPlaybackStatusUpdate(null); void sound.unloadAsync().catch(() => {}); }
      resolve(ok);
    };
    const stop = () => { if (sound) void sound.stopAsync().catch(() => {}); finish(true); };
    stopCurrent?.();
    stopCurrent = stop;
    Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1 }, (st) => {
      if (!st.isLoaded) { if (st.error) finish(started); return; }
      if (st.isPlaying && !started) { started = true; onStart(); }
      if (st.didJustFinish) finish(true);
    }).then((loaded) => {
      sound = loaded.sound;
      if (done) void loaded.sound.unloadAsync().catch(() => {});
    }).catch(() => finish(false));
  });
}

export function stopCloudSpeech(): void {
  stopCurrent?.();
}
