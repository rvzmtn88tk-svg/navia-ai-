// Settings card for the "Київ + область" offline package: real download
// progress (MapLibre resources and bytes, then places), real size, and the
// honest status: "ready" only after the package was verified.
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { regionPackage, REGION_LABEL, type RegionProgress } from "../offline/regionPackage";
import { isSimulatedOffline, setSimulatedOffline } from "../offline/network";
import { CATEGORY_META } from "../places/categories";
import { useT } from "../i18n";
import { Button, Card, Divider, ListRow, Text, useColors } from "./ui";
import { radius, space } from "../theme/tokens";

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(bytes > 100 * 1_048_576 ? 0 : 1)} МБ`;
}

export function OfflinePackageCard(): JSX.Element {
  const c = useColors();
  const { t } = useT();
  const [status, setStatus] = useState(regionPackage.getStatus());
  const [details, setDetails] = useState<Awaited<ReturnType<typeof regionPackage.details>>>(null);
  const [progress, setProgress] = useState<RegionProgress | null>(null);
  const [offlineTest, setOfflineTest] = useState(isSimulatedOffline());

  const reload = useCallback(async () => {
    setStatus(await regionPackage.refresh());
    setDetails(await regionPackage.details());
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const start = async () => {
    setProgress({ phase: "map", progress: 0, mapBytes: 0, resourcesDone: 0, resourcesTotal: 0, placesDone: 0, placesTotal: 1 });
    const final = await regionPackage.downloadWithDetails(setProgress);
    setStatus(final);
    setDetails(await regionPackage.details());
  };

  const busy = progress != null && progress.phase !== "done" && progress.phase !== "error";
  const ready = status.state === "ready";
  const pct = Math.round((progress?.progress ?? 0) * 100);

  return (
    <Card style={styles.card}>
      <Text variant="headline">{t("offline.title", { region: REGION_LABEL })}</Text>
      <Text variant="callout" color={ready ? "success" : status.state === "unavailable" ? "warning" : "secondary"}>
        {ready ? t("offline.ready") : status.state === "unavailable" ? status.reason : t("offline.notDownloaded")}
      </Text>
      {ready && details && (
        <Text variant="caption" color="secondary">
          {t("offline.readyDetails", {
            date: details.downloadedAt, total: mb(details.mapBytes + details.placesBytes), map: mb(details.mapBytes),
            places: Object.values(details.placesCounts).reduce((a, b) => a + b, 0),
          })}
          {details.failed.length ? `\n${t("offline.partialPlaces", { list: details.failed.join(", ") })}` : ""}
        </Text>
      )}
      {busy && progress && (
        <View style={styles.progressBox}>
          <View style={[styles.track, { backgroundColor: c.surfaceMuted }]}>
            <View style={[styles.fill, { width: `${pct}%`, backgroundColor: c.accent }]} />
          </View>
          <Text variant="caption" color="secondary">
            {progress.phase === "map"
              ? t("offline.progressMap", { pct, mb: mb(progress.mapBytes), done: progress.resourcesDone, total: progress.resourcesTotal || "…" })
              : progress.phase === "places"
                ? `${t("offline.progressPlaces", { pct, done: progress.placesDone, total: progress.placesTotal })}${progress.placesCategory && progress.placesCategory in CATEGORY_META ? ` · ${t(CATEGORY_META[progress.placesCategory as keyof typeof CATEGORY_META].label)}` : ""}${progress.placesFailed ? ` · ${t("offline.sourcesFailed", { count: progress.placesFailed })}` : ""}`
                : t("offline.progressVerify")}
          </Text>
        </View>
      )}
      {progress?.phase === "error" && <Text variant="caption" color="critical">{progress.message}</Text>}
      {!busy && (
        <Button label={ready ? t("offline.update") : t("offline.download", { region: REGION_LABEL })} icon="route" variant={ready ? "secondary" : "primary"} onPress={() => void start()} />
      )}
      {ready && !busy && <Text variant="bodyStrong" color="critical" onPress={() => void regionPackage.remove().then(reload)}>{t("offline.delete")}</Text>}
      <Divider />
      <ListRow icon="globe" title={t("offline.testMode")} subtitle={t("offline.testModeHint")}
        trailing={<Switch value={offlineTest} onValueChange={(v) => { setSimulatedOffline(v); setOfflineTest(v); }} trackColor={{ false: c.border, true: c.warning }} accessibilityLabel={t("offline.testMode")} />} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  progressBox: { gap: space.xxs },
  track: { height: 8, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: 8, borderRadius: radius.pill },
});
