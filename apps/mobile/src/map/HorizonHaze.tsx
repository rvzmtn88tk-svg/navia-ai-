// Sky and haze towards the horizon for the tilted (3D) map. MapLibre Native
// 6.x has no sky/atmosphere layer, so the depth cue is drawn over the map:
// a gradient in the top part of the view only (far away in a tilted view),
// fading to fully transparent well above the position arrow, which in 3D
// sits in the lower part of the screen. Never takes touches.
import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/** Share of the map height the haze covers (the arrow is below ~60 %). */
export const HAZE_SHARE = 0.34;

export function HorizonHaze({ visible, dark, satellite }: { visible: boolean; dark: boolean; satellite: boolean }): JSX.Element {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 320, useNativeDriver: true }).start();
  }, [visible, opacity]);
  // Day: pale blue sky into light haze; night: deep navy into the map.
  const sky = dark ? "#060D1C" : satellite ? "#B9CCE0" : "#DCE6F0";
  const haze = dark ? "#0B1830" : satellite ? "#DDE7F0" : "#EEF3F8";
  return (
    <Animated.View pointerEvents="none" style={[styles.haze, { opacity }]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="navia-haze" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={sky} stopOpacity={0.92} />
            <Stop offset="0.35" stopColor={haze} stopOpacity={0.55} />
            <Stop offset="1" stopColor={haze} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#navia-haze)" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  haze: { position: "absolute", left: 0, right: 0, top: 0, height: `${HAZE_SHARE * 100}%` },
});
