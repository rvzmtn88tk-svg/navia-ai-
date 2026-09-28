// Place categories as a radial menu: one compact button on the map; a tap
// unfolds every category around a circle out of the button (the ring flies
// from the button to the middle of the screen while it turns and the
// categories spread out one after another). Choosing a category calls the
// same selection as the old chip row did.
//
// Speed: the ring is mounted once, invisible, and stays mounted — opening
// creates no views (a Modal with 12 new views cost ~50 ms on the first
// frames on an iPhone 17 Pro). Only transforms and opacity animate, on the
// native driver; no shadows on animated views (offscreen passes per frame).
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { CATEGORY_META, type ChipCategory } from "../places/categories";
import { useT } from "../i18n";
import { Text, Touchable, useColors } from "./ui";
import { Icon } from "./Icon";
import { elevation, iconSize, space } from "../theme/tokens";
import { fpsEnd, fpsStart } from "../perf/perf";
import { wheelGeometry } from "../places/wheelGeometry";
import { benchHooks, benchRunning } from "../perf/bench";

const BUTTON = 48;
/** Dark in both themes: the coloured discs and white labels need it. */
const SCRIM = "rgba(2, 6, 14, 0.78)";
const OPEN_MS = 420;
const CLOSE_MS = 200;

type Origin = { x: number; y: number; bottom: number };
const useWheel = create<{ open: boolean; origin: Origin | null; setOpen: (open: boolean) => void; setOrigin: (o: Origin) => void }>((set) => ({
  open: false, origin: null,
  setOpen: (open) => set({ open }),
  setOrigin: (origin) => set({ origin }),
}));
const progress = new Animated.Value(0);
let busy = false;

function openWheel(): void {
  if (busy || useWheel.getState().open) return;
  busy = true;
  const measure = !benchRunning();
  if (measure) fpsStart();
  // Animation first: the re-render for touch handling comes after.
  Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true })
    .start(() => { busy = false; if (measure) void fpsEnd("category wheel: open"); });
  useWheel.getState().setOpen(true);
}

function closeWheel(then?: () => void): void {
  if (!useWheel.getState().open) return;
  then?.();
  const measure = !benchRunning();
  if (measure) fpsStart();
  busy = true;
  Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })
    .start(() => { busy = false; useWheel.getState().setOpen(false); if (measure) void fpsEnd("category wheel: close"); });
}

benchHooks.openWheel = openWheel;
benchHooks.closeWheel = () => closeWheel();

/** The button (in the top bar) and the chosen category's pill. */
export function CategoryWheelButton({ categories, selected, onSelect }: { categories: ChipCategory[]; selected: ChipCategory | null; onSelect: (category: ChipCategory) => void }): JSX.Element {
  const c = useColors();
  const { t } = useT();
  const button = useRef<View>(null);
  const open = useWheel((s) => s.open);
  const measure = useCallback(() => {
    button.current?.measureInWindow((x, y, w, h) => { if (w > 0) useWheel.getState().setOrigin({ x: x + w / 2, y: y + h / 2, bottom: y + h }); });
  }, []);
  const selectedMeta = selected ? CATEGORY_META[selected] : null;
  return (
    <View style={styles.row} pointerEvents="box-none">
      <View ref={button} collapsable={false} onLayout={measure}>
        <Touchable accessibilityRole="button" accessibilityLabel={t("wheel.open")} accessibilityState={{ expanded: open }} onPress={openWheel}
          style={[styles.button, { backgroundColor: selectedMeta ? selectedMeta.color : c.surfaceElevated, borderColor: c.brandTeal }, elevation(2, c)]}>
          {selectedMeta ? <Icon name={selectedMeta.icon} size={iconSize.md} color="#FFFFFF" /> : <Dots colors={categories.slice(0, 6).map((k) => CATEGORY_META[k].color)} />}
        </Touchable>
      </View>
      {selected && selectedMeta ? (
        <Touchable accessibilityRole="button" accessibilityLabel={`${t(selectedMeta.label)} · ${t("common.close")}`} onPress={() => onSelect(selected)}
          style={[styles.pill, { backgroundColor: c.surfaceElevated }, elevation(1, c)]}>
          <Text variant="subhead" numberOfLines={1}>{t(selectedMeta.label)}</Text>
          <Icon name="close" size={iconSize.sm} color={c.textSecondary} />
        </Touchable>
      ) : (
        <Touchable accessibilityRole="button" accessibilityLabel={t("wheel.open")} onPress={openWheel}
          style={[styles.pill, { backgroundColor: c.surfaceElevated }, elevation(1, c)]}>
          <Text variant="subhead" color="secondary" numberOfLines={1}>{t("wheel.open")}</Text>
        </Touchable>
      )}
    </View>
  );
}

/** The ring. Render it once, last in the screen (above the map, sheet and controls). */
export function CategoryWheelOverlay({ categories, selected, onSelect }: { categories: ChipCategory[]; selected: ChipCategory | null; onSelect: (category: ChipCategory) => void }): JSX.Element {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const open = useWheel((s) => s.open);
  const origin = useWheel((s) => s.origin);
  useEffect(() => () => progress.stopAnimation(), []);

  const geo = useMemo(() => wheelGeometry(categories.length, width, height, origin?.bottom ?? insets.top + 120, insets.top, insets.bottom + space.md),
    [categories.length, width, height, origin?.bottom, insets.top, insets.bottom]);
  const ox = (origin?.x ?? geo.cx) - geo.cx;
  const oy = (origin?.y ?? geo.cy) - geo.cy;
  const n = categories.length;

  // Interpolations depend only on the layout: built once per layout.
  const anim = useMemo(() => ({
    hub: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [ox, 0] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [oy, 0] }) },
      { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] }) },
    ],
    upright: progress.interpolate({ inputRange: [0, 1], outputRange: ["90deg", "0deg"] }),
    items: geo.items.map((at, i) => {
      // One after another around the circle.
      const d = (i / n) * 0.45;
      const q = progress.interpolate({ inputRange: [d, d + 0.55], outputRange: [0, 1], extrapolate: "clamp" });
      return {
        q,
        x: q.interpolate({ inputRange: [0, 1], outputRange: [-at.x, 0] }),
        y: q.interpolate({ inputRange: [0, 1], outputRange: [-at.y, 0] }),
        s: q.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
      };
    }),
  }), [geo, ox, oy, n]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "box-none" : "none"} accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM, opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => closeWheel()} />
      </Animated.View>
      <Animated.View pointerEvents="box-none" style={[styles.hub, { left: geo.cx, top: geo.cy, opacity: progress, transform: anim.hub }]}>
        {/* The ring itself: an even circle through every category. */}
        <Animated.View pointerEvents="none" style={[styles.track, { left: -geo.rx, top: -geo.ry, width: 2 * geo.rx, height: 2 * geo.ry, borderRadius: geo.rx, borderColor: c.brandTeal, transform: [{ scale: progress }] }]} />
        {categories.map((cat, i) => {
          const meta = CATEGORY_META[cat];
          const at = geo.items[i]!;
          const a = anim.items[i]!;
          const on = cat === selected;
          return (
            <Animated.View key={cat} style={[styles.item, { left: at.x - geo.labelW / 2, top: at.y - geo.disc / 2, width: geo.labelW, opacity: a.q, transform: [
              { translateX: a.x }, { translateY: a.y },
              // Upright while the ring turns.
              { rotate: anim.upright },
              { scale: a.s },
            ] }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={t(meta.label)} accessibilityState={{ selected: on }}
                onPress={() => closeWheel(() => onSelect(cat))} style={styles.itemPress}>
                <View style={[styles.disc, { width: geo.disc, height: geo.disc, borderRadius: geo.disc / 2, backgroundColor: meta.color, borderColor: on ? c.brandTeal : "#FFFFFF", borderWidth: on ? 3 : 2, transform: [{ scale: on ? 1.12 : 1 }] }]}>
                  <Icon name={meta.icon} size={iconSize.md} color="#FFFFFF" strokeWidth={2.4} />
                </View>
                <View style={[styles.label, { height: geo.labelH, borderColor: on ? c.brandTeal : "transparent" }]}>
                  <Text variant="caption" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}
                    style={[styles.labelText, { fontSize: geo.labelFont, lineHeight: geo.labelFont + 4, color: "#FFFFFF" }]}>{t(shortLabel(cat))}</Text>
                </View>
              </Pressable>
            </Animated.View>
          );
        })}
        <Animated.View style={[styles.center, { transform: [{ scale: progress }] }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => closeWheel()}
            style={[styles.centerPress, { backgroundColor: c.brandTeal, borderColor: "#FFFFFF" }]}>
            <Icon name="close" size={iconSize.md} color="#04201E" strokeWidth={2.6} />
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** Short names on the ring (one line); the full name stays for VoiceOver. */
function shortLabel(cat: ChipCategory) {
  return cat === "resilience" ? "wheel.short.resilience" as const : CATEGORY_META[cat].label;
}

/** Six category colours around a circle: "the categories are in here". */
function Dots({ colors }: { colors: string[] }): JSX.Element {
  return (
    <View style={styles.dots}>
      {colors.map((color, i) => {
        const a = (-90 + (360 * i) / colors.length) * (Math.PI / 180);
        return <View key={i} style={[styles.dot, { backgroundColor: color, left: 10 + 8 * Math.cos(a) - 3, top: 10 + 8 * Math.sin(a) - 3 }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, marginTop: space.xs },
  button: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center", borderWidth: 1.5 },
  pill: { flexDirection: "row", alignItems: "center", gap: space.xs, height: 36, borderRadius: 18, paddingHorizontal: space.sm, maxWidth: 220 },
  dots: { width: 20, height: 20 },
  dot: { position: "absolute", width: 6, height: 6, borderRadius: 3 },
  hub: { position: "absolute", width: 0, height: 0 },
  item: { position: "absolute", alignItems: "center" },
  itemPress: { alignItems: "center" },
  disc: { alignItems: "center", justifyContent: "center" },
  label: { marginTop: 4, borderRadius: 10, paddingHorizontal: 4, justifyContent: "center", backgroundColor: "rgba(8, 16, 30, 0.96)", borderWidth: 1 },
  labelText: { textAlign: "center", fontWeight: "600" },
  track: { position: "absolute", borderWidth: 2, opacity: 0.55, backgroundColor: "rgba(10, 22, 40, 0.55)" },
  center: { position: "absolute", left: -26, top: -26 },
  centerPress: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", borderWidth: 1.5 },
});
