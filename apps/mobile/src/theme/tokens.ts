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
  /** Navigation maneuver card: deep brand surface with white content, both themes. */
  maneuverCard: string;
  maneuverCardDeep: string;
  onManeuver: string;
  onManeuverSecondary: string;
  onManeuverFaint: string;
  /** Glyph colour on coloured map markers. */
  onMarker: string;
};

// "Lunar" day: cool moon-grey surfaces, navy text, the same teal/orange
// accents as night. The navigation HUD stays deep-space navy in both themes.
const light: ThemeColors = {
  background: "#EDF1F6",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfaceMuted: "#E6ECF3",
  border: "#D3DCE7",
  divider: "#E1E7EF",
  textPrimary: "#0A1628",
  textSecondary: "#42546A",
  textMuted: "#6C7E93",
  accent: "#00978D",
  accentPressed: "#007C74",
  accentSoft: "#D9F3F0",
  onAccent: "#FFFFFF",
  brandTeal: "#00BFB2",
  brandOrange: "#F07F22",
  success: "#12A05E",
  successSoft: "#DAF3E6",
  warning: "#C98400",
  warningSoft: "#FCEFD4",
  critical: "#D8343D",
  criticalSoft: "#FBE1E3",
  onCritical: "#FFFFFF",
  routeLine: "#00B3A7",
  routeCasing: "#034E48",
  routeTraveled: "#9AA9BA",
  mapHalo: "rgba(0, 151, 141, 0.16)",
  scrim: "rgba(5, 10, 20, 0.40)",
  pressed: "rgba(10, 22, 40, 0.06)",
  disabled: "#B5C1CE",
  shadow: "#0A1628",
  maneuverCard: "rgba(8, 16, 30, 0.94)",
  maneuverCardDeep: "rgba(4, 9, 18, 0.96)",
  onManeuver: "#FFFFFF",
  onManeuverSecondary: "rgba(226, 238, 250, 0.86)",
  onManeuverFaint: "rgba(255, 255, 255, 0.30)",
  onMarker: "#FFFFFF",
};

// "Deep Space" night: near-black navy, teal light, solar orange.
const dark: ThemeColors = {
  background: "#050A14",
  surface: "#0B1322",
  surfaceElevated: "#101B2E",
  surfaceMuted: "#142238",
  border: "#1E2F48",
  divider: "#18263B",
  textPrimary: "#EEF4FA",
  textSecondary: "#A3B3C6",
  textMuted: "#6F8298",
  accent: "#3FE0D3",
  accentPressed: "#2BC3B7",
  accentSoft: "#0F3336",
  onAccent: "#04201E",
  brandTeal: "#22D3C5",
  brandOrange: "#FF9A3D",
  success: "#37D98A",
  successSoft: "#0F2E22",
  warning: "#FFC23D",
  warningSoft: "#33280F",
  critical: "#FF5A63",
  criticalSoft: "#3A141B",
  onCritical: "#FFFFFF",
  routeLine: "#3FE0D3",
  routeCasing: "#06343A",
  routeTraveled: "#3A4A63",
  mapHalo: "rgba(63, 224, 211, 0.20)",
  scrim: "rgba(0, 0, 0, 0.55)",
  pressed: "rgba(238, 244, 250, 0.08)",
  disabled: "#3E4D63",
  shadow: "#000000",
  maneuverCard: "rgba(8, 16, 30, 0.94)",
  maneuverCardDeep: "rgba(4, 9, 18, 0.96)",
  onManeuver: "#FFFFFF",
  onManeuverSecondary: "rgba(226, 238, 250, 0.86)",
  onManeuverFaint: "rgba(255, 255, 255, 0.30)",
  onMarker: "#FFFFFF",
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
