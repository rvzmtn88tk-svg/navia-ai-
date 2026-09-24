import React from "react";
import {
  Platform,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextInputProps,
  type TextStyle,
  type TextProps,
} from "react-native";

// Use the native iOS system face for clear Ukrainian glyphs and platform
// consistency. Android keeps Roboto. Explicit diagnostic faces still win.
export const APP_FONT_FAMILY = Platform.select({ ios: undefined, android: "sans-serif", default: undefined });

/** Shared type scale for the most important NAVIA text roles. */
export const typography: Record<"display" | "maneuver" | "screenTitle" | "sectionTitle" | "body" | "bodySecondary" | "caption" | "button" | "status" | "navigationValue", TextStyle> = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700", letterSpacing: -0.5 },
  maneuver: { fontSize: 25, lineHeight: 31, fontWeight: "700" },
  screenTitle: { fontSize: 23, lineHeight: 29, fontWeight: "700" },
  sectionTitle: { fontSize: 17, lineHeight: 23, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
  bodySecondary: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "400" },
  button: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  status: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  navigationValue: { fontSize: 24, lineHeight: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
};

function baseStyle(style: TextStyle): TextStyle {
  // Keep each screen's deliberate size, weight, tracking, and line-height.
  // Only provide a platform face when the caller has not chosen one.
  return { ...style, fontFamily: style.fontFamily ?? APP_FONT_FAMILY };
}

function normalizedTextStyle(style: TextProps["style"]): TextProps["style"] {
  const flattened = StyleSheet.flatten(style) ?? {};
  return baseStyle(flattened);
}

function normalizedInputStyle(style: TextInputProps["style"]): TextInputProps["style"] {
  const flattened = StyleSheet.flatten(style) ?? {};
  return baseStyle(flattened);
}

export function AppText(props: TextProps): JSX.Element {
  return <NativeText {...props} style={normalizedTextStyle(props.style)} />;
}

export function AppTextInput(props: TextInputProps): JSX.Element {
  return <NativeTextInput {...props} style={normalizedInputStyle(props.style)} />;
}
