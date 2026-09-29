// Is an answer grounded in the snapshot? Every distance, time, accuracy or
// percent it states must be one the snapshot has (formatted as the navigator
// formats it); it must not contradict the state (GPS, alert, route,
// internet); and NAVIA must not speak of itself in the feminine or
// masculine. Used for answers proposed by the server's language model before
// they reach the driver, and by the simulator's judge. Pure.
import { formatDistance, formatDuration } from "../../i18n/format";
import { walkMinutes } from "../copilotBrain";
import type { Snapshot } from "./snapshot";

export function allowedFacts(s: Snapshot): Set<string> {
  const out = new Set<string>();
  const add = (v: string) => out.add(v.replace(/\s/g, " "));
  const dist = (m: number | null | undefined) => { if (m != null && Number.isFinite(m)) add(formatDistance(m, s.lang)); };
  dist(s.route?.remainingM); dist(s.route?.next?.distanceM);
  for (const list of Object.values(s.places)) for (const p of list ?? []) { dist(p.distanceM); add(`${Math.round(p.distanceM)} м`); add(`${walkMinutes(p.distanceM)} хв`); }
  const plain = (v: number | null | undefined, unit: string) => { if (v != null && Number.isFinite(v)) { add(`±${Math.max(1, Math.round(v))} ${unit}`); add(`${Math.max(1, Math.round(v))} ${unit}`); } };
  plain(s.gnss.accuracyM, "м"); plain(s.position.uncertaintyM, "м"); plain(s.fields.drErrorGrowthMPerMin, "м");
  if (s.gnss.sinceFixS != null) { add(`${Math.max(1, Math.round(s.gnss.sinceFixS))} с`); add(`${Math.max(1, Math.round(s.gnss.sinceFixS / 60))} хв`); }
  if (s.route?.etaS != null) { add(formatDuration(s.route.etaS, s.lang)); for (const tok of formatDuration(s.route.etaS, s.lang).split(/(?<=хв|год|с)\s/)) add(tok); }
  if (s.motion.speedKmh != null) add(`${s.motion.speedKmh} км/год`);
  add(`${Math.round(s.fields.positionConfidence * 100)} %`);
  return out;
}

const NUM = /±?\d+(?:,\d+)?\s(?:км|м|с|хв|год|%)(?![а-яіїє])/g;
/** Unicode-aware (JS \b does not work with Cyrillic). */
export const GENDERED = /(?<![\p{L}])(я|NAVIA)\s+(\S+\s)?(\p{L}*(ла|лася|лась|ів|ив|ав|ув|ів|ився|ався|увся)|готова|впевнена|рада|готовий|впевнений|радий)(?![\p{L}])/iu;

export function checkGrounded(text: string, s: Snapshot): { ok: boolean; reason: string } {
  if (!text.trim()) return { ok: false, reason: "порожня відповідь" };
  if (s.gnss.mode === "navigator" && /gps у нормі|позиція достовірна/i.test(text)) return { ok: false, reason: "каже «GPS у нормі», а сигнал втрачено" };
  if (s.gnss.mode === "normal" && /сигнал gps втрачено|gps немає/i.test(text)) return { ok: false, reason: "каже «GPS втрачено», а він у нормі" };
  if (s.alert?.active !== true && /тривога у вашому районі|повітряна тривога у вашому/i.test(text)) return { ok: false, reason: "каже про тривогу, якої немає" };
  if (!s.route && /до «/.test(text)) return { ok: false, reason: "говорить про маршрут, якого немає" };
  if (s.online && /інтернету немає/i.test(text)) return { ok: false, reason: "каже «інтернету немає», а він є" };
  if (GENDERED.test(text) && !/була тривога/.test(text)) return { ok: false, reason: "NAVIA про себе в жіночому/чоловічому роді" };
  const ok = allowedFacts(s);
  for (const m of text.matchAll(NUM)) {
    const token = m[0].replace(/\s/g, " ");
    if (!ok.has(token) && !ok.has(token.replace(/^±/, ""))) return { ok: false, reason: `число «${token}» не з даних` };
  }
  return { ok: true, reason: "" };
}
