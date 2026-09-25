// Developer diagnostics screen — spec section 31 ("TELEMETRY / DEBUG") +
// the Demo Mode ON/OFF switch (section 26). UNBUILT/UNTESTED (see App.tsx).
// Reads the active engine's real NavigationState/telemetry through
// naviaController and @navia/core's DiagnosticsEngine — never invents a
// number for a field that has no real value yet (renders "—" instead, via
// DiagnosticsEngine.snapshot()'s honest nulls).
import { regionPackage } from "../offline/regionPackage";
import { isSimulatedOffline } from "../offline/network";
import type { OfflinePackageStatus } from "@navia/core";
import { compassAvailable, headingLatencySummary, resetHeadingLatency, runSyntheticSpin } from "../sensors/deviceHeading";
import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Switch, Pressable } from "react-native";
import { DiagnosticsEngine, type DiagnosticsSnapshot } from "@navia/core";
import { navigationEngine, demoEngine, useNaviaStore } from "../engine/naviaController";
import { AppText as Text } from "../components/AppText";
import { config } from "../config";
import { Accelerometer, Gyroscope, Magnetometer } from "expo-sensors";
import { useAppSettings } from "../settings/AppSettings";

const diagnosticsEngine = new DiagnosticsEngine();
type SensorAvailability = { accelerometer: boolean; gyroscope: boolean; magnetometer: boolean };

function Row({ label, value, p }: { label: string; value: string; p: ReturnType<typeof useAppSettings>["palette"] }): JSX.Element {
  return (
    <View style={[styles.row, { borderBottomColor: p.border }]}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: p.text }]}>{value}</Text>
    </View>
  );
}
function Section({ title, p }: { title: string; p: ReturnType<typeof useAppSettings>["palette"] }): JSX.Element {
  return <Text style={[styles.section, { color: p.accent }]}>{title}</Text>;
}
const fmt = (v: unknown, suffix = ""): string => (v == null ? "—" : `${v}${suffix}`);

const STATE_LABELS: Record<string, string> = {
  NORMAL: "Норма",
  DEGRADED: "Сигнал погіршено",
  LOST: "Сигнал втрачено",
  HIGH: "Висока",
  MEDIUM: "Середня",
  LOW: "Низька",
  UNKNOWN: "Невідомо",
  IDLE: "Очікування",
  ROUTING: "Побудова маршруту",
  ACTIVE: "Навігація активна",
  GNSS_DEGRADED: "Слабкий сигнал GNSS",
  GNSS_LOST: "GNSS втрачено",
  POSITION_UNCERTAIN: "Положення неточне",
  OFFLINE: "Офлайн",
  OFF_ROUTE: "Поза маршрутом",
  RECOVERING: "Відновлення",
  ARRIVED: "Прибули",
  GNSS: "GPS",
  DEAD_RECKONING: "Інерціальна навігація",
  MAP_MATCH: "Прив’язка до карти",
  FUSED: "Об’єднані дані",
  VALHALLA: "Valhalla",
  ONLINE: "Онлайн",
};

const STATE_LABELS_EN: Record<string, string> = {
  NORMAL: "Normal", DEGRADED: "Weak signal", LOST: "Lost", HIGH: "High", MEDIUM: "Medium", LOW: "Low", UNKNOWN: "Unknown",
  IDLE: "Idle", ROUTING: "Building route", ACTIVE: "Guidance active", GNSS_DEGRADED: "Weak GPS", GNSS_LOST: "GPS lost",
  POSITION_UNCERTAIN: "Position uncertain", OFFLINE: "Offline", OFF_ROUTE: "Off route", RECOVERING: "Recovering", ARRIVED: "Arrived",
  GNSS: "GPS", DEAD_RECKONING: "Dead reckoning", MAP_MATCH: "Map matching", FUSED: "Fused", VALHALLA: "Valhalla", ONLINE: "Online",
};

const localizeState = (value: string | null | undefined, en = false): string =>
  value == null ? "—" : (en ? STATE_LABELS_EN[value] : STATE_LABELS[value]) ?? value;

export function DiagnosticsScreen(): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  const { isDemoMode, setDemoMode, state, route, refresh } = useNaviaStore();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [sensorAvailability, setSensorAvailability] = useState<SensorAvailability>({ accelerometer: false, gyroscope: false, magnetometer: false });

  useEffect(() => {
    let active = true;
    void Promise.all([
      Accelerometer.isAvailableAsync().catch(() => false),
      Gyroscope.isAvailableAsync().catch(() => false),
      Magnetometer.isAvailableAsync().catch(() => false),
    ]).then(([accelerometer, gyroscope, magnetometer]) => {
      if (active) setSensorAvailability({ accelerometer, gyroscope, magnetometer });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => { void regionPackage.refresh(); }, []);

  useEffect(() => {
    const id = setInterval(() => {
      refresh();
      const engine = isDemoMode ? demoEngine : navigationEngine;
      const s = engine.getState();
      const r = engine.getRoute();
      setSnapshot(
        diagnosticsEngine.snapshot({
          gpsAccuracyM: s.trustedPosition?.position.accuracyM ?? null,
          gpsSpeedMps: s.speedMps,
          gpsHeadingDeg: s.headingDeg,
          gnssState: s.gnss,
          anomalyScore: null, // GNSSMonitor's per-sample anomaly score isn't retained on NavigationState; would need a dedicated field to surface honestly — left null rather than guessed
          trustedPositionAt: s.lastTrustedFixAt,
          deadReckoningActiveSince: s.position?.source === "DEAD_RECKONING" ? s.updatedAt : null,
          mapMatchScore: null, // no MapMatcher wired into NavigationEngine yet — honestly null, not faked
          currentRoadName: s.nextStep?.roadName ?? null,
          routeDistanceRemainingM: r ? s.routeRemainingM : null,
          confidence: s.confidence,
          confidenceBand: s.confidenceBand,
          sensorsAvailable: { gnss: s.gnss !== "LOST", ...sensorAvailability },
          networkAvailable: s.networkAvailable,
          // Real package status: "ready" only after the download was verified.
          offlinePackageState: regionPackage.getStatus().state,
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isDemoMode, refresh, sensorAvailability]);

  return (
    <ScrollView style={[styles.container, { backgroundColor: p.background }]}>
      <View style={styles.demoToggleRow}>
        <Text style={[styles.demoToggleLabel, { color: p.text }]}>{en ? "DEMO MODE" : "ДЕМО-РЕЖИМ"}</Text>
        <Switch value={isDemoMode} onValueChange={setDemoMode} />
      </View>
      <Text style={styles.demoToggleHint}>
        {isDemoMode
          ? (en ? "Demo: synthetic GPS and motion samples through the same navigation engine. Not real GPS." : "Демо: синтетичні GNSS/IMU-семпли через ті самі системи навігації. НЕ реальний GPS.")
          : (en ? "Live mode: position comes from the phone's GPS and sensors." : "Реальний режим: дані з GPS і сенсорів телефону.")}
      </Text>

      {isDemoMode && (
          <View style={[styles.demoControls, { backgroundColor: p.surfaceRaised }]}>
          <Section title={en ? "Demo controls" : "Керування деморежимом"} p={p} />
          <View style={styles.demoButtonRow}>
            <DemoButton label={en ? "Weaken GPS" : "Погіршити сигнал GNSS"} onPress={() => demoEngine.simulateGnssDegradation()} p={p} />
            <DemoButton label={en ? "Lose GPS" : "Зімітувати втрату GNSS"} onPress={() => demoEngine.simulateGnssLoss()} p={p} />
            <DemoButton label={en ? "Gradual GPS loss (jamming)" : "Поступова втрата GNSS (РЕБ)"} onPress={() => demoEngine.simulateGradualGnssLoss()} p={p} />
            <DemoButton label={en ? "Restore GPS" : "Відновити GNSS"} onPress={() => demoEngine.restoreGnss()} p={p} />
          </View>
          <View style={styles.demoButtonRow}>
            <DemoButton label={en ? "GPS jump" : "Зімітувати стрибок GPS"} onPress={() => demoEngine.simulateGpsJump()} p={p} />
            <DemoButton label={en ? "Wrong heading" : "Зімітувати хибний напрямок"} onPress={() => demoEngine.simulateWrongHeading()} p={p} />
          </View>
          <View style={styles.demoButtonRow}>
            <DemoButton label={en ? "Go off route" : "З’їзд із маршруту"} onPress={() => demoEngine.simulateOffRoute()} p={p} />
            <DemoButton label={en ? "Clear off-route" : "Скинути відхилення"} onPress={() => demoEngine.clearOffRoute()} p={p} />
          </View>
        </View>
      )}

      {__DEV__ && <HeadingLatencyTest p={p} en={en} />}

      {!snapshot ? (
        <Text style={[styles.value, { color: p.text }]}>{en ? "No active navigation session." : "Немає активної навігаційної сесії."}</Text>
      ) : (
        <>
          <Section title="GPS" p={p} />
          <Row label={en ? "GPS accuracy" : "Точність GPS"} value={fmt(snapshot.gpsAccuracyM, en ? " m" : " м")} p={p} />
          <Row label={en ? "Speed" : "Швидкість"} value={fmt(snapshot.gpsSpeedMps, en ? " m/s" : " м/с")} p={p} />
          <Row label={en ? "Heading" : "Напрямок"} value={fmt(snapshot.gpsHeadingDeg, "°")} p={p} />

          <Section title="GNSS" p={p} />
          <Row label={en ? "Status" : "Стан"} value={localizeState(snapshot.gnssState, en)} p={p} />
          <Row label={en ? "Anomaly score" : "Оцінка аномалії"} value={fmt(snapshot.anomalyScore)} p={p} />
          <Row label={en ? "Age of last trusted fix" : "Вік надійного GPS-заміру"} value={fmt(snapshot.trustedPositionAgeMs, en ? " ms" : " мс")} p={p} />
          <Row label={en ? "Dead-reckoning time" : "Час інерційного визначення"} value={fmt(snapshot.deadReckoningAgeMs, en ? " ms" : " мс")} p={p} />

          <Section title={en ? "Position" : "Позиція"} p={p} />
          <Row label={en ? "Source" : "Джерело"} value={localizeState(state.position?.source, en)} p={p} />
          <Row label={en ? "Confidence" : "Надійність"} value={`${snapshot.confidence.toFixed(2)} (${localizeState(snapshot.confidenceBand, en)})`} p={p} />

          <Section title={en ? "Sensors" : "Датчики"} p={p} />
          <Row label={en ? "Accelerometer" : "Акселерометр"} value={snapshot.sensorsAvailable.accelerometer ? (en ? "available" : "доступний") : (en ? "unavailable" : "недоступний")} p={p} />
          <Row label={en ? "Gyroscope" : "Гіроскоп"} value={snapshot.sensorsAvailable.gyroscope ? (en ? "available" : "доступний") : (en ? "unavailable" : "недоступний")} p={p} />
          <Row label={en ? "Magnetometer" : "Магнітометр"} value={snapshot.sensorsAvailable.magnetometer ? (en ? "available" : "доступний") : (en ? "unavailable" : "недоступний")} p={p} />
          <Row label={en ? "Sensor fusion" : "Об’єднання даних"} value={localizeState(state.position?.source, en)} p={p} />

          <Section title={en ? "Offline package" : "Офлайн-пакет"} p={p} />
          <Row label={en ? "Kyiv + oblast" : "Київ + область"} value={offlineLabel(regionPackage.getStatus(), en)} p={p} />
          <Row label={en ? "Network test mode" : "Тест без інтернету"} value={isSimulatedOffline() ? (en ? "ON (no network)" : "УВІМК. (без мережі)") : (en ? "off" : "вимк.")} p={p} />

          <Section title={en ? "Map" : "Карта"} p={p} />
          <Row label={en ? "Current road" : "Поточна дорога"} value={fmt(snapshot.currentRoadName)} p={p} />
          <Row label={en ? "Map matching" : "Прив’язка до карти"} value={fmt(snapshot.mapMatchScore)} p={p} />
          <Row label={en ? "Route deviation" : "Відхилення від маршруту"} value={state.offRoute ? (en ? "off route" : "поза маршрутом") : (en ? "on route" : "на маршруті")} p={p} />

          <Section title={en ? "Routing" : "Маршрутизація"} p={p} />
          <Row label={en ? "Route source" : "Джерело маршруту"} value={localizeState(route?.source, en)} p={p} />
          <Row label={en ? "Route status" : "Стан маршруту"} value={route ? (en ? "active" : "активний") : (en ? "none" : "відсутній")} p={p} />
          <Row label={en ? "Distance remaining" : "Залишок маршруту"} value={fmt(snapshot.routeDistanceRemainingM, en ? " m" : " м")} p={p} />
          <Row label={en ? "Valhalla server" : "Сервер Valhalla"} value={config.valhallaUrl ?? (en ? "not configured" : "не налаштовано")} p={p} />

          <Section title={en ? "Network" : "Мережа"} p={p} />
          <Row label={en ? "Status" : "Стан"} value={snapshot.networkAvailable ? (en ? "connected" : "є з’єднання") : (en ? "offline" : "немає з’єднання")} p={p} />

          <Section title={en ? "App" : "Застосунок"} p={p} />
          <Row label={en ? "Mode" : "Режим"} value={isDemoMode ? (en ? "Demo" : "Демо") : (en ? "Live" : "Реальний")} p={p} />
          <Row label={en ? "Navigation mode" : "Режим навігації"} value={localizeState(state.mode, en)} p={p} />
        </>
      )}
    </ScrollView>
  );
}

function DemoButton({ label, onPress, p }: { label: string; onPress: () => void; p: ReturnType<typeof useAppSettings>["palette"] }): JSX.Element {
  return (
    <Pressable style={[styles.demoButton, { backgroundColor: p.surface, borderColor: p.border }]} onPress={onPress}>
      <Text style={[styles.demoButtonText, { color: p.accent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#1a2233" },
  label: { color: "#8892a6", fontSize: 13 },
  value: { color: "#fff", fontSize: 13, fontFamily: "monospace" },
  section: { color: "#2dd4bf", fontSize: 12, fontWeight: "700", marginTop: 16, marginBottom: 4, textTransform: "uppercase" },
  demoToggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12 },
  demoToggleLabel: { color: "#fff", fontSize: 15, fontWeight: "700" },
  demoToggleHint: { color: "#8892a6", fontSize: 12, marginBottom: 8 },
  demoControls: { backgroundColor: "#1a1233", borderRadius: 10, padding: 12, marginBottom: 8 },
  demoButtonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  demoButton: { backgroundColor: "#2a1f55", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  demoButtonText: { color: "#c4b5fd", fontSize: 12, fontWeight: "600" },
});

/** Dev: compass availability and the measured compass → marker latency
 * (synthetic 30 Hz rotation through the same code path as the real compass). */
function HeadingLatencyTest({ p, en }: { p: ReturnType<typeof useAppSettings>["palette"]; en: boolean }): JSX.Element {
  const [result, setResult] = useState<string>("");
  const run = async () => {
    resetHeadingLatency();
    setResult(en ? "Running…" : "Вимірюю…");
    await runSyntheticSpin(3000, 30);
    await new Promise<void>((r) => { setTimeout(() => r(), 200); });
    const s = headingLatencySummary();
    setResult(s.n === 0
      ? (en ? "No marker on screen to measure (open the map)." : "На мапі немає позначки для виміру (відкрийте мапу).")
      : `n=${s.n} · p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms`);
  };
  const avail = compassAvailable();
  return (
    <View style={[styles.demoControls, { backgroundColor: p.surfaceRaised }]}>
      <Section title={en ? "Compass → marker latency" : "Компас → позначка: затримка"} p={p} />
      <Row label={en ? "Compass" : "Компас"} value={avail == null ? "—" : avail ? (en ? "available" : "доступний") : (en ? "not available (simulator?)" : "недоступний (симулятор?)")} p={p} />
      <DemoButton label={en ? "Measure (synthetic 30 Hz spin)" : "Виміряти (синтетичне обертання 30 Гц)"} onPress={() => void run()} p={p} />
      {result ? <Text style={[styles.value, { color: p.text }]}>{result}</Text> : null}
    </View>
  );
}

function offlineLabel(st: OfflinePackageStatus, en: boolean): string {
  switch (st.state) {
    case "ready": return st.label;
    case "downloading": return `${en ? "downloading" : "завантаження"} ${Math.round(st.progress0to1 * 100)}%`;
    case "unavailable": return `${en ? "not ready" : "не готовий"}: ${st.reason}`;
    default: return en ? "not downloaded" : "не завантажено";
  }
}
