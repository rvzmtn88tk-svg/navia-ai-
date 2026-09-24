// Swaps content with a short fade + rise whenever `contentKey` changes, so
// status text never jumps.
import React, { useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { easing, motion } from "../theme/tokens";

export function Crossfade({ contentKey, children }: { contentKey: string; children: React.ReactNode }): JSX.Element {
  const [shownKey, setShownKey] = useState(contentKey);
  const previousChildren = useRef(children);
  const opacity = useRef(new Animated.Value(1)).current;
  const offset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (contentKey === shownKey) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: motion.fast / 2, easing: easing.accelerate, useNativeDriver: true }),
      Animated.timing(offset, { toValue: -4, duration: motion.fast / 2, easing: easing.accelerate, useNativeDriver: true }),
    ]).start(() => {
      setShownKey(contentKey);
      offset.setValue(4);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: motion.fast, easing: easing.decelerate, useNativeDriver: true }),
        Animated.timing(offset, { toValue: 0, duration: motion.fast, easing: easing.decelerate, useNativeDriver: true }),
      ]).start();
    });
  }, [contentKey, shownKey, opacity, offset]);

  // While fading out, keep showing the old content; afterwards, always the latest.
  const node = contentKey === shownKey ? children : previousChildren.current;
  if (contentKey === shownKey) previousChildren.current = children;
  return <Animated.View style={{ opacity, transform: [{ translateY: offset }] }}>{node}</Animated.View>;
}

/** Animated colour between tone colours (JS-driven; colour cannot use the native driver). */
export function useToneColor(tone: number, colors: string[]): Animated.AnimatedInterpolation<string> {
  const value = useRef(new Animated.Value(tone)).current;
  useEffect(() => {
    Animated.timing(value, { toValue: tone, duration: motion.normal, easing: easing.standard, useNativeDriver: false }).start();
  }, [tone, value]);
  return value.interpolate({ inputRange: colors.map((_, i) => i), outputRange: colors });
}
