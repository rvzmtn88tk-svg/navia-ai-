// Animated illustrations for the first-launch story. Each scene is a tiny
// deep-space map with a route; animated parts are Views over a static SVG so
// they run on the native driver. Scenes loop only while their page is shown.
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, Text as RNText, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { Icon, type IconName } from "./Icon";
import { NaviaEmblem } from "./NaviaEmblem";
import { palettes } from "../theme/tokens";

const B = palettes.dark;
const VB_W = 300;
const VB_H = 200;
// Route in viewBox units: east, north, east, north, east (four turns).
const ROUTE: [number, number][] = [[24, 176], [110, 176], [110, 104], [206, 104], [206, 36], [278, 36]];
const ROUTE_D = `M${ROUTE.map((p) => p.join(" ")).join(" L")}`;

function cumulative(): number[] {
  const out = [0];
  for (let i = 1; i < ROUTE.length; i++) out.push(out[i - 1]! + Math.hypot(ROUTE[i]![0] - ROUTE[i - 1]![0], ROUTE[i]![1] - ROUTE[i - 1]![1]));
  return out;
}
const CUM = cumulative();
const TOTAL = CUM[CUM.length - 1]!;

function pointAt(t: number): [number, number] {
  const d = Math.max(0, Math.min(1, t)) * TOTAL;
  let i = 1;
  while (i < CUM.length - 1 && CUM[i]! < d) i++;
  const k = (d - CUM[i - 1]!) / (CUM[i]! - CUM[i - 1]! || 1);
  return [ROUTE[i - 1]![0] + (ROUTE[i]![0] - ROUTE[i - 1]![0]) * k, ROUTE[i - 1]![1] + (ROUTE[i]![1] - ROUTE[i - 1]![1]) * k];
}

/** 0→1 loop while `active`. */
function useLoop(active: boolean, duration: number): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { v.stopAnimation(); v.setValue(0); return; }
    v.setValue(0);
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, duration, v]);
  return v;
}

function MapBackdrop({ w, h, dim = false }: { w: number; h: number; dim?: boolean }): JSX.Element {
  // Faint streets and blocks, a river — just enough to read as a map.
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${VB_W} ${VB_H}`} style={StyleSheet.absoluteFill}>
      <Rect x="0" y="0" width={VB_W} height={VB_H} rx="18" fill="#07101E" />
      <Path d="M-10 60 C 60 40, 120 90, 190 60 S 290 20, 320 40" stroke="#0E2A44" strokeWidth={10} fill="none" />
      {[40, 80, 140, 170].map((y) => <Path key={`h${y}`} d={`M0 ${y} H${VB_W}`} stroke="#132138" strokeWidth={2} />)}
      {[60, 150, 240].map((x) => <Path key={`v${x}`} d={`M${x} 0 V${VB_H}`} stroke="#132138" strokeWidth={2} />)}
      {[[18, 118], [132, 128], [226, 128], [132, 52], [236, 60], [30, 20], [150, 12]].map(([x, y], i) => (
        <Rect key={i} x={x} y={y} width="36" height="26" rx="4" fill="#0C1A2E" opacity={dim ? 0.6 : 1} />
      ))}
    </Svg>
  );
}

function RouteLine({ w, h, dashedFrom }: { w: number; h: number; dashedFrom?: number }): JSX.Element {
  if (dashedFrom == null) {
    return (
      <Svg width={w} height={h} viewBox={`0 0 ${VB_W} ${VB_H}`} style={StyleSheet.absoluteFill}>
        <Path d={ROUTE_D} stroke={B.brandTeal} strokeOpacity={0.25} strokeWidth={12} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <Path d={ROUTE_D} stroke={B.brandTeal} strokeWidth={4.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    );
  }
  // Solid while GPS is there, dashed (estimated) after it is lost.
  const [bx, by] = pointAt(dashedFrom);
  const cut = CUM.findIndex((c) => c >= dashedFrom * TOTAL);
  const solid = `M${[...ROUTE.slice(0, cut), [bx, by]].map((p) => p.join(" ")).join(" L")}`;
  const dashed = `M${[[bx, by], ...ROUTE.slice(cut)].map((p) => p.join(" ")).join(" L")}`;
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${VB_W} ${VB_H}`} style={StyleSheet.absoluteFill}>
      <Path d={solid} stroke={B.brandTeal} strokeWidth={4.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Path d={dashed} stroke={B.brandOrange} strokeWidth={4} strokeDasharray="7 7" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

function Puck({ x, y, color, opacity }: { x: Animated.AnimatedInterpolation<number>; y: Animated.AnimatedInterpolation<number>; color: string; opacity?: Animated.AnimatedInterpolation<number> | number }): JSX.Element {
  return (
    <Animated.View style={[styles.puck, { borderColor: color, shadowColor: color, opacity: opacity ?? 1, transform: [{ translateX: x }, { translateY: y }] }]}>
      <View style={[styles.puckDot, { backgroundColor: color }]} />
    </Animated.View>
  );
}

function Chip({ icon, text, color, opacity, style }: { icon: IconName; text: string; color: string; opacity: Animated.AnimatedInterpolation<number> | number; style?: object }): JSX.Element {
  return (
    <Animated.View style={[styles.chip, { borderColor: color, opacity }, style]}>
      <Icon name={icon} size={14} color={color} />
      <RNText style={[styles.chipText, { color }]}>{text}</RNText>
    </Animated.View>
  );
}

type SceneProps = { width: number; active: boolean; labels: Record<string, string> };

/** Problem: the ordinary navigator's dot follows, then jumps around (spoofing). */
export function JamScene({ width, active, labels }: SceneProps): JSX.Element {
  const h = width * VB_H / VB_W;
  const s = width / VB_W;
  const t = useLoop(active, 4200);
  const { x, y } = useMemo(() => {
    const input: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= 10; i++) { const k = i / 10 * 0.45; const [px, py] = pointAt(k / 0.8); input.push(k); xs.push(px * s); ys.push(py * s); }
    // Spoofed fixes: jumps far off the route.
    const jumps: [number, number][] = [[230, 170], [60, 40], [260, 120], [40, 110], [180, 180], [120, 20]];
    jumps.forEach(([jx, jy], i) => { input.push(0.5 + i * 0.09); xs.push(jx * s); ys.push(jy * s); });
    return { x: t.interpolate({ inputRange: input, outputRange: xs }), y: t.interpolate({ inputRange: input, outputRange: ys }) };
  }, [s, t]);
  const redOn = t.interpolate({ inputRange: [0, 0.44, 0.46, 1], outputRange: [0, 0, 1, 1] });
  const tealOn = t.interpolate({ inputRange: [0, 0.44, 0.46, 1], outputRange: [1, 1, 0, 0] });
  const routeFade = t.interpolate({ inputRange: [0, 0.45, 0.6, 1], outputRange: [1, 1, 0.25, 0.25] });
  return (
    <View style={{ width, height: h }}>
      <MapBackdrop w={width} h={h} />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: routeFade }]}><RouteLine w={width} h={h} /></Animated.View>
      <Puck x={x} y={y} color={B.brandTeal} opacity={tealOn} />
      <Puck x={x} y={y} color={B.critical} opacity={redOn} />
      <Chip icon="satellite" text={labels.jammed!} color={B.critical} opacity={redOn} style={styles.chipTopLeft} />
    </View>
  );
}

/** Solution: NAVIA keeps moving smoothly along the route after GPS is lost. */
export function ResilientScene({ width, active, labels }: SceneProps): JSX.Element {
  const h = width * VB_H / VB_W;
  const s = width / VB_W;
  const t = useLoop(active, 6000);
  const { x, y } = useMemo(() => {
    const input: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= 40; i++) { const k = i / 40; const [px, py] = pointAt(k); input.push(k); xs.push(px * s); ys.push(py * s); }
    return { x: t.interpolate({ inputRange: input, outputRange: xs }), y: t.interpolate({ inputRange: input, outputRange: ys }) };
  }, [s, t]);
  const lost = t.interpolate({ inputRange: [0, 0.36, 0.42, 0.97, 1], outputRange: [0, 0, 1, 1, 0] });
  return (
    <View style={{ width, height: h }}>
      <MapBackdrop w={width} h={h} />
      <RouteLine w={width} h={h} dashedFrom={0.4} />
      <Puck x={x} y={y} color={B.brandTeal} />
      <Chip icon="satellite" text={labels.guiding!} color={B.brandOrange} opacity={lost} style={styles.chipTopLeft} />
    </View>
  );
}

/** Landmarks light up as the dot reaches each turn; "I've turned" confirms. */
export function LandmarkScene({ width, active, labels }: SceneProps): JSX.Element {
  const h = width * VB_H / VB_W;
  const s = width / VB_W;
  const t = useLoop(active, 7000);
  const { x, y } = useMemo(() => {
    const input: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= 40; i++) { const k = i / 40; const [px, py] = pointAt(k); input.push(k); xs.push(px * s); ys.push(py * s); }
    return { x: t.interpolate({ inputRange: input, outputRange: xs }), y: t.interpolate({ inputRange: input, outputRange: ys }) };
  }, [s, t]);
  // Turns at route fractions: CUM[i] / TOTAL.
  const turns = [1, 2, 3].map((i) => CUM[i]! / TOTAL);
  const badge = (k: number) => t.interpolate({ inputRange: [0, Math.max(0.001, k - 0.16), k - 0.04, k + 0.18, Math.min(0.999, k + 0.3), 1], outputRange: [0, 0, 1, 1, 0.35, 0.35] });
  const confirm = (k: number) => t.interpolate({ inputRange: [0, k, k + 0.02, k + 0.12, k + 0.14, 1], outputRange: [0, 0, 1, 1, 0, 0] });
  const items: { icon: IconName; text: string; at: [number, number]; k: number; dx: number; dy: number }[] = [
    { icon: "traffic", text: labels.lights!, at: ROUTE[1]!, k: turns[0]!, dx: 8, dy: -34 },
    { icon: "fuel", text: labels.fuel!, at: ROUTE[2]!, k: turns[1]!, dx: -118, dy: -34 },
    { icon: "route", text: labels.bridge!, at: ROUTE[3]!, k: turns[2]!, dx: 10, dy: 8 },
  ];
  return (
    <View style={{ width, height: h }}>
      <MapBackdrop w={width} h={h} />
      <RouteLine w={width} h={h} />
      {items.map((it) => (
        <Animated.View key={it.text} style={[styles.badge, { left: it.at[0] * s + it.dx, top: it.at[1] * s + it.dy, opacity: badge(it.k), transform: [{ scale: badge(it.k).interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }]}>
          <Icon name={it.icon} size={13} color={B.brandOrange} />
          <RNText style={styles.badgeText}>{it.text}</RNText>
        </Animated.View>
      ))}
      <Puck x={x} y={y} color={B.brandTeal} />
      {items.map((it) => (
        <Chip key={`c-${it.text}`} icon="check" text={labels.turned!} color={B.success} opacity={confirm(it.k)} style={styles.chipBottomRight} />
      ))}
    </View>
  );
}

/** The dot's colour is the confidence: green, yellow, red. */
export function TrustScene({ width, active }: { width: number; active: boolean }): JSX.Element {
  const h = width * 0.42;
  const t = useLoop(active, 4500);
  const colors = [B.success, B.warning, B.critical];
  return (
    <View style={[styles.trustRow, { width, height: h }]}>
      {colors.map((col, i) => {
        const on = t.interpolate({ inputRange: [0, i / 3, i / 3 + 0.05, (i + 1) / 3 - 0.02, (i + 1) / 3, 1].map((v) => Math.min(1, Math.max(0, v))).map((v, j, arr) => (j > 0 && v <= arr[j - 1]! ? arr[j - 1]! + 0.0001 : v)), outputRange: [0.35, 0.35, 1, 1, 0.35, 0.35] });
        return (
          <Animated.View key={col} style={[styles.trustDot, { borderColor: col, shadowColor: col, opacity: on, transform: [{ scale: on.interpolate({ inputRange: [0.35, 1], outputRange: [0.85, 1.1] }) }] }]}>
            <View style={[styles.trustCore, { backgroundColor: col }]} />
          </Animated.View>
        );
      })}
    </View>
  );
}

/** Shelters pop up around you; the co-pilot answers. */
export function SafetyScene({ width, active, labels }: SceneProps): JSX.Element {
  const h = width * VB_H / VB_W;
  const s = width / VB_W;
  const t = useLoop(active, 5000);
  const shelters: [number, number][] = [[200, 70], [90, 60], [230, 140], [60, 150]];
  const me: [number, number] = [150, 110];
  return (
    <View style={{ width, height: h }}>
      <MapBackdrop w={width} h={h} dim />
      <Svg width={width} height={h} viewBox={`0 0 ${VB_W} ${VB_H}`} style={StyleSheet.absoluteFill}>
        <Circle cx={me[0]} cy={me[1]} r={46} stroke={B.brandTeal} strokeOpacity={0.25} strokeWidth={1.5} fill="none" strokeDasharray="4 5" />
        <Circle cx={me[0]} cy={me[1]} r={82} stroke={B.brandTeal} strokeOpacity={0.15} strokeWidth={1.5} fill="none" strokeDasharray="4 5" />
      </Svg>
      {shelters.map(([sx, sy], i) => {
        const on = t.interpolate({ inputRange: [0, 0.08 + i * 0.1, 0.16 + i * 0.1, 0.9, 1], outputRange: [0, 0, 1, 1, 0] });
        return (
          <Animated.View key={i} style={[styles.shelter, { left: sx * s - 13, top: sy * s - 13, opacity: on, transform: [{ scale: on }] }]}>
            <Icon name="shelter" size={14} color="#FFFFFF" />
          </Animated.View>
        );
      })}
      <View style={[styles.meMark, { left: me[0] * s - 18, top: me[1] * s - 18 }]}><NaviaEmblem size={36} /></View>
      <Chip icon="sparkle" text={labels.answer!} color={B.brandTeal} opacity={t.interpolate({ inputRange: [0, 0.5, 0.58, 0.95, 1], outputRange: [0, 0, 1, 1, 0] })} style={styles.chipBottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  puck: { position: "absolute", left: -11, top: -11, width: 22, height: 22, borderRadius: 11, borderWidth: 3, backgroundColor: "#07101E", alignItems: "center", justifyContent: "center", shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  puckDot: { width: 8, height: 8, borderRadius: 4 },
  chip: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, backgroundColor: "rgba(5,10,20,0.9)" },
  chipText: { fontSize: 12, fontWeight: "700" },
  chipTopLeft: { left: 10, top: 10 },
  chipBottomRight: { right: 10, bottom: 10 },
  chipBottom: { left: 10, right: 10, bottom: 10, justifyContent: "center" },
  badge: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: B.brandOrange, backgroundColor: "rgba(5,10,20,0.92)" },
  badgeText: { color: "#FFE3C4", fontSize: 11, fontWeight: "700" },
  trustRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-evenly" },
  trustDot: { width: 58, height: 58, borderRadius: 29, borderWidth: 4, backgroundColor: "#07101E", alignItems: "center", justifyContent: "center", shadowOpacity: 0.9, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  trustCore: { width: 18, height: 18, borderRadius: 9 },
  shelter: { position: "absolute", width: 26, height: 26, borderRadius: 13, backgroundColor: B.critical, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#07101E" },
  meMark: { position: "absolute", width: 36, height: 36 },
});
