// The NAVIA emblem from the app icon, drawn live: a glowing ring with four
// ticks (teal → orange) and the split arrow (teal left half, orange right
// half). `progress` 0→1 draws it: the ring traces itself, ticks appear, the
// arrow rises; `glow` 0→1 breathes the halo.
import React from "react";
import { Animated } from "react-native";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

type Props = { size: number; progress?: Animated.Value | Animated.AnimatedInterpolation<number>; glow?: Animated.Value | Animated.AnimatedInterpolation<number> };

const TEAL = "#3FE0DA";
const ORANGE = "#FF9A3D";

export function NaviaEmblem({ size, progress, glow }: Props): JSX.Element {
  const p = progress ?? new Animated.Value(1);
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const ringOffset = p.interpolate({ inputRange: [0, 0.55], outputRange: [circumference, 0], extrapolate: "clamp" });
  const ticks = p.interpolate({ inputRange: [0.45, 0.65], outputRange: [0, 1], extrapolate: "clamp" });
  const arrow = p.interpolate({ inputRange: [0.5, 0.85], outputRange: [0, 1], extrapolate: "clamp" });
  const halo = glow ? glow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] }) : p.interpolate({ inputRange: [0.6, 1], outputRange: [0, 0.45], extrapolate: "clamp" });

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="ringGrad" x1="15" y1="15" x2="85" y2="85" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={TEAL} />
          <Stop offset="0.55" stopColor={TEAL} />
          <Stop offset="1" stopColor={ORANGE} />
        </LinearGradient>
        <LinearGradient id="leftHalf" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#8AF4EE" />
          <Stop offset="1" stopColor="#12B3AD" />
        </LinearGradient>
        <LinearGradient id="rightHalf" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FFC98A" />
          <Stop offset="1" stopColor="#F0761F" />
        </LinearGradient>
        <RadialGradient id="halo" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={TEAL} stopOpacity="0.55" />
          <Stop offset="0.55" stopColor={TEAL} stopOpacity="0.12" />
          <Stop offset="1" stopColor={TEAL} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <AnimatedCircle cx="50" cy="50" r="50" fill="url(#halo)" opacity={halo} />
      <Circle cx="50" cy="50" r={r} fill="#07101C" fillOpacity={0.55} />
      <AnimatedCircle
        cx="50" cy="50" r={r} fill="none" stroke="url(#ringGrad)" strokeWidth={2.6} strokeLinecap="round"
        strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={ringOffset}
        transform="rotate(-90 50 50)"
      />
      <AnimatedG opacity={ticks}>
        <Line x1="50" y1="5" x2="50" y2="13" stroke={TEAL} strokeWidth={2.6} strokeLinecap="round" />
        <Line x1="50" y1="87" x2="50" y2="95" stroke={ORANGE} strokeWidth={2.6} strokeLinecap="round" />
        <Line x1="5" y1="50" x2="13" y2="50" stroke={TEAL} strokeWidth={2.6} strokeLinecap="round" />
        <Line x1="87" y1="50" x2="95" y2="50" stroke={ORANGE} strokeWidth={2.6} strokeLinecap="round" />
      </AnimatedG>
      <AnimatedG opacity={arrow}>
        <Path d="M50 22 L31 72 L50 61 Z" fill="url(#leftHalf)" />
        <Path d="M50 22 L69 72 L50 61 Z" fill="url(#rightHalf)" />
        <Path d="M31 72 L50 61 L50 66 Z" fill="#0B6E6A" />
        <Path d="M69 72 L50 61 L50 66 Z" fill="#A94A10" />
      </AnimatedG>
    </Svg>
  );
}
