// Layout of the radial category menu (components/CategoryWheel.tsx): a ring
// in the middle of the screen (owner's decision 29.09.2026: centred, not
// under the button), inside the safe areas and the side gutters, on every
// phone size.
// Pure, so tests can check it for overlaps on every screen size.

export type WheelItem = { x: number; y: number };
export type WheelGeometry = {
  /** Ring centre in window coordinates. */
  cx: number; cy: number;
  rx: number; ry: number;
  disc: number; labelW: number; labelH: number;
  /** Label font size: smaller on the narrowest phones so single words fit. */
  labelFont: number;
  /** Item centres (disc centre), relative to the ring centre. */
  items: WheelItem[];
};

export const WHEEL_GUTTER = 12;
/**
 * The whole ring with its labels is centred vertically between `safeTop`
 * and the bottom inset. (`_preferredTop`, the button row, is where the ring
 * flies out from — the animation's business, not the layout's.)
 */
export function wheelGeometry(n: number, width: number, height: number, _preferredTop: number, safeTop: number, bottomInset: number): WheelGeometry {
  const narrow = width < 360;
  const disc = narrow ? 40 : 44;
  // One line: short names on the ring ("Незламність"), full ones for VoiceOver.
  const labelW = narrow ? 68 : 76;
  const labelH = 20;
  // A true circle on every phone from 375 pt; the 320-pt iPhone SE (1st gen)
  // is too narrow for 10 labelled items on a circle and gets a slight oval.
  const aspect = narrow ? 1.3 : 1;
  const rx = Math.max(80, Math.min(150, (width - 2 * WHEEL_GUTTER - labelW) / 2));
  const extra = 2 * WHEEL_GUTTER + disc + labelH + 4;
  const available = height - safeTop - bottomInset;
  const ry = Math.max(80, Math.min(rx * aspect, (available - extra) / 2));
  // The block from the top disc to the bottom label, centred in the available height.
  const blockH = 2 * ry + disc + 4 + labelH;
  const topY = safeTop + Math.max(WHEEL_GUTTER, (available - blockH) / 2);
  const cx = width / 2;
  const cy = topY + disc / 2 + ry;
  const items = Array.from({ length: n }, (_, i) => {
    const a = (-90 + (360 * i) / n) * (Math.PI / 180);
    return { x: rx * Math.cos(a), y: ry * Math.sin(a) };
  });
  return { cx, cy, rx, ry, disc, labelW, labelH, labelFont: narrow ? 11 : 12, items };
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Screen rectangles of one item: its disc, and its label under it (at its widest). */
export function itemBoxes(g: WheelGeometry, i: number): { disc: Box; label: Box } {
  const it = g.items[i]!;
  const x = g.cx + it.x, y = g.cy + it.y;
  return {
    disc: { left: x - g.disc / 2, right: x + g.disc / 2, top: y - g.disc / 2, bottom: y + g.disc / 2 },
    label: { left: x - g.labelW / 2, right: x + g.labelW / 2, top: y + g.disc / 2 + 4, bottom: y + g.disc / 2 + 4 + g.labelH },
  };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
