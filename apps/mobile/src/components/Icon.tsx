// NAVIA icon set: 24×24 grid, 2 pt round strokes, one visual language.
import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type IconName =
  | "search" | "back" | "close" | "chevronRight" | "settings" | "layers" | "locate" | "locateFilled"
  | "info" | "mic" | "send" | "refresh" | "star" | "home" | "work" | "clock" | "pin" | "car" | "walk"
  | "shelter" | "resilience" | "fuel" | "charger" | "pharmacy" | "hospital" | "atm" | "water" | "food"
  | "shop" | "transport" | "satellite" | "alert" | "check" | "sparkle" | "volume" | "plus" | "minus"
  | "compass" | "route" | "user" | "globe" | "moon" | "shield" | "phone" | "eye" | "traffic";

type Props = { name: IconName; size?: number; color: string; strokeWidth?: number };

export function Icon({ name, size = 24, color, strokeWidth = 2 }: Props): JSX.Element {
  const s = { stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const f = { fill: color };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {glyph(name, s, f)}
    </Svg>
  );
}

type Stroke = { stroke: string; strokeWidth: number; strokeLinecap: "round"; strokeLinejoin: "round"; fill: string };

function glyph(name: IconName, s: Stroke, f: { fill: string }): JSX.Element {
  switch (name) {
    case "search": return <><Circle cx="10.5" cy="10.5" r="6.5" {...s} /><Path d="M15.5 15.5 20 20" {...s} /></>;
    case "back": return <Path d="M15 5l-7 7 7 7" {...s} />;
    case "close": return <Path d="M6 6l12 12M18 6 6 18" {...s} />;
    case "chevronRight": return <Path d="M9 5l7 7-7 7" {...s} />;
    case "settings": return <><Circle cx="12" cy="12" r="3" {...s} /><Path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" {...s} /></>;
    case "layers": return <><Path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" {...s} /><Path d="m2.5 12.5 9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5" {...s} /></>;
    case "locate": return <Path d="M20.5 3.5 3.5 10.6l7 2.9 2.9 7L20.5 3.5Z" {...s} />;
    case "locateFilled": return <Path d="M20.5 3.5 3.5 10.6l7 2.9 2.9 7L20.5 3.5Z" {...s} fill={s.stroke} />;
    case "info": return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M12 11v6" {...s} /><Circle cx="12" cy="7.5" r="1.2" {...f} /></>;
    case "mic": return <><Rect x="9" y="3" width="6" height="11" rx="3" {...s} /><Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...s} /></>;
    case "send": return <Path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" {...s} />;
    case "refresh": return <><Path d="M20 12a8 8 0 1 1-2.35-5.65" {...s} /><Path d="M20 4v5h-5" {...s} /></>;
    case "star": return <Path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" {...s} />;
    case "home": return <><Path d="M3.5 11 12 4l8.5 7" {...s} /><Path d="M5.5 9.5V20h13V9.5M10 20v-5h4v5" {...s} /></>;
    case "work": return <><Rect x="3" y="7" width="18" height="13" rx="2" {...s} /><Path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M3 12.5h18" {...s} /></>;
    case "clock": return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M12 7v5l3 2" {...s} /></>;
    case "pin": return <><Path d="M12 21s-7-6.1-7-11.5a7 7 0 1 1 14 0C19 14.9 12 21 12 21Z" {...s} /><Circle cx="12" cy="9.5" r="2.5" {...s} /></>;
    case "car": return <><Path d="M4 16v-4l2-5.5A2 2 0 0 1 7.9 5h8.2a2 2 0 0 1 1.9 1.5L20 12v4" {...s} /><Path d="M3 16h18v2.5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1V18h-11v.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V16ZM4 12h16" {...s} /></>;
    case "walk": return <><Circle cx="13" cy="4.5" r="1.8" {...s} /><Path d="m9 21 2.5-6.5 3 3V21M8 11.5l2.5-3.5 3.5 1 2.5 3.5M11.5 14.5 10.5 8" {...s} /></>;
    case "shelter": return <><Path d="M3.5 10.5 12 4l8.5 6.5V20h-17v-9.5Z" {...s} /><Path d="M12 10.5v6M9 13.5h6" {...s} /></>;
    case "resilience": return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M13 6.5 9 13h3.5l-1 4.5L15.5 11H12l1-4.5Z" {...s} /></>;
    case "fuel": return <><Path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h6A1.5 1.5 0 0 1 14 5.5V20M3.5 20h12M5 11h9" {...s} /><Path d="M14 9.5h1.8a1.7 1.7 0 0 1 1.7 1.7v4.3a1.5 1.5 0 0 0 3 0V8l-2.5-2.5" {...s} /></>;
    case "charger": return <><Path d="M13 3 6.5 13.5h5L10.5 21 17.5 10h-5L13 3Z" {...s} /></>;
    case "pharmacy": return <><Rect x="3.5" y="3.5" width="17" height="17" rx="4" {...s} /><Path d="M12 8v8M8 12h8" {...s} /></>;
    case "hospital": return <><Rect x="3.5" y="3.5" width="17" height="17" rx="4" {...s} /><Path d="M9 8v8M15 8v8M9 12h6" {...s} /></>;
    case "atm": return <><Rect x="3" y="6" width="18" height="12" rx="2" {...s} /><Circle cx="12" cy="12" r="2.5" {...s} /><Path d="M6.5 9.5h.01M17.5 14.5h.01" {...s} /></>;
    case "water": return <Path d="M12 3.5s-6 6.7-6 11a6 6 0 0 0 12 0c0-4.3-6-11-6-11Z" {...s} />;
    case "food": return <><Path d="M7 3v7a2 2 0 0 0 4 0V3M9 12v9M16.5 21V3c-2 1-3 3.5-3 6.5V13h3" {...s} /></>;
    case "shop": return <><Path d="M4 8h16l-1.2 11.2A2 2 0 0 1 16.8 21H7.2a2 2 0 0 1-2-1.8L4 8Z" {...s} /><Path d="M9 10V6.5a3 3 0 0 1 6 0V10" {...s} /></>;
    case "transport": return <><Rect x="5" y="3.5" width="14" height="14" rx="3" {...s} /><Path d="M5 11h14M8.5 21l1.5-3.5M15.5 21 14 17.5" {...s} /><Circle cx="9" cy="14.3" r=".9" {...f} /><Circle cx="15" cy="14.3" r=".9" {...f} /></>;
    case "satellite": return <><Path d="m13.5 10.5 3-3M7 8l2.5-2.5 3 3L10 11M13 16l2.5-2.5 3 3L16 19" {...s} /><Path d="M4 20a6 6 0 0 0 6-6M4 16.5A2.5 2.5 0 0 0 6.5 14" {...s} /></>;
    case "alert": return <><Path d="M12 4 2.8 19.5h18.4L12 4Z" {...s} /><Path d="M12 10v4.5" {...s} /><Circle cx="12" cy="17" r="1.1" {...f} /></>;
    case "check": return <Path d="m5 12.5 4.5 4.5L19 7.5" {...s} />;
    case "sparkle": return <Path d="M12 3.5c.7 4.2 2.3 5.8 6.5 6.5-4.2.7-5.8 2.3-6.5 6.5-.7-4.2-2.3-5.8-6.5-6.5 4.2-.7 5.8-2.3 6.5-6.5ZM18.5 15.5c.3 1.7.9 2.3 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.2 2.2-.8 2.5-2.5Z" {...s} />;
    case "volume": return <><Path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" {...s} /><Path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" {...s} /></>;
    case "plus": return <Path d="M12 5v14M5 12h14" {...s} />;
    case "minus": return <Path d="M5 12h14" {...s} />;
    case "compass": return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M12 5.5 14.5 12h-5L12 5.5Z" fill={s.stroke} stroke={s.stroke} strokeWidth={1} strokeLinejoin="round" /><Path d="M12 18.5 9.5 12h5L12 18.5Z" {...s} strokeWidth={1} /></>;
    case "route": return <><Circle cx="6" cy="18" r="2.2" {...s} /><Circle cx="18" cy="6" r="2.2" {...s} /><Path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" {...s} /></>;
    case "user": return <><Circle cx="12" cy="8.5" r="4" {...s} /><Path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" {...s} /></>;
    case "globe": return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M3 12h18M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9S9.5 5.6 12 3Z" {...s} /></>;
    case "moon": return <Path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" {...s} />;
    case "shield": return <Path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" {...s} />;
    case "traffic": return <><Path d="M8.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 18V4a1.5 1.5 0 0 1 1.5-1.5ZM12 19.5v2.5" {...s} /><Circle cx="12" cy="6.5" r="1.6" {...s} /><Circle cx="12" cy="11" r="1.6" {...s} /><Circle cx="12" cy="15.5" r="1.6" {...s} /></>;
    case "phone": return <Path d="M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" {...s} />;
    case "eye": return <><Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" {...s} /><Circle cx="12" cy="12" r="3" {...s} /></>;
  }
}
