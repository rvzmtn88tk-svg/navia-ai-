// Round status indicator (GPS, air alert) in the colour of the situation:
// green = fine, yellow = attention, red = trouble (pulsing).
import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { Icon, type IconName } from "./Icon";
import { Touchable, useColors } from "./ui";
import { elevation, iconSize } from "../theme/tokens";

export type BeaconTone = "success" | "warning" | "critical" | "neutral";

export function StatusBeacon({ icon, tone, label, onPress, size = 40 }: { icon: IconName; tone: BeaconTone; label: string; onPress?: () => void; size?: number }): JSX.Element {
  const c = useColors();
  const lit = tone === "critical" || tone === "warning";
  const fg = tone === "success" ? c.success : tone === "warning" ? c.warning : tone === "critical" ? c.critical : c.textMuted;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!lit) { pulse.stopAnimation(); pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: tone === "critical" ? 650 : 1100, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: tone === "critical" ? 650 : 1100, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [lit, pulse, tone]);
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={[styles.beacon, { width: size, height: size, borderRadius: size / 2, backgroundColor: c.surfaceElevated, borderColor: fg }, elevation(2, c)]}>
      {lit && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor: fg, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.42] }) }]} />}
      <Icon name={icon} size={iconSize.md} color={fg} />
    </Touchable>
  );
}

const styles = StyleSheet.create({
  beacon: { borderWidth: 1.5, alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
