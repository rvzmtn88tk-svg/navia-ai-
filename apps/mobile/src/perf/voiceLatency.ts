// Voice pipeline timings from real use (programme 3.2): end of speech →
// final text (STT), understanding + answer (layers 2–5), answer → first sound
// (TTS). Kept on the phone (last 100) so they can be read from the app data.
export type VoiceLatency = { question: string; sttMs: number | null; understandMs: number; ttsStartMs: number | null; totalMs: number | null; at: number };

const KEY = "navia.voice.latency.v1";
const log: VoiceLatency[] = [];

export async function recordVoiceLatency(v: VoiceLatency): Promise<void> {
  log.push(v);
  if (log.length > 100) log.shift();
  if (__DEV__) console.log(`[voice] «${v.question}» STT ${v.sttMs ?? "?"} ms · understanding ${v.understandMs.toFixed(1)} ms · TTS start ${v.ttsStartMs ?? "?"} ms · total ${v.totalMs ?? "?"} ms`);
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { getItemAsync(k: string): Promise<string | null>; setItemAsync(k: string, v: string): Promise<void> } }).default;
    const old = JSON.parse((await kv.getItemAsync(KEY)) ?? "[]") as VoiceLatency[];
    await kv.setItemAsync(KEY, JSON.stringify([...old, v].slice(-100)));
  } catch { /* storage unavailable */ }
}

export function voiceLatencyLog(): readonly VoiceLatency[] {
  return log;
}
