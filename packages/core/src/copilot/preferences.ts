// Long-term driver preferences — the third memory layer:
//   conversation memory — CopilotSession.history / resultSets / focus (this conversation);
//   trip memory         — TripPlanner plan, CopilotSession.actions / reminders (this trip);
//   long-term           — PreferenceStore (across trips, persisted on the phone).
//
// Only explicit statements become preferences (the model calls
// remember_preference with the driver's own words); one-off requests don't.
// Values are validated per key so a preference is always usable by code and
// by the model, never an arbitrary blob.

import type { KeyValueStore } from "../storage";

export type PreferenceKey =
  | "preferred_fuel_brands" | "avoided_brands" | "preferred_food" | "dietary" | "max_detour_minutes"
  | "avoid_tolls" | "avoid_highways" | "avoid_unpaved" | "proactive_suggestions" | "reply_length";

export type PreferenceValue = string | number | boolean | string[];
export type PreferenceRecord = { value: PreferenceValue; driverWords: string; updatedAt: number };

const LIST_KEYS = new Set<PreferenceKey>(["preferred_fuel_brands", "avoided_brands", "preferred_food"]);
const BOOL_KEYS = new Set<PreferenceKey>(["avoid_tolls", "avoid_highways", "avoid_unpaved"]);
const ENUMS: Partial<Record<PreferenceKey, string[]>> = {
  proactive_suggestions: ["normal", "important_only", "off"],
  reply_length: ["short", "normal"],
};
export const PREFERENCE_KEYS: PreferenceKey[] = [
  "preferred_fuel_brands", "avoided_brands", "preferred_food", "dietary", "max_detour_minutes",
  "avoid_tolls", "avoid_highways", "avoid_unpaved", "proactive_suggestions", "reply_length",
];

/** Normalise a value for `key`, or explain why it isn't valid. */
export function validatePreference(key: string, value: unknown): { ok: true; key: PreferenceKey; value: PreferenceValue } | { ok: false; message: string } {
  if (!(PREFERENCE_KEYS as string[]).includes(key)) return { ok: false, message: `Unknown preference "${key}". Known: ${PREFERENCE_KEYS.join(", ")}.` };
  const k = key as PreferenceKey;
  if (LIST_KEYS.has(k)) {
    const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : null;
    const clean = arr?.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 40).slice(0, 8);
    return clean && clean.length ? { ok: true, key: k, value: clean } : { ok: false, message: `${key} needs a list of names.` };
  }
  if (BOOL_KEYS.has(k)) {
    if (typeof value === "boolean") return { ok: true, key: k, value };
    if (value === "true" || value === "false") return { ok: true, key: k, value: value === "true" };
    return { ok: false, message: `${key} needs true or false.` };
  }
  if (k === "max_detour_minutes") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 120 ? { ok: true, key: k, value: Math.round(n) } : { ok: false, message: "max_detour_minutes needs a number of minutes (0–120)." };
  }
  const allowed = ENUMS[k];
  if (allowed) return typeof value === "string" && allowed.includes(value) ? { ok: true, key: k, value } : { ok: false, message: `${key} must be one of ${allowed.join(", ")}.` };
  // dietary: short free text
  return typeof value === "string" && value.trim().length > 0 && value.length <= 80 ? { ok: true, key: k, value: value.trim() } : { ok: false, message: `${key} needs a short text.` };
}

export class PreferenceStore {
  private prefs = new Map<PreferenceKey, PreferenceRecord>();
  private loaded = false;

  constructor(private storage: KeyValueStore | null = null, private storageKey = "navia.preferences.v1") {}

  /** Load persisted preferences (no-op without storage). Safe to call more than once. */
  async load(): Promise<void> {
    if (this.loaded || !this.storage) { this.loaded = true; return; }
    this.loaded = true;
    try {
      const raw = await this.storage.getItem(this.storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, PreferenceRecord>;
      for (const [k, rec] of Object.entries(obj)) {
        const v = validatePreference(k, rec?.value);
        if (v.ok) this.prefs.set(v.key, { value: v.value, driverWords: String(rec.driverWords ?? ""), updatedAt: Number(rec.updatedAt ?? 0) });
      }
    } catch { /* unreadable storage: start empty rather than crash */ }
  }

  get(key: PreferenceKey): PreferenceValue | undefined { return this.prefs.get(key)?.value; }
  all(): ReadonlyMap<PreferenceKey, PreferenceRecord> { return this.prefs; }

  set(key: PreferenceKey, value: PreferenceValue, driverWords: string, now = Date.now()): PreferenceRecord | undefined {
    const previous = this.prefs.get(key);
    this.prefs.set(key, { value, driverWords, updatedAt: now });
    void this.persist();
    return previous;
  }

  remove(key: PreferenceKey): PreferenceRecord | undefined {
    const previous = this.prefs.get(key);
    this.prefs.delete(key);
    void this.persist();
    return previous;
  }

  /** One compact line for <trip_state>. */
  summary(): string {
    if (this.prefs.size === 0) return "none";
    return [...this.prefs.entries()].map(([k, r]) => `${k}=${Array.isArray(r.value) ? r.value.join(",") : String(r.value)}`).join("; ");
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    try { await this.storage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.prefs))); } catch { /* best effort */ }
  }
}
