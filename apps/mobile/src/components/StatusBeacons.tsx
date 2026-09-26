// The two map indicators (GPS, air alert) in the colour of the situation —
// the same component and the same colour rules on the home map and during
// turn-by-turn navigation. Tapping one opens its details.
import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { StatusBeacon } from "./StatusBeacon";
import { alertBeaconTone, alertHeadline } from "./AlertStatus";
import { gpsTone, type GnssHealth, type GpsStatus } from "../engine/liveStatus";
import type { GeolocatedAirAlert } from "../providers/GeolocatedAirAlertProvider";
import { useT } from "../i18n";
import { space } from "../theme/tokens";

export function StatusBeacons({ gpsStatus, health, alert, onPressGps, onPressAlert, size, style }: {
  gpsStatus: GpsStatus; health: GnssHealth; alert: GeolocatedAirAlert | null;
  onPressGps: () => void; onPressAlert: () => void; size?: number; style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const { t } = useT();
  const gps = gpsTone(gpsStatus, health);
  const al = alertHeadline(alert, false);
  return (
    <View style={[styles.row, style]} pointerEvents="box-none">
      <StatusBeacon icon="satellite" size={size} tone={gps.tone} label={t(gps.key)} onPress={onPressGps} />
      <StatusBeacon icon="alert" size={size} tone={alertBeaconTone(alert, false)} label={t(al.key)} onPress={onPressAlert} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.xs },
});
