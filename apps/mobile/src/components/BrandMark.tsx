import React from "react";
import { Image, StyleSheet, View } from "react-native";

/** NAVIA's forward-pointing compass emblem, shared by onboarding and app UI. */
export function BrandMark({ size = 44 }: { size?: number }): JSX.Element {
  return (
    <View style={[styles.frame, { width: size, height: size }]} accessibilityLabel="NAVIA compass logo">
      <Image source={require("../../assets/navia-mark.png")} style={{ width: size, height: size }} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({ frame: { alignItems: "center", justifyContent: "center" } });
