// CameraVisionEngine — spec section 18 ("CAMERA VISION").
// "Implement architecture now even if production CV model is phase 2...
// Phase 1: simulated detections in Demo Mode." The interface is the real
// production contract; DemoVisionProvider is the Phase 1 implementation,
// and it's honest about it — detections it returns are tied to an actual
// nearby POI (like the HTML prototype's VisionEngine), not random, but the
// bounding box is synthesized (no camera frame is truly analyzed), so this
// is clearly a demo, never mistakeable for the on-device model in section 40's
// terms — see DemoVisionProvider's `source` field.

import type { LatLon } from "./types";
import type { POI } from "./landmark-engine";
import { haversineMeters } from "./geodesy";

export type CameraFrame = {
  timestamp: number;
  width: number;
  height: number;
  /** Real implementations would carry raw pixel data here; omitted in this
   * architecture-only pass since no on-device model consumes it yet. */
};

export type VisionDetection = {
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
  source: "demo" | "on-device-model";
};

export interface VisionProvider {
  analyzeFrame(frame: CameraFrame, context: { position: LatLon; headingDeg: number | null }): Promise<VisionDetection[]>;
}

const DETECTION_RADIUS_M = 150;

/**
 * Phase 1 per spec: ties a "detection" to whichever real nearby POI the
 * current position/heading would plausibly have in view, rather than
 * inventing a label — so LandmarkEngine can honestly combine it with map
 * data per the spec's "Camera detects WOG confidence 0.93 -> LandmarkEngine
 * combines that with map data" example.
 */
export class DemoVisionProvider implements VisionProvider {
  constructor(private pois: POI[]) {}

  async analyzeFrame(frame: CameraFrame, context: { position: LatLon; headingDeg: number | null }): Promise<VisionDetection[]> {
    const nearby = this.pois
      .map((p) => ({ poi: p, distanceM: haversineMeters(context.position, p.location) }))
      .filter((x) => x.distanceM <= DETECTION_RADIUS_M)
      .sort((a, b) => a.distanceM - b.distanceM);

    if (nearby.length === 0) return [];

    const closest = nearby[0]!;
    // Confidence decays with distance — a real proxy for "how legible is
    // this sign from here", within the honesty limits of a demo simulation.
    const confidence = Math.max(0.4, Math.min(0.97, 1 - closest.distanceM / DETECTION_RADIUS_M));
    const cx = frame.width / 2, cy = frame.height / 2;
    const boxSize = Math.max(24, frame.width * 0.15 * (1 - closest.distanceM / DETECTION_RADIUS_M));
    return [
      {
        label: closest.poi.brand ?? closest.poi.name,
        confidence: Number(confidence.toFixed(2)),
        bbox: [cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize],
        source: "demo",
      },
    ];
  }
}
