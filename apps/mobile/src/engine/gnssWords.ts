// Words for the GNSS early-warning reasons (see packages/core/src/gnss-trend.ts).
import type { NavigationState } from "@navia/core";
import type { StringKey, Translate } from "../i18n";

export function gnssTrendReasons(trend: NavigationState["gnssTrend"], t: Translate): string {
  if (!trend || trend.level === "stable") return "";
  return trend.reasons
    .map((r) => t(`gps.reason.${r}` as StringKey, { meters: Math.round(trend.accuracyM ?? 0) }))
    .join(" · ");
}
