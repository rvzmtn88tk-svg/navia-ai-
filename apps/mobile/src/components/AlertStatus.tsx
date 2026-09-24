// Air-alert status block: scope (your district / city / whole oblast), the
// source's threat level and reasons, time and source, plus the regional
// summary. Informational only — never a safety claim.
import React from "react";
import { StyleSheet, View } from "react-native";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import type { AirThreatSummary } from "../providers/AirThreatSummaryProvider";
import { formatClock, useT, type StringKey, type Translate } from "../i18n";
import { Card, Text, useColors } from "./ui";
import { Crossfade } from "./Crossfade";
import { Icon } from "./Icon";
import { iconSize, radius, space, type ThemeColors } from "../theme/tokens";

export type AlertTone = "success" | "warning" | "critical" | "neutral";

export function alertHeadline(alert: GeolocatedAirAlert | null, loading: boolean): { key: StringKey; tone: AlertTone } {
  if (!alert) return { key: loading ? "alert.checking" : "alert.waiting", tone: "neutral" };
  if (alert.active === true) {
    const key: StringKey = alert.scope === "region" ? "alert.activeIn.region" : alert.scope === "city" ? "alert.activeIn.city" : "alert.activeIn.district";
    return { key, tone: alert.level === "yellow" ? "warning" : "critical" };
  }
  if (alert.active === false) return { key: "alert.clear", tone: "success" };
  return { key: "alert.unknown", tone: "neutral" };
}

/** Map beacon: red when the alert covers you, yellow when it is elsewhere in the oblast, green when quiet. */
export function alertBeaconTone(alert: GeolocatedAirAlert | null, loading: boolean): AlertTone {
  const head = alertHeadline(alert, loading);
  return head.tone === "success" && alert?.otherDistrictsActive ? "warning" : head.tone;
}

export function toneColor(c: ThemeColors, tone: AlertTone): string {
  return tone === "success" ? c.success : tone === "warning" ? c.warning : tone === "critical" ? c.critical : c.textSecondary;
}

function levelLabel(level: string | undefined, t: Translate): string | null {
  if (!level) return null;
  if (level === "yellow") return t("alert.level.yellow");
  if (level === "red") return t("alert.level.red");
  return t("alert.level.other", { level });
}

const KIND_KEYS = new Set(["uav", "fpv", "recon", "kab", "cruise_missile", "ballistic_missile", "missile", "aircraft"]);

export function AlertStatus({ alert, threat, loading }: { alert: GeolocatedAirAlert | null; threat: AirThreatSummary | null; loading: boolean }): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const head = alertHeadline(alert, loading);
  const fg = toneColor(c, head.tone);
  const level = alert?.active ? levelLabel(alert.level, t) : null;
  const sameRegion = threat && alert && threat.region === alert.region;
  const kinds = sameRegion ? threat.threatKinds.map((k) => t((KIND_KEYS.has(k) ? `alert.kind.${k}` : "alert.kind.other") as StringKey)).join(", ") : "";
  const summary = !sameRegion ? null : threat.state === "reported" ? t("alert.region.reported", { kinds }) : threat.state === "advisory" ? t("alert.region.advisory", { kinds }) : threat.state === "none" ? t("alert.region.none") : null;
  const meta = [alert?.locationLabel, alert?.active && alert.since ? t("alert.since", { time: formatClock(alert.since, lang) }) : null, alert?.updatedAt ? t("alert.checked", { time: formatClock(alert.updatedAt, lang) }) : null].filter(Boolean).join(" · ");

  return (
    <Card style={[styles.card, alert?.active === true && { borderColor: fg, backgroundColor: head.tone === "warning" ? c.warningSoft : c.criticalSoft }]}>
      <View style={styles.head}>
        <Icon name="alert" size={iconSize.lg} color={fg} />
        <View style={styles.flex}>
          <Crossfade contentKey={head.key}><Text variant="headline" style={{ color: fg }}>{t(head.key)}</Text></Crossfade>
          {meta ? <Text variant="subhead" color="secondary" numberOfLines={2}>{meta}</Text> : null}
        </View>
        {level && <View style={[styles.level, { backgroundColor: fg }]}><Text variant="caption" color={{ custom: c.onCritical }}>{level}</Text></View>}
      </View>
      {alert?.active && alert.reasons?.map((r) => (
        <View key={r} style={styles.reason}><View style={[styles.dot, { backgroundColor: fg }]} /><Text variant="callout">{r}</Text></View>
      ))}
      {!alert?.active && alert?.otherDistrictsActive ? <Text variant="callout" color="warning">{t("alert.otherDistricts", { count: alert.otherDistrictsActive })}</Text> : null}
      {summary && <Text variant="callout" color="secondary">{summary}</Text>}
      {alert?.active && <Text variant="caption" color="muted">{t("alert.official")}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1, minWidth: 0 },
  level: { borderRadius: radius.pill, paddingHorizontal: space.xs, paddingVertical: space.xxs / 2 },
  reason: { flexDirection: "row", alignItems: "center", gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
