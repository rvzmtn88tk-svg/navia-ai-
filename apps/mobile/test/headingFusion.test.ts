// "Me on the map" heading follows the device (compass + gyro), not the GPS
// course: rotating in place changes the output while GPS stays the same.
import test from "node:test";
import assert from "node:assert/strict";
import { HeadingFusion, yawRateFromMotion } from "../src/sensors/headingFusion";

const near = (a: number, b: number, tol: number) => Math.abs(((a - b + 540) % 360) - 180) <= tol;

test("turning in place: output follows the compass, GPS course (fixed, 90°) is ignored", () => {
  const f = new HeadingFusion();
  f.onCourse(90, 0, 0); // standing; the course says east
  const log: string[] = [];
  // Compass rotates 0° → 180° over 3 s (20 Hz), GPS never changes.
  for (let i = 0; i <= 60; i++) {
    const t = i * 50;
    const compass = (i * 3) % 360;
    f.onCompass(compass, 5, t);
    const out = f.current(t);
    if (i % 10 === 0) log.push(`t=${t}ms compass=${compass}° → map=${out.deg?.toFixed(1)}° (${out.source})`);
    assert.equal(out.source, "COMPASS");
    assert.ok(near(out.deg!, compass, 12), `t=${t}: map ${out.deg} vs compass ${compass}`);
  }
  console.log(log.join("\n"));
});

test("gyro moves the marker between compass readings (no waiting for the compass)", () => {
  const f = new HeadingFusion();
  f.onGyro(0, 0);
  f.onCompass(0, 5, 0);
  // 90°/s clockwise for 0.5 s at 60 Hz, no compass reading in between.
  for (let i = 1; i <= 30; i++) f.onGyro(90, (i * 1000) / 60);
  const out = f.current(500);
  assert.ok(near(out.deg!, 45, 1), `after 0.5 s at 90°/s: ${out.deg}`);
});

test("compass + gyro turning together at 60°/s: map within 2° of the true heading", () => {
  const f = new HeadingFusion();
  let worst = 0;
  for (let i = 0; i <= 180; i++) {
    const t = (i * 1000) / 60;
    const truth = (60 * t) / 1000;
    f.onGyro(60, t);
    if (i % 3 === 0) f.onCompass(truth, 5, t); // compass 20 Hz
    worst = Math.max(worst, Math.abs(((f.current(t).deg! - truth + 540) % 360) - 180));
  }
  console.log(`rotating 60°/s: worst error ${worst.toFixed(2)}°`);
  assert.ok(worst <= 2);
});

test("compass corrects gyro drift", () => {
  const f = new HeadingFusion();
  f.onGyro(0, 0);
  f.onCompass(100, 5, 0);
  for (let i = 1; i <= 60; i++) { f.onGyro(3, i * 16.7); if (i % 3 === 0) f.onCompass(100, 5, i * 16.7); }
  assert.ok(near(f.current(1000).deg!, 100, 2), `drift corrected: ${f.current(1000).deg}`);
});

test("no compass: GPS course is used and labelled GPS_COURSE_FALLBACK", () => {
  const f = new HeadingFusion();
  f.onCourse(250, 12, 0);
  assert.deepEqual(f.current(10), { deg: 250, source: "GPS_COURSE_FALLBACK" });
  f.onCompass(10, 5, 20);
  assert.equal(f.current(30).source, "COMPASS");
  assert.equal(f.current(5000).source, "GPS_COURSE_FALLBACK", "compass stale → fallback");
});

test("yaw rate from device motion works flat and upright (in a car mount)", () => {
  // Flat, screen up: gravity (0,0,-1). Clockwise from above = negative z rotation.
  assert.ok(near(yawRateFromMotion({ x: 0, y: 0, z: -30 }, { x: 0, y: 0, z: -1 })!, 30, 0.01));
  // Upright portrait in a mount: gravity (0,-1,0). Turning the car clockwise = negative y rotation.
  assert.ok(near(yawRateFromMotion({ x: 0, y: -30, z: 0 }, { x: 0, y: -1, z: 0 })!, 30, 0.01));
});

test("fusion cost per event (CPU)", () => {
  const f = new HeadingFusion();
  const c0 = process.cpuUsage();
  for (let i = 0; i < 10_000; i++) { f.onGyro(20, i * 16.7); if (i % 3 === 0) f.onCompass(i % 360, 5, i * 16.7); f.current(i * 16.7); }
  const c = process.cpuUsage(c0);
  const usPerEvent = (c.user + c.system) / 10_000;
  console.log(`fusion: ${usPerEvent.toFixed(2)} µs per motion event`);
  assert.ok(usPerEvent < 50);
});
