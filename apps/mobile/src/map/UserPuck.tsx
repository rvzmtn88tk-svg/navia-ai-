// The user's position on the map: the NAVIA logo pointing along the heading,
// on a white disc, over a soft accuracy halo and a slow pulse. Position and
// heading are interpolated between GPS fixes so the logo glides instead of
// jumping; heading turns along the shortest arc.
import React, { useEffect, useMemo, useRef, useState } from "react";
import MapLibreGL from "@maplibre/maplibre-react-native";
import { useColors } from "../components/ui";
import type { UserPosition } from "./NaviaMap";
import { feedCourse, lastHeading, recordHeadingLatency, subscribeHeading, type HeadingReading } from "../sensors/deviceHeading";

export type PuckQuality = "good" | "degraded" | "lost";

const GLIDE_MS = 900;
const FRAME_MS = 33; // ~30 fps is smooth for a marker and light on the bridge
const PULSE_MS = 2400;

function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Position glides between GPS fixes (1 Hz); heading is NOT glided — it is
 * applied as it arrives (the compass updates on every 1° of rotation). */
export function useGlide(target: UserPosition): UserPosition {
  const [current, setCurrent] = useState(target);
  const from = useRef(target);
  const shown = useRef(target);
  useEffect(() => {
    from.current = shown.current;
    const start = Date.now();
    // A jump over ~200 m is a relocation, not motion: snap instead of sliding.
    const jumpM = Math.hypot((target.lat - from.current.lat) * 111_320, (target.lon - from.current.lon) * 111_320 * Math.cos(target.lat * Math.PI / 180));
    if (jumpM > 200) { shown.current = target; setCurrent(target); return; }
    const timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - start) / GLIDE_MS);
      const e = 1 - Math.pow(1 - k, 2);
      const next: UserPosition = {
        lat: from.current.lat + (target.lat - from.current.lat) * e,
        lon: from.current.lon + (target.lon - from.current.lon) * e,
        headingDeg: target.headingDeg,
        accuracyM: target.accuracyM,
      };
      shown.current = next;
      setCurrent(next);
      if (k >= 1) clearInterval(timer);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [target.lat, target.lon, target.accuracyM]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...current, headingDeg: target.headingDeg };
}

/** Marker heading: compass + gyroscope fused (see sensors/headingFusion),
 * GPS course only as a fallback when the phone has no compass. Applied per
 * sensor event (≈30 Hz) with no animation, without re-rendering screens. */
/** `live`: follow where the phone points (compass + gyro); otherwise the
 * arrow stays on the given course (route direction) and does not move with
 * the phone. */
function useMarkerHeading(courseDeg: number | null, speedMps: number | null, live: boolean): number | null {
  const [reading, setReading] = useState<HeadingReading | null>(() => (live ? lastHeading() : null));
  const pendingAt = useRef<number | null>(null);
  useEffect(() => {
    if (!live) { setReading(null); return undefined; }
    setReading(lastHeading());
    return subscribeHeading((r) => { pendingAt.current = r.at; setReading(r); });
  }, [live]);
  useEffect(() => { if (live) feedCourse(courseDeg, speedMps); }, [courseDeg, speedMps, live]);
  const deg = live ? reading?.deg ?? courseDeg : courseDeg;
  // Latency: sensor event → this marker's new heading committed.
  useEffect(() => {
    if (pendingAt.current != null) { recordHeadingLatency(Date.now() - pendingAt.current, deg); pendingAt.current = null; }
  }, [reading]); // eslint-disable-line react-hooks/exhaustive-deps
  return deg;
}

function usePulse(): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setPhase(((Date.now() - start) % PULSE_MS) / PULSE_MS), 50);
    return () => clearInterval(timer);
  }, []);
  return phase;
}

/** `billboard`: in 3D the disc and arrow face the screen (not laid flat on
 * the tilted ground), so they stay readable at any camera pitch. The puck is
 * the last layer on the map: above buildings, route and labels. */
export const UserPuck = React.memo(function UserPuck({ position, quality, billboard = false, speedMps = null, headingMode = "device" }: {
  position: UserPosition; quality: PuckQuality; billboard?: boolean;
  /** "device": where the phone points; "course": the direction of travel (static). */
  headingMode?: "device" | "course";
  /** For the GPS-course fallback. */
  speedMps?: number | null;
}): JSX.Element {
  const c = useColors();
  const heading = useMarkerHeading(position.headingDeg, speedMps, headingMode === "device");
  const shown = { ...useGlide(position), headingDeg: heading };
  const pulse = usePulse();
  const tone = quality === "good" ? c.accent : quality === "degraded" ? c.warning : c.critical;
  const shape = useMemo(() => ({
    type: "Feature" as const,
    properties: { heading: shown.headingDeg ?? 0, hasHeading: shown.headingDeg != null },
    geometry: { type: "Point" as const, coordinates: [shown.lon, shown.lat] },
  }), [shown.lat, shown.lon, shown.headingDeg]);

  // Accuracy radius in metres → pixels: at zoom z one pixel covers
  // 156543·cos(lat)/2^z metres. Exponential base-2 interpolation reproduces it.
  const metresPerPixelZ0 = 156543.03 * Math.cos(shown.lat * Math.PI / 180);
  const accuracy = Math.max(8, Math.min(shown.accuracyM ?? 15, 250));
  const radiusZ0 = accuracy / metresPerPixelZ0;

  return (
    <>
      <MapLibreGL.Images images={{ naviaMark: require("../../assets/navia-mark.png") }} />
      <MapLibreGL.ShapeSource id="navia-user" shape={shape}>
        <MapLibreGL.CircleLayer id="navia-user-accuracy" style={{
          circleRadius: ["interpolate", ["exponential", 2], ["zoom"], 0, radiusZ0, 22, radiusZ0 * Math.pow(2, 22)],
          circleColor: tone, circleOpacity: 0.12, circleStrokeColor: tone, circleStrokeOpacity: 0.25, circleStrokeWidth: 1,
          circlePitchAlignment: "map",
        }} />
        <MapLibreGL.CircleLayer id="navia-user-pulse" style={{
          circleRadius: 22 + pulse * 18, circleColor: tone, circleOpacity: 0.28 * (1 - pulse), circlePitchAlignment: "map",
        }} />
        <MapLibreGL.CircleLayer id="navia-user-disc" style={{
          circleRadius: 20, circleColor: c.surface, circleStrokeColor: tone, circleStrokeWidth: 2.5, circlePitchAlignment: billboard ? "viewport" : "map",
        }} />
        <MapLibreGL.SymbolLayer id="navia-user-logo" style={{
          iconImage: "naviaMark", iconSize: 0.052, iconRotate: ["get", "heading"], iconRotationAlignment: "map",
          iconPitchAlignment: billboard ? "viewport" : "map", iconAllowOverlap: true, iconIgnorePlacement: true,
          iconOpacity: quality === "lost" ? 0.55 : 1,
        }} />
      </MapLibreGL.ShapeSource>
    </>
  );
});
