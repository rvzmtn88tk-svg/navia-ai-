// NAVIA co-pilot symbol: the NAVIA logo at the centre with a satellite on a
// tilted orbit. The satellite circles slowly at rest and speeds up while the
// co-pilot is thinking or speaking.
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Ellipse, Path, Rect } from "react-native-svg";
import { BrandMark } from "./BrandMark";
import { useColors } from "./ui";

export function NaviaAiMark({ size = 44, active = false }: { size?: number; active?: boolean }): JSX.Element {
  const c = useColors();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    spin.stopAnimation((value) => {
      spin.setValue(value % 1);
      const remaining = 1 - (value % 1);
      const period = active ? 1600 : 9000;
      Animated.sequence([
        Animated.timing(spin, { toValue: 1, duration: remaining * period, easing: Easing.linear, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (!finished) return;
        spin.setValue(0);
        Animated.loop(Animated.timing(spin, { toValue: 1, duration: period, easing: Easing.linear, useNativeDriver: true })).start();
      });
    });
    return () => spin.stopAnimation();
  }, [active, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const orbitW = size;
  const orbitH = size * 0.42;
  const sat = Math.max(8, size * 0.18);

  return (
    <View accessible accessibilityLabel="NAVIA" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {/* Orbit, tilted */}
      <View style={[StyleSheet.absoluteFill, styles.center, { transform: [{ rotate: "-28deg" }] }]} pointerEvents="none">
        <Svg width={orbitW} height={orbitH}>
          <Ellipse cx={orbitW / 2} cy={orbitH / 2} rx={orbitW / 2 - 1} ry={orbitH / 2 - 1} stroke={c.brandTeal} strokeOpacity={0.7} strokeWidth={1.2} fill="none" />
        </Svg>
      </View>
      {/* The compass dominates the symbol (≈ 76 % of its width); the orbit is a
          thin ring around it, not an empty frame around a small dot. */}
      <BrandMark size={size * 0.8} />
      {/* Satellite travelling on the (squashed, tilted) orbit */}
      <View style={[StyleSheet.absoluteFill, styles.center, { transform: [{ rotate: "-28deg" }, { scaleY: orbitH / orbitW }] }]} pointerEvents="none">
        <Animated.View style={{ width: orbitW, height: orbitW, transform: [{ rotate }] }}>
          <View style={{ position: "absolute", top: -sat / 2, left: orbitW / 2 - sat / 2, transform: [{ scaleY: orbitW / orbitH }] }}>
            <Svg width={sat} height={sat} viewBox="0 0 20 20">
              <Rect x="1" y="7" width="5" height="6" rx="1" fill={c.brandTeal} />
              <Rect x="14" y="7" width="5" height="6" rx="1" fill={c.brandTeal} />
              <Path d="M10 5.5 14 10 10 14.5 6 10Z" fill={c.brandOrange} />
            </Svg>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
});
