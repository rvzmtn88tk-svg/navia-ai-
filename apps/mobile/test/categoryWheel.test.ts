// Radial category menu layout: on every phone size all categories fit on
// screen (inside the gutters, above the bottom inset) and no two items or
// labels overlap. The screen sizes are the iPhones iOS 15.1+ runs on.
import test from "node:test";
import assert from "node:assert/strict";
import { itemBoxes, overlaps, wheelGeometry, WHEEL_GUTTER } from "../src/places/wheelGeometry";
import { CHIP_CATEGORIES } from "../src/places/categories";

const SCREENS: [string, number, number, number, number][] = [
  // name, width, height, safe top, safe bottom
  ["iPhone SE (1st gen)", 320, 568, 20, 0],
  ["iPhone SE 2/3, 8", 375, 667, 20, 0],
  ["iPhone 13 mini", 375, 812, 50, 34],
  ["iPhone 16e / 14", 390, 844, 47, 34],
  ["iPhone 17 Pro", 402, 874, 62, 34],
  ["iPhone Pro Max", 440, 956, 62, 34],
  ["iPad mini (portrait)", 744, 1133, 24, 20],
];

for (const [name, w, h, top, bottom] of SCREENS) {
  test(`category wheel fits and nothing overlaps: ${name} ${w}×${h}`, () => {
    // The button row sits under the search bar: safe top + search (≈60) + button (48).
    const topY = top + 8 + 56 + 8 + 48;
    const g = wheelGeometry(CHIP_CATEGORIES.length, w, h, topY, top, bottom + 16);
    const items = CHIP_CATEGORIES.map((_, i) => itemBoxes(g, i));
    for (const [i, it] of items.entries()) {
      for (const b of [it.disc, it.label]) {
        assert.ok(b.left >= WHEEL_GUTTER - 0.5 && b.right <= w - WHEEL_GUTTER + 0.5, `${CHIP_CATEGORIES[i]} inside the side gutters (${b.left.toFixed(0)}..${b.right.toFixed(0)})`);
        assert.ok(b.top >= top, `${CHIP_CATEGORIES[i]} below the status bar`);
        assert.ok(b.bottom <= h - bottom - 16 + 0.5, `${CHIP_CATEGORIES[i]} above the bottom inset (${b.bottom.toFixed(0)} > ${h - bottom - 16})`);
      }
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      for (const [x, y] of [[a.disc, b.disc], [a.disc, b.label], [a.label, b.disc], [a.label, b.label]] as const) {
        assert.ok(!overlaps(x, y), `${CHIP_CATEGORIES[i]} and ${CHIP_CATEGORIES[j]} overlap`);
      }
    }
    // Where there is room (every phone but the 320-pt SE) the ring opens under the button, not over the search bar.
    if (h >= 667) assert.ok(g.cy - g.ry - g.disc / 2 >= topY, "ring under the button row");
    // The close button in the middle stays clear of every item.
    const hub = { left: g.cx - 26, right: g.cx + 26, top: g.cy - 26, bottom: g.cy + 26 };
    for (const it of items) assert.ok(!overlaps(it.disc, hub) && !overlaps(it.label, hub), "centre button clear");
  });
}

test("category wheel shows every search category (none dropped)", () => {
  assert.equal(new Set(CHIP_CATEGORIES).size, 10);
  assert.equal(wheelGeometry(CHIP_CATEGORIES.length, 390, 844, 160, 47, 50).items.length, CHIP_CATEGORIES.length);
});
