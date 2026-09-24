// Large, high-contrast maneuver arrows for the navigation card. One stroke
// style; the active path is solid, road context is faint.
import React from "react";
import Svg, { Circle, Path, Text as SvgText } from "react-native-svg";
import type { Maneuver } from "../voice/guidance";

export function ManeuverIcon({ maneuver, size = 56, color, faint, exit }: { maneuver: Maneuver; size?: number; color: string; faint: string; exit?: number }): JSX.Element {
  const s = { stroke: color, strokeWidth: 3.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const bg = { ...s, stroke: faint, strokeWidth: 3.2 };
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityElementsHidden importantForAccessibility="no">
      {glyph(maneuver, s, bg, color, exit)}
    </Svg>
  );
}

type S = { stroke: string; strokeWidth: number; strokeLinecap: "round"; strokeLinejoin: "round"; fill: string };

function head(x: number, y: number, dir: "up" | "left" | "right" | "down", color: string): JSX.Element {
  const d = {
    up: `M${x - 5} ${y + 5}L${x} ${y}l5 5`,
    left: `M${x + 5} ${y - 5}L${x} ${y}l5 5`,
    right: `M${x - 5} ${y - 5}L${x} ${y}l-5 5`,
    down: `M${x - 5} ${y - 5}L${x} ${y}l5 -5`,
  }[dir];
  return <Path d={d} stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />;
}

function glyph(m: Maneuver, s: S, bg: S, color: string, exit?: number): JSX.Element {
  switch (m) {
    case "straight": case "depart": case "merge":
      return <><Path d="M16 28V5" {...s} />{head(16, 5, "up", color)}</>;
    case "left":
      return <><Path d="M16 28V16" {...bg} /><Path d="M20 28V15a3 3 0 0 0-3-3H6" {...s} />{head(6, 12, "left", color)}</>;
    case "right":
      return <><Path d="M12 28V15a3 3 0 0 1 3-3h11" {...s} />{head(26, 12, "right", color)}</>;
    case "slight_left":
      return <><Path d="M18 28V18L10 8" {...s} /><Path d="M9.5 15V7.5H17" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "slight_right":
      return <><Path d="M14 28V18l8-10" {...s} /><Path d="M15 7.5h7.5V15" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "sharp_left":
      return <><Path d="M20 28V10L8 22" {...s} /><Path d="M8 14v8h8" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "sharp_right":
      return <><Path d="M12 28V10l12 12" {...s} /><Path d="M16 22h8v-8" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "uturn":
      return <><Path d="M20 28V12a6 6 0 0 0-12 0v8" {...s} />{head(8, 21, "down", color)}</>;
    case "exit_left":
      return <><Path d="M20 28V4" {...bg} /><Path d="M20 22c0-6-4-9-11-11" {...s} /><Path d="M9 18v-7h7" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "exit_right":
      return <><Path d="M12 28V4" {...bg} /><Path d="M12 22c0-6 4-9 11-11" {...s} /><Path d="M16 11h7v7" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
    case "roundabout":
      return <>
        <Circle cx="16" cy="13" r="6" {...s} />
        <Path d="M16 28v-9" {...s} />
        {exit ? <SvgText x="16" y="16.5" fontSize="9" fontWeight="700" fill={color} textAnchor="middle">{String(exit)}</SvgText> : null}
      </>;
    case "arrive":
      return <><Path d="M16 29s-8-7-8-14a8 8 0 1 1 16 0c0 7-8 14-8 14Z" {...s} /><Circle cx="16" cy="15" r="3" fill={color} /></>;
  }
}
