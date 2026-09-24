// NAVIA base components. Built only on design tokens; screens compose these
// instead of styling raw React Native primitives.
import React, { createContext, useContext, useRef } from "react";
import {
  ActivityIndicator, Animated, Pressable, StyleSheet, Text as RNText, TextInput as RNTextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useAppSettings } from "../settings/AppSettings";
import { elevation, hairline, iconSize, radius, space, touchTarget, typography, type ThemeColors, type TypographyVariant } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";

const ColorsOverrideContext = createContext<ThemeColors | null>(null);

/** Renders children with a fixed palette (e.g. NAVIA navy chrome over a light map). */
export function ColorsOverride({ colors, children }: { colors: ThemeColors; children: React.ReactNode }): JSX.Element {
  return <ColorsOverrideContext.Provider value={colors}>{children}</ColorsOverrideContext.Provider>;
}

export function useColors(): ThemeColors {
  const override = useContext(ColorsOverrideContext);
  const settings = useAppSettings().colors;
  return override ?? settings;
}

type ColorRole = "primary" | "secondary" | "muted" | "accent" | "onAccent" | "critical" | "warning" | "success" | "onCritical";

function roleColor(c: ThemeColors, role: ColorRole): string {
  switch (role) {
    case "primary": return c.textPrimary;
    case "secondary": return c.textSecondary;
    case "muted": return c.textMuted;
    case "accent": return c.accent;
    case "onAccent": return c.onAccent;
    case "critical": return c.critical;
    case "warning": return c.warning;
    case "success": return c.success;
    case "onCritical": return c.onCritical;
  }
}

export function Text({ variant = "body", color = "primary", style, ...rest }: TextProps & { variant?: TypographyVariant; color?: ColorRole | { custom: string } }): JSX.Element {
  const c = useColors();
  const resolved = typeof color === "string" ? roleColor(c, color) : color.custom;
  return <RNText maxFontSizeMultiplier={1.4} {...rest} style={[typography[variant], { color: resolved }, style]} />;
}

export function TextField(props: TextInputProps): JSX.Element {
  const c = useColors();
  return <RNTextInput placeholderTextColor={c.textMuted} maxFontSizeMultiplier={1.4} {...props} style={[typography.body, { color: c.textPrimary, flex: 1, minWidth: 0, paddingVertical: space.sm }, props.style]} />;
}

/** Pressable with a subtle scale + opacity response and a light haptic. */
export function Touchable({ style, onPressIn, onPressOut, onPress, haptic = true, children, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean; children?: React.ReactNode }): JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const animate = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  // Layout props must sit on the outer Pressable, or flex/width are lost.
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const outer: ViewStyle = {
    flex: flat.flex, flexGrow: flat.flexGrow, flexShrink: flat.flexShrink, flexBasis: flat.flexBasis, alignSelf: flat.alignSelf,
    width: flat.width, minWidth: flat.minWidth, maxWidth: flat.maxWidth,
    margin: flat.margin, marginTop: flat.marginTop, marginBottom: flat.marginBottom, marginLeft: flat.marginLeft, marginRight: flat.marginRight,
    marginHorizontal: flat.marginHorizontal, marginVertical: flat.marginVertical,
  };
  const inner: ViewStyle = { ...flat, margin: undefined, marginTop: undefined, marginBottom: undefined, marginLeft: undefined, marginRight: undefined, marginHorizontal: undefined, marginVertical: undefined, flex: undefined, flexGrow: undefined, flexShrink: undefined, flexBasis: undefined, alignSelf: undefined, width: undefined, minWidth: undefined, maxWidth: undefined };
  return (
    <Pressable
      style={outer}
      {...rest}
      onPressIn={(e) => { animate(0.97); onPressIn?.(e); }}
      onPressOut={(e) => { animate(1); onPressOut?.(e); }}
      onPress={(e) => { if (haptic) void Haptics.selectionAsync().catch(() => {}); onPress?.(e); }}
    >
      <Animated.View style={[inner, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function Button({ label, icon, onPress, variant = "primary", loading, disabled, style }: {
  label: string; icon?: IconName; onPress: () => void; variant?: "primary" | "secondary" | "critical"; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const c = useColors();
  const bg = variant === "primary" ? c.accent : variant === "critical" ? c.critical : c.surfaceMuted;
  const fg = variant === "primary" ? c.onAccent : variant === "critical" ? c.onCritical : c.textPrimary;
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={label} disabled={disabled || loading} onPress={onPress}
      style={[styles.button, { backgroundColor: disabled ? c.disabled : bg }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : <>
        {icon && <Icon name={icon} size={iconSize.md} color={fg} />}
        <Text variant="button" color={{ custom: fg }} numberOfLines={1}>{label}</Text>
      </>}
    </Touchable>
  );
}

export function IconButton({ icon, onPress, label, size = touchTarget, tone = "surface", active, style }: {
  icon: IconName; onPress: () => void; label: string; size?: number; tone?: "surface" | "plain" | "accent"; active?: boolean; style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const c = useColors();
  const bg = tone === "accent" || active ? c.accent : tone === "surface" ? c.surfaceElevated : "transparent";
  const fg = tone === "accent" || active ? c.onAccent : c.textPrimary;
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={space.xxs}
      style={[{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: bg }, tone === "surface" && elevation(2, c), style]}>
      <Icon name={icon} size={iconSize.lg} color={fg} />
    </Touchable>
  );
}

export function Chip({ label, icon, selected, onPress, tint }: { label: string; icon?: IconName; selected?: boolean; onPress: () => void; tint?: string }): JSX.Element {
  const c = useColors();
  const iconColor = selected ? c.onAccent : tint ?? c.accent;
  return (
    <Touchable accessibilityRole="button" accessibilityState={{ selected: !!selected }} accessibilityLabel={label} onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? c.accent : c.surfaceElevated }, elevation(1, c)]}>
      {icon && <Icon name={icon} size={iconSize.sm} color={iconColor} />}
      <Text variant="chip" color={selected ? "onAccent" : "primary"} numberOfLines={1}>{label}</Text>
    </Touchable>
  );
}

export function Card({ children, style, onPress, accessibilityLabel }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string }): JSX.Element {
  const c = useColors();
  const base = [styles.card, { backgroundColor: c.surface, borderColor: c.border }, style];
  if (onPress) return <Touchable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={base}>{children}</Touchable>;
  return <View style={base}>{children}</View>;
}

export function Divider({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }): JSX.Element {
  const c = useColors();
  return <View style={[{ height: hairline, backgroundColor: c.divider, marginLeft: inset }, style]} />;
}

export function ListRow({ icon, iconTint, title, subtitle, trailing, onPress, accessibilityLabel }: {
  icon?: IconName; iconTint?: string; title: string; subtitle?: string; trailing?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string;
}): JSX.Element {
  const c = useColors();
  const body = <>
    {icon && <View style={[styles.rowIcon, { backgroundColor: c.surfaceMuted }]}><Icon name={icon} size={iconSize.md} color={iconTint ?? c.accent} /></View>}
    <View style={styles.rowText}>
      <Text variant="bodyStrong" numberOfLines={1}>{title}</Text>
      {subtitle ? <Text variant="subhead" color="secondary" numberOfLines={1}>{subtitle}</Text> : null}
    </View>
    {trailing ?? (onPress ? <Icon name="chevronRight" size={iconSize.md} color={c.textMuted} /> : null)}
  </>;
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return <Touchable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress} style={styles.row}>{body}</Touchable>;
}

export function SectionLabel({ children, style }: { children: string; style?: StyleProp<TextStyle> }): JSX.Element {
  return <Text variant="overline" color="muted" style={[{ textTransform: "uppercase", marginBottom: space.xs }, style]}>{children}</Text>;
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }): JSX.Element {
  const c = useColors();
  return (
    <View style={[styles.segmented, { backgroundColor: c.surfaceMuted }]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => { void Haptics.selectionAsync().catch(() => {}); onChange(option.value); }}
            style={[styles.segment, selected && [{ backgroundColor: c.surfaceElevated }, elevation(1, c)]]}>
            <Text variant="subhead" color={selected ? "primary" : "secondary"} numberOfLines={1}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Colored status dot + label, used for GPS and alert states. */
export function StatusPill({ tone, label, icon }: { tone: "success" | "warning" | "critical" | "neutral"; label: string; icon?: IconName }): JSX.Element {
  const c = useColors();
  const fg = tone === "success" ? c.success : tone === "warning" ? c.warning : tone === "critical" ? c.critical : c.textSecondary;
  const bg = tone === "success" ? c.successSoft : tone === "warning" ? c.warningSoft : tone === "critical" ? c.criticalSoft : c.surfaceMuted;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={iconSize.sm} color={fg} /> : <View style={[styles.dot, { backgroundColor: fg }]} />}
      <Text variant="caption" color={{ custom: fg }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderRadius: radius.lg, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs },
  chip: { height: 36, borderRadius: radius.pill, paddingHorizontal: space.sm, flexDirection: "row", alignItems: "center", gap: space.xs },
  card: { borderRadius: radius.lg, borderWidth: hairline, padding: space.md },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0 },
  pill: { flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.sm, height: 28, borderRadius: radius.pill, alignSelf: "flex-start" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  segmented: { flexDirection: "row", borderRadius: radius.md, padding: space.xxs, gap: space.xxs },
  segment: { flex: 1, minHeight: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
});
