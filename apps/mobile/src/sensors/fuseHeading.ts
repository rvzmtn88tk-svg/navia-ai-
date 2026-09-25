// Which way the user's marker points. Standing or walking: the phone's
// compass (iOS CoreLocation heading, true north, updated on every 1° of
// rotation). Driving: the GPS course over ground — the phone may sit in a
// mount at any angle, and at speed the course is exact. GPS course is never
// used slow: below walking pace it wanders and lags.

export type HeadingInputs = {
  compassDeg: number | null;
  /** When the compass reading arrived (ms, same clock as `nowMs`). */
  compassAt: number | null;
  /** iOS headingAccuracy in degrees (negative/null = unknown). */
  compassAccuracyDeg: number | null;
  courseDeg: number | null;
  speedMps: number | null;
  nowMs: number;
};

export type FusedHeading = { deg: number | null; source: "compass" | "course" | null };

export const COURSE_MIN_SPEED_MPS = 4; // ≈14 km/h
const COMPASS_MAX_AGE_MS = 1500;
const COMPASS_MAX_ERROR_DEG = 45;

export function fuseHeading(i: HeadingInputs): FusedHeading {
  const courseOk = i.courseDeg != null && Number.isFinite(i.courseDeg) && (i.speedMps ?? 0) >= COURSE_MIN_SPEED_MPS;
  if (courseOk) return { deg: norm(i.courseDeg!), source: "course" };
  const compassOk = i.compassDeg != null && Number.isFinite(i.compassDeg) && i.compassAt != null
    && i.nowMs - i.compassAt <= COMPASS_MAX_AGE_MS
    && (i.compassAccuracyDeg == null || i.compassAccuracyDeg < 0 || i.compassAccuracyDeg <= COMPASS_MAX_ERROR_DEG);
  if (compassOk) return { deg: norm(i.compassDeg!), source: "compass" };
  return { deg: null, source: null };
}

function norm(d: number): number {
  return ((d % 360) + 360) % 360;
}
