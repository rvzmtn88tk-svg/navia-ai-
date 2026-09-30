// Neural speech for NAVIA (Azure AI Speech): natural male and female voices.
// iOS has only one Ukrainian voice (female), so the male voice and the more
// natural female one come from here. The key is a Worker secret
// (AZURE_SPEECH_KEY) and never reaches the app.

export type TtsLang = "uk" | "en";
export type TtsGender = "male" | "female";

const VOICES: Record<"uk" | "ru" | "en", Record<TtsGender, string>> = {
  uk: { male: "uk-UA-OstapNeural", female: "uk-UA-PolinaNeural" },
  ru: { male: "ru-RU-DmitryNeural", female: "ru-RU-SvetlanaNeural" },
  en: { male: "en-US-AndrewMultilingualNeural", female: "en-US-AvaMultilingualNeural" },
};

/** Letters only Russian has: the co-pilot answers a Russian speaker in Russian. */
const RUSSIAN_ONLY = /[ыэъё]/i;

export function voiceFor(text: string, lang: TtsLang, gender: TtsGender): { name: string; locale: string } {
  const l = lang === "en" ? "en" : RUSSIAN_ONLY.test(text) ? "ru" : "uk";
  const name = VOICES[l][gender];
  return { name, locale: name.slice(0, 5) };
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function ssml(text: string, voice: { name: string; locale: string }): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.locale}"><voice name="${voice.name}">${escapeXml(text)}</voice></speak>`;
}

export const TTS_MAX_CHARS = 600;

export type TtsRequest = { text: string; lang: TtsLang; gender: TtsGender };

export function parseTtsRequest(body: unknown): TtsRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return "text is required";
  if (text.length > TTS_MAX_CHARS) return "text too long";
  const lang: TtsLang = b.lang === "en" ? "en" : "uk";
  const gender: TtsGender = b.gender === "male" ? "male" : "female";
  return { text, lang, gender };
}

/** MP3 bytes from Azure, or null with the reason. */
export async function synthesize(req: TtsRequest, key: string, region: string, signal?: AbortSignal): Promise<{ audio: ArrayBuffer } | { error: string; status: number }> {
  const voice = voiceFor(req.text, req.lang, req.gender);
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "navia-proxy",
    },
    body: ssml(req.text, voice),
    signal,
  });
  if (r.status === 401 || r.status === 403) return { error: "speech key invalid", status: 502 };
  if (r.status === 429) return { error: "speech busy", status: 503 };
  if (!r.ok) return { error: `speech error ${r.status}`, status: 502 };
  return { audio: await r.arrayBuffer() };
}
