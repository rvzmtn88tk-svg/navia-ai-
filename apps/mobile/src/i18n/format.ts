// Pure formatting helpers (no React Native imports, so they are unit-tested
// with the core test runner).

export type Lang = "uk" | "en";

/** Ukrainian plural form: one (1, 21), few (2–4, 22–24), many (0, 5–20, 25…). */
export function ukPlural(n: number): "one" | "few" | "many" {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/** Rounds a distance the way drivers read it: 50 m steps near, 0.1 km far. */
export function roundDistance(meters: number): { value: number; unit: "m" | "km" } {
  const m = Math.max(0, meters);
  if (m < 1000) {
    const step = m < 100 ? 10 : 50;
    return { value: Math.max(step === 10 ? 10 : 50, Math.round(m / step) * step), unit: "m" };
  }
  const km = Math.round(m / 100) / 10;
  return { value: km >= 10 ? Math.round(km) : km, unit: "km" };
}

/** "300 м", "1,2 км" (uk) / "300 m", "1.2 km" (en). */
export function formatDistance(meters: number, lang: Lang): string {
  const { value, unit } = roundDistance(meters);
  const number = lang === "uk" ? String(value).replace(".", ",") : String(value);
  const label = unit === "m" ? (lang === "uk" ? "м" : "m") : (lang === "uk" ? "км" : "km");
  return `${number} ${label}`;
}

/** "12 хв", "1 год 5 хв". */
export function formatDuration(seconds: number, lang: Lang): string {
  const totalMin = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  const minLabel = lang === "uk" ? "хв" : "min";
  const hLabel = lang === "uk" ? "год" : "h";
  if (h === 0) return `${totalMin} ${minLabel}`;
  return min === 0 ? `${h} ${hLabel}` : `${h} ${hLabel} ${min} ${minLabel}`;
}

export function formatClock(timestampMs: number, lang: Lang): string {
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return lang === "uk" ? `${hh}:${mm}` : `${hh}:${mm}`;
}

const UK_ORDINAL_EXIT = ["", "перший", "другий", "третій", "четвертий", "п’ятий", "шостий", "сьомий", "восьмий"];
const EN_ORDINAL_EXIT = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

export function ordinalExit(n: number, lang: Lang): string {
  const table = lang === "uk" ? UK_ORDINAL_EXIT : EN_ORDINAL_EXIT;
  return table[n] ?? String(n);
}

/** Distance as spoken aloud: "300 метрів", "1,5 кілометра". */
export function spokenDistance(meters: number, lang: Lang): string {
  const { value, unit } = roundDistance(meters);
  if (lang === "en") {
    if (unit === "m") return `${value} meters`;
    return `${value} ${value === 1 ? "kilometer" : "kilometers"}`;
  }
  if (unit === "m") {
    const form = ukPlural(value);
    return `${value} ${form === "one" ? "метр" : form === "few" ? "метри" : "метрів"}`;
  }
  if (!Number.isInteger(value)) return `${String(value).replace(".", ",")} кілометра`;
  const form = ukPlural(value);
  return `${value} ${form === "one" ? "кілометр" : form === "few" ? "кілометри" : "кілометрів"}`;
}
