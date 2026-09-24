// NAVIA design tokens. Every colour, size, spacing, radius, shadow and motion
// value used by screens comes from here — screens must not hardcode them.
import { Easing, Platform, StyleSheet, type TextStyle, type ViewStyle } from "react-native";

export type ColorScheme = "light" | "dark";

export type ThemeColors = {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceMuted: string;
  border: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentPressed: string;
  accentSoft: string;
  onAccent: string;
  brandTeal: string;
  brandOrange: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  critical: string;
  criticalSoft: string;
  onCritical: string;
  routeLine: string;
  routeCasing: string;
  routeTraveled: string;
  mapHalo: string;
  scrim: string;
  pressed: string;
  disabled: string;
  shadow: string;
};

const light: ThemeColors = {
  background: "#F4F6F8",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfaceMuted: "#EDF1F4",
  border: "#DDE3E8",
  divider: "#E6EAEE",
  textPrimary: "#0E1A24",
  textSecondary: "#4A5A67",
  textMuted: "#788793",
  accent: "#00857E",
  accentPressed: "#006B65",
  accentSoft: "#DDF4F2",
  onAccent: "#FFFFFF",
  brandTeal: "#00D3C7",
  brandOrange: "#FFA463",
  success: "#15925A",
  successSoft: "#DDF3E7",
  warning: "#C77A00",
  warningSoft: "#FDF0D9",
  critical: "#D2363C",
  criticalSoft: "#FCE3E4",
  onCritical: "#FFFFFF",
  routeLine: "#0A9E95",
  routeCasing: "#05625D",
  routeTraveled: "#9AA8B2",
  mapHalo: "rgba(0, 133, 126, 0.16)",
  scrim: "rgba(8, 14, 22, 0.40)",
  pressed: "rgba(14, 26, 36, 0.06)",
  disabled: "#B7C1C9",
  shadow: "#0B1620",
};

const dark: ThemeColors = {
  background: "#0A111C",
  surface: "#121B28",
  surfaceElevated: "#172232",
  surfaceMuted: "#1C2839",
  border: "#26344A",
  divider: "#223043",
  textPrimary: "#F1F5F8",
  textSecondary: "#A8B5C3",
  textMuted: "#768699",
  accent: "#3FE0D3",
  accentPressed: "#2BC3B7",
  accentSoft: "#133A3B",
  onAccent: "#062321",
  brandTeal: "#00D3C7",
  brandOrange: "#FFA463",
  success: "#3CC983",
  successSoft: "#15342A",
  warning: "#F2B33D",
  warningSoft: "#3A2F17",
  critical: "#FF6B6F",
  criticalSoft: "#3D1D24",
  onCritical: "#FFFFFF",
  routeLine: "#3FE0D3",
  routeCasing: "#0B4744",
  routeTraveled: "#5D6B7C",
  mapHalo: "rgba(63, 224, 211, 0.20)",
  scrim: "rgba(0, 0, 0, 0.55)",
  pressed: "rgba(241, 245, 248, 0.08)",
  disabled: "#46546A",
  shadow: "#000000",
};

export const palettes: Record<ColorScheme, ThemeColors> = { light, dark };

/** 8-pt grid (with the 4/12 half-steps). */
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

export const hairline = StyleSheet.hairlineWidth;
export const borderWidth = { hairline, regular: 1, strong: 2 } as const;

export const iconSize = { sm: 16, md: 20, lg: 24, xl: 32 } as const;

/** Minimum touch target (Apple HIG). */
export const touchTarget = 44;

// System font: SF Pro on iOS, Roboto on Android.
const family = Platform.select({ ios: undefined, android: "sans-serif", default: undefined });

function type(size: number, lineHeight: number, weight: TextStyle["fontWeight"], extra: TextStyle = {}): TextStyle {
  return { fontFamily: family, fontSize: size, lineHeight, fontWeight: weight, ...extra };
}

const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

export const typography = {
  largeTitle: type(30, 36, "700", { letterSpacing: -0.4 }),
  title: type(22, 28, "700", { letterSpacing: -0.2 }),
  headline: type(17, 22, "600"),
  body: type(16, 22, "400"),
  bodyStrong: type(16, 22, "600"),
  callout: type(15, 20, "400"),
  subhead: type(14, 19, "500"),
  caption: type(12, 16, "500"),
  overline: type(12, 16, "600", { letterSpacing: 0.4 }),
  button: type(16, 20, "600"),
  chip: type(14, 18, "600"),
  numeric: type(22, 26, "700", tabular),
  numericSmall: type(15, 20, "600", tabular),
  maneuverDistance: type(34, 38, "700", { ...tabular, letterSpacing: -0.5 }),
  maneuverStreet: type(20, 25, "600"),
  display: type(40, 44, "800", { letterSpacing: 6 }),
} as const;

export type TypographyVariant = keyof typeof typography;

export function elevation(level: 0 | 1 | 2 | 3, colors: ThemeColors): ViewStyle {
  if (level === 0) return {};
  const spec = { 1: [2, 6, 0.08, 2], 2: [6, 16, 0.12, 6], 3: [10, 28, 0.18, 12] }[level] as [number, number, number, number];
  return {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: spec[0] },
    shadowRadius: spec[1],
    shadowOpacity: spec[2],
    elevation: spec[3],
  };
}

export const motion = {
  fast: 200,
  normal: 300,
  slow: 400,
  camera: 1200,
} as const;

export const easing = {
  standard: Easing.bezier(0.2, 0, 0, 1),
  decelerate: Easing.bezier(0, 0, 0, 1),
  accelerate: Easing.bezier(0.3, 0, 1, 1),
} as const;
