// Developer diagnostics screen — spec section 31 ("TELEMETRY / DEBUG") +
// the Demo Mode ON/OFF switch (section 26). UNBUILT/UNTESTED (see App.tsx).
// Reads the active engine's real NavigationState/telemetry through
// naviaController and @navia/core's DiagnosticsEngine — never invents a
// number for a field that has no real value yet (renders "—" instead, via
// DiagnosticsEngine.snapshot()'s honest nulls).
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Switch, Pressable } from "react-native";
import { DiagnosticsEngine, type DiagnosticsSnapshot } from "@navia/core";
import { navigationEngine, demoEngine, useNaviaStore } from "../engine/naviaController";
import { config } from "../config";

const diagnosticsEngine = new DiagnosticsEngine();

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}
function Section({ title }: { title: string }): JSX.Element {
  return <Text style={styles.section}>{title}</Text>;
}
const fmt = (v: unknown, suffix = ""): string => (v == null ? "—" : `${v}${suffix}`);

export function DiagnosticsScreen(): JSX.Element {
  const { isDemoMode, setDemoMode, state, route, refresh } = useNaviaStore();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);

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
          sensorsAvailable: { gnss: s.gnss !== "LOST", accelerometer: true, gyroscope: true, magnetometer: true },
          networkAvailable: s.networkAvailable,
          offlinePackageState: "not_downloaded",
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isDemoMode, refresh]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.demoToggleRow}>
        <Text style={styles.demoToggleLabel}>DEMO MODE</Text>
        <Switch value={isDemoMode} onValueChange={setDemoMode} />
      </View>
      <Text style={styles.demoToggleHint}>
        {isDemoMode
          ? "Демо: синтетичні GNSS/IMU-семпли через ті самі production engines. НЕ реальний GPS."
          : "Реальний режим: дані з реальних GPS/сенсорів пристрою."}
      </Text>

      {isDemoMode && (
        <View style={styles.demoControls}>
          <Section title="Demo controls" />
          <View style={styles.demoButtonRow}>
            <DemoButton label="GNSS degrade" onPress={() => demoEngine.simulateGnssDegradation()} />
            <DemoButton label="GNSS loss" onPress={() => demoEngine.simulateGnssLoss()} />
            <DemoButton label="Restore GNSS" onPress={() => demoEngine.restoreGnss()} />
          </View>
          <View style={styles.demoButtonRow}>
            <DemoButton label="GPS jump" onPress={() => demoEngine.simulateGpsJump()} />
            <DemoButton label="Wrong heading" onPress={() => demoEngine.simulateWrongHeading()} />
          </View>
          <View style={styles.demoButtonRow}>
            <DemoButton label="Off-route" onPress={() => demoEngine.simulateOffRoute()} />
            <DemoButton label="Clear off-route" onPress={() => demoEngine.clearOffRoute()} />
          </View>
        </View>
      )}

      {!snapshot ? (
        <Text style={styles.value}>Немає активної навігаційної сесії.</Text>
      ) : (
        <>
          <Section title="GPS" />
          <Row label="Accuracy" value={fmt(snapshot.gpsAccuracyM, " m")} />
          <Row label="Speed" value={fmt(snapshot.gpsSpeedMps, " m/s")} />
          <Row label="Heading" value={fmt(snapshot.gpsHeadingDeg, "°")} />

          <Section title="GNSS" />
          <Row label="State" value={snapshot.gnssState} />
          <Row label="Anomaly score" value={fmt(snapshot.anomalyScore)} />
          <Row label="Trusted fix age" value={fmt(snapshot.trustedPositionAgeMs, " ms")} />
          <Row label="Dead reckoning age" value={fmt(snapshot.deadReckoningAgeMs, " ms")} />

          <Section title="Position" />
          <Row label="Source" value={state.position?.source ?? "—"} />
          <Row label="Confidence" value={`${snapshot.confidence.toFixed(2)} (${snapshot.confidenceBand})`} />

          <Section title="Sensors" />
          <Row label="Accelerometer" value={snapshot.sensorsAvailable.accelerometer ? "available" : "unavailable"} />
          <Row label="Gyroscope" value={snapshot.sensorsAvailable.gyroscope ? "available" : "unavailable"} />
          <Row label="Fusion" value={state.position ? state.position.source : "—"} />

          <Section title="Map" />
          <Row label="Current road" value={fmt(snapshot.currentRoadName)} />
          <Row label="Map match score" value={fmt(snapshot.mapMatchScore)} />
          <Row label="Route deviation" value={state.offRoute ? "OFF ROUTE" : "on route"} />

          <Section title="Routing" />
          <Row label="Provider" value={route?.source ?? "—"} />
          <Row label="Route status" value={route ? "active" : "none"} />
          <Row label="Remaining" value={fmt(snapshot.routeDistanceRemainingM, " m")} />
          <Row label="Valhalla endpoint" value={config.valhallaUrl ?? "not configured"} />

          <Section title="Network" />
          <Row label="Status" value={snapshot.networkAvailable ? "online" : "offline"} />

          <Section title="App" />
          <Row label="Mode" value={isDemoMode ? "DEMO" : "REAL"} />
          <Row label="Navigation mode" value={state.mode} />
        </>
      )}
    </ScrollView>
  );
}

function DemoButton({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  return (
    <Pressable style={styles.demoButton} onPress={onPress}>
      <Text style={styles.demoButtonText}>{label}</Text>
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
