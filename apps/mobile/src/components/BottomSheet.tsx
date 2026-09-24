// Draggable bottom sheet with three resting heights (peek, half, full).
// Drag the handle/header to move it; releases snap with velocity, like maps
// apps. The sheet reports its visible height so floating map controls and the
// map camera can stay above it.
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "./ui";
import { elevation, radius, space } from "../theme/tokens";

export type SheetSnap = "peek" | "half" | "full";

type Props = {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  peekHeight: number;
  /** Top of the full sheet, measured from the top of the screen. */
  fullTop: number;
  header: React.ReactNode;
  children: React.ReactNode;
  /** Visible sheet height in px, animated. */
  visibleHeight?: Animated.Value;
};

export function BottomSheet({ snap, onSnapChange, peekHeight, fullTop, header, children, visibleHeight }: Props): JSX.Element {
  const c = useColors();
  const { height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetH = screenH - fullTop;
  const offsets = useMemo(() => ({
    full: 0,
    half: Math.max(0, sheetH - Math.round(screenH * 0.48)),
    peek: Math.max(0, sheetH - peekHeight - insets.bottom),
  }), [sheetH, screenH, peekHeight, insets.bottom]);

  const translateY = useRef(new Animated.Value(offsets[snap])).current;
  const current = useRef(offsets[snap]);
  const dragStart = useRef(0);

  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      current.current = value;
      visibleHeight?.setValue(sheetH - value);
    });
    return () => translateY.removeListener(id);
  }, [translateY, visibleHeight, sheetH]);

  useEffect(() => {
    Animated.spring(translateY, { toValue: offsets[snap], useNativeDriver: false, damping: 26, stiffness: 240, mass: 0.9 }).start();
  }, [snap, offsets, translateY]);

  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { translateY.stopAnimation(); dragStart.current = current.current; },
    onPanResponderMove: (_, g) => translateY.setValue(Math.min(offsets.peek + 24, Math.max(-12, dragStart.current + g.dy))),
    onPanResponderRelease: (_, g) => {
      const projected = current.current + g.vy * 180;
      const order: SheetSnap[] = ["full", "half", "peek"];
      const nearest = order.reduce((best, s) => Math.abs(offsets[s] - projected) < Math.abs(offsets[best] - projected) ? s : best, "peek" as SheetSnap);
      Animated.spring(translateY, { toValue: offsets[nearest], velocity: g.vy, useNativeDriver: false, damping: 26, stiffness: 240, mass: 0.9 }).start();
      if (nearest !== snap) onSnapChange(nearest);
    },
  }), [offsets, onSnapChange, snap, translateY]);

  const cycle = () => onSnapChange(snap === "peek" ? "half" : snap === "half" ? "full" : "peek");

  return (
    <Animated.View style={[styles.sheet, { top: fullTop, height: sheetH, backgroundColor: c.surface, transform: [{ translateY }] }, elevation(3, c)]}>
      <View {...pan.panHandlers}>
        <Pressable onPress={cycle} accessibilityRole="adjustable" accessibilityLabel="sheet" style={styles.handleArea}>
          <View style={[styles.handle, { backgroundColor: c.border }]} />
        </Pressable>
        {header}
      </View>
      <Animated.View style={[styles.body, { paddingBottom: insets.bottom, opacity: translateY.interpolate({ inputRange: [offsets.half, offsets.peek], outputRange: [1, 0], extrapolate: "clamp" }) }]}>{children}</Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: "absolute", left: 0, right: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" },
  handleArea: { alignItems: "center", paddingTop: space.xs, paddingBottom: space.xs },
  handle: { width: 36, height: 5, borderRadius: radius.pill },
  body: { flex: 1 },
});
