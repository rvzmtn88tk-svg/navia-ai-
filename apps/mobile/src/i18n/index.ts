import { useCallback } from "react";
import { useAppSettings } from "../settings/AppSettings";
import { en, uk, type StringKey } from "./strings";

export type { StringKey } from "./strings";
export * from "./format";

export type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

export function translate(lang: "uk" | "en", key: StringKey, params?: Record<string, string | number>): string {
  const template: string = (lang === "en" ? en : uk)[key] ?? uk[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Returns `t(key, params)` bound to the current app language, plus the language. */
export function useT(): { t: Translate; lang: "uk" | "en" } {
  const { language } = useAppSettings();
  const t = useCallback<Translate>((key, params) => translate(language, key, params), [language]);
  return { t, lang: language };
}
