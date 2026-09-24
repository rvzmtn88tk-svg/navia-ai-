import React from "react";
import { StyleSheet, View } from "react-native";
import { BrandMark } from "./BrandMark";

/** NAVIA's compass core with a small orbital satellite; used only for the AI navigator. */
export function NaviaAiMark({ size = 44 }: { size?: number }): JSX.Element {
  const core = size * 0.76;
  return (
    <View accessible accessibilityLabel="NAVIA AI Navigator" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View pointerEvents="none" style={[styles.orbit, { width: size * 0.96, height: size * 0.48, borderRadius: size, transform: [{ rotate: "-38deg" }] }]} />
      <BrandMark size={core} />
      <View style={[styles.satellite, { right: size * 0.03, top: size * 0.11 }]}>
        <View style={styles.panel} />
        <View style={styles.satelliteCore} />
        <View style={styles.panel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  orbit: { position: "absolute", borderWidth: 1.4, borderColor: "#62e2d3", opacity: 0.88 },
  satellite: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 1 },
  satelliteCore: { width: 5, height: 5, borderRadius: 1, backgroundColor: "#f4c76b", transform: [{ rotate: "45deg" }] },
  panel: { width: 3, height: 6, borderRadius: 1, backgroundColor: "#62e2d3" },
});
