// Place categories as a radial menu: one compact button on the map; a tap
// unfolds every category around a circle out of the button (the ring flies
// from the button to the middle of the screen while it turns and the
// categories spread out one after another). Only transforms and opacity
// are animated, on the native driver — the JS thread does nothing per frame.
// Choosing a category calls the same selection as the old chip row did.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CATEGORY_META, type ChipCategory } from "../places/categories";
import { useT } from "../i18n";
import { Text, Touchable, useColors } from "./ui";
import { Icon } from "./Icon";
import { elevation, iconSize, space } from "../theme/tokens";
import { fpsEnd, fpsStart } from "../perf/perf";
import { wheelGeometry } from "../places/wheelGeometry";
import { benchHooks } from "../perf/bench";

const BUTTON = 48;
const OPEN_MS = 420;
const CLOSE_MS = 200;

type Props = {
  categories: ChipCategory[];
  selected: ChipCategory | null;
  onSelect: (category: ChipCategory) => void;
};

export function CategoryWheel({ categories, selected, onSelect }: Props): JSX.Element {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const button = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const busy = useRef(false);

  const geo = useMemo(() => wheelGeometry(categories.length, width, height, origin?.bottom ?? insets.top + 120, insets.top, insets.bottom + space.md),
    [categories.length, width, height, origin?.bottom, insets.top, insets.bottom]);

  const show = useCallback(() => {
    if (busy.current) return;
    button.current?.measureInWindow((x, y, w, h) => {
      setOrigin({ x: x + w / 2, y: y + h / 2, bottom: y + h });
      setOpen(true);
    });
  }, []);

  // Start once the modal is on screen, so the first frame is the button.
  const onShow = useCallback(() => {
    busy.current = true;
    progress.setValue(0);
    fpsStart();
    Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      .start(() => { busy.current = false; void fpsEnd("category wheel: open"); });
  }, [progress]);

  const hide = useCallback((then?: () => void) => {
    busy.current = true;
    then?.();
    fpsStart();
    Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => { busy.current = false; setOpen(false); void fpsEnd("category wheel: close"); });
  }, [progress]);

  useEffect(() => {
    benchHooks.openWheel = show;
    benchHooks.closeWheel = () => hide();
    return () => { benchHooks.openWheel = undefined; benchHooks.closeWheel = undefined; };
  }, [show, hide]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  const ox = (origin?.x ?? geo.cx) - geo.cx;
  const oy = (origin?.y ?? geo.cy) - geo.cy;
  const n = categories.length;
  const selectedMeta = selected ? CATEGORY_META[selected] : null;

  return (
    <View style={styles.row} pointerEvents="box-none">
      <View ref={button} collapsable={false}>
        <Touchable accessibilityRole="button" accessibilityLabel={t("wheel.open")} accessibilityState={{ expanded: open }} onPress={show}
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
        <Touchable accessibilityRole="button" accessibilityLabel={t("wheel.open")} onPress={show}
          style={[styles.pill, { backgroundColor: c.surfaceElevated }, elevation(1, c)]}>
          <Text variant="subhead" color="secondary" numberOfLines={1}>{t("wheel.open")}</Text>
        </Touchable>
      )}

      <Modal visible={open} transparent animationType="none" statusBarTranslucent onShow={onShow} onRequestClose={() => hide()}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => hide()} />
        </Animated.View>
        <Animated.View pointerEvents="box-none" style={[styles.hub, { left: geo.cx, top: geo.cy, transform: [
          { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [ox, 0] }) },
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [oy, 0] }) },
          { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] }) },
        ] }]}>
          {categories.map((cat, i) => {
            const meta = CATEGORY_META[cat];
            const at = geo.items[i]!;
            // One after another around the circle.
            const d = (i / n) * 0.45;
            const q = progress.interpolate({ inputRange: [d, d + 0.55], outputRange: [0, 1], extrapolate: "clamp" });
            const on = cat === selected;
            return (
              <Animated.View key={cat} style={[styles.item, { left: at.x - geo.labelW / 2, top: at.y - geo.disc / 2, width: geo.labelW, opacity: q, transform: [
                { translateX: q.interpolate({ inputRange: [0, 1], outputRange: [-at.x, 0] }) },
                { translateY: q.interpolate({ inputRange: [0, 1], outputRange: [-at.y, 0] }) },
                // Upright while the ring turns.
                { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["90deg", "0deg"] }) },
                { scale: q.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
              ] }]}>
                <Pressable accessibilityRole="button" accessibilityLabel={t(meta.label)} accessibilityState={{ selected: on }}
                  onPress={() => hide(() => onSelect(cat))} style={styles.itemPress}>
                  <View style={[styles.disc, { width: geo.disc, height: geo.disc, borderRadius: geo.disc / 2, backgroundColor: on ? meta.color : c.surfaceElevated, borderColor: meta.color }]}>
                    <Icon name={meta.icon} size={geo.disc > 50 ? iconSize.lg : iconSize.md} color={on ? "#FFFFFF" : meta.color} />
                  </View>
                  <View style={[styles.label, { maxHeight: geo.labelH, backgroundColor: c.surfaceElevated }]}>
                    <Text variant="caption" numberOfLines={2} style={[styles.labelText, { fontSize: geo.labelFont, lineHeight: geo.labelFont + 4 }]}>{t(meta.label)}</Text>
                  </View>
                </Pressable>
              </Animated.View>
            );
          })}
          <Animated.View style={[styles.center, { transform: [{ scale: progress }] }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => hide()}
              style={[styles.centerPress, { backgroundColor: c.surfaceElevated, borderColor: c.brandTeal }]}>
              <Icon name="close" size={iconSize.md} color={c.textPrimary} />
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Modal>
    </View>
  );
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
  disc: { alignItems: "center", justifyContent: "center", borderWidth: 2 },
  label: { marginTop: 4, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 },
  labelText: { textAlign: "center" },
  center: { position: "absolute", left: -26, top: -26 },
  centerPress: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", borderWidth: 1.5 },
});
