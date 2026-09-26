// Compact live panel behind a map beacon: GPS (accuracy, position source,
// GNSS state, age of the last trusted fix) or the air alert (status, time
// declared, data source). Reads the shared store directly, so it follows the
// engine while open and never takes the driver out of navigation.
import React, { useEffect, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useNaviaStore } from "../engine/naviaController";
import { alertPhase, gpsDetails, gpsTone, healthFrom, type GpsStatus } from "../engine/liveStatus";
import { alertBeaconTone, alertHeadline, toneColor } from "./AlertStatus";
import { Icon } from "./Icon";
import { IconButton, Text, useColors } from "./ui";
import { formatClock, useT, type Translate } from "../i18n";
import { elevation, iconSize, radius, space } from "../theme/tokens";

export type StatusKind = "gps" | "alert";

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function ago(seconds: number, t: Translate): string {
  return seconds < 120 ? t("status.secondsAgo", { seconds }) : t("status.minutesAgo", { minutes: Math.round(seconds / 60) });
}

function Row({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <View style={styles.row}>
      <Text variant="caption" color="secondary" style={styles.label}>{label}</Text>
      <Text variant="subhead" style={styles.value} color={color ? { custom: color } : "primary"} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export function StatusDetails({ kind, gpsStatus, onClose, style }: { kind: StatusKind; gpsStatus: GpsStatus; onClose: () => void; style?: StyleProp<ViewStyle> }): JSX.Element {
  const c = useColors();
  const { t, lang } = useT();
  const state = useNaviaStore((s) => s.state);
  const alert = useNaviaStore((s) => s.alert);
  const endedAt = useNaviaStore((s) => s.alertEndedAt);
  const isDemo = useNaviaStore((s) => s.isDemoMode);
  const now = useNow(1000);

  let headline: string;
  let tone: ReturnType<typeof gpsTone>["tone"];
  let rows: JSX.Element[];
  if (kind === "gps") {
    const g = gpsTone(gpsStatus, healthFrom(state.gnss));
    const d = gpsDetails(state);
    headline = t(g.key);
    tone = g.tone;
    const gnssColor = toneColor(c, d.gnss === "NORMAL" ? "success" : d.gnss === "DEGRADED" ? "warning" : "critical");
    rows = [
      <Row key="gnss" label={t("status.gnss")} value={t(`status.gnss.${d.gnss}`)} color={gnssColor} />,
      d.uncertaintyM != null
        ? <Row key="acc" label={t("status.uncertainty")} value={t("status.meters", { meters: Math.round(d.uncertaintyM) })} />
        : <Row key="acc" label={t("status.accuracy")} value={d.accuracyM != null ? t("status.meters", { meters: Math.round(d.accuracyM) }) : "—"} />,
      <Row key="src" label={t("status.source")} value={t(`status.source.${d.source}`)} color={d.source === "GNSS" || d.source === "FUSED" ? undefined : c.warning} />,
      <Row key="fix" label={t("status.lastFix")} value={d.lastTrustedFixAgeS != null ? ago(d.lastTrustedFixAgeS, t) : t("status.never")} />,
    ];
  } else {
    const head = alertHeadline(alert, false);
    const phase = alertPhase(alert, endedAt, now);
    headline = t(head.key);
    tone = alertBeaconTone(alert, false);
    const status = phase === "ended" && endedAt != null ? t("status.alert.ended", { time: formatClock(endedAt, lang) }) : t(`status.alert.${phase}`);
    const checkedAgo = alert?.updatedAt != null ? Math.max(0, Math.round((now - alert.updatedAt) / 1000)) : null;
    rows = [
      <Row key="st" label={t("status.alert")} value={status} color={toneColor(c, phase === "active" ? tone : phase === "none" || phase === "ended" ? "success" : "neutral")} />,
      ...(alert?.locationLabel ? [<Row key="where" label={t("status.alert.where")} value={alert.locationLabel} />] : []),
      ...(phase === "active" ? [<Row key="since" label={t("status.alert.since")} value={alert?.since ? formatClock(alert.since, lang) : "—"} />] : []),
      <Row key="src" label={t("status.alert.source")} value={alert?.source ?? "—"} />,
      <Row key="chk" label={t("status.alert.checked")} value={alert?.updatedAt != null && checkedAgo != null ? `${formatClock(alert.updatedAt, lang)} · ${ago(checkedAgo, t)}` : "—"} />,
    ];
  }
  const fg = toneColor(c, tone);

  return (
    <View accessibilityLiveRegion="polite" testID={`status-details-${kind}`}
      style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: fg }, elevation(3, c), style]}>
      <View style={styles.head}>
        <Icon name={kind === "gps" ? "satellite" : "alert"} size={iconSize.md} color={fg} />
        <Text variant="bodyStrong" style={styles.flex} color={{ custom: fg }} numberOfLines={2}>{headline}</Text>
        <IconButton icon="close" tone="plain" size={36} label={t("status.close")} onPress={onClose} />
      </View>
      {rows}
      {kind === "gps" && isDemo && <Text variant="caption" color="muted">{t("status.demo")}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: radius.lg, paddingHorizontal: space.md, paddingBottom: space.sm, paddingTop: space.xs, gap: 6, width: "100%" },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  label: { width: 104 },
  value: { flex: 1 },
});
