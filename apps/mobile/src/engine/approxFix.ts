// Where to draw "you are here" when no fix is good enough for navigation.
//
// The navigation engine trusts only fixes better than ~55 m (turn-by-turn
// needs that). At home the iPhone has the owner's Wi-Fi and gets 10–30 m at
// once; elsewhere — indoors, between buildings, no known Wi-Fi — it often
// reports 65 m or worse for a while. Hiding the position entirely then (no
// dot, no "my location") is worse than showing it with its real error circle.
// So an untrusted fix is still shown when it is plausible: not absurdly
// inaccurate, not stale, and not a physically impossible jump from the last
// shown position (spoofed jumps stay hidden). Navigation keeps using trusted
// fixes only.
import { haversineMeters, type GNSSRawSample } from "@navia/core";

/** Coarser than this is a city-wide guess: not drawn as a position. */
export const APPROX_MAX_ACCURACY_M = 1500;
const MAX_AGE_MS = 15_000;
/** Faster than a car on a motorway after allowing for both error circles = a jump, not movement. */
const MAX_SPEED_MPS = 60;

export function plausibleApproxFix(sample: GNSSRawSample, lastShown: GNSSRawSample | null, nowMs: number): boolean {
  const acc = sample.accuracyM;
  if (acc == null || !Number.isFinite(acc) || acc > APPROX_MAX_ACCURACY_M) return false;
  if (nowMs - sample.timestamp > MAX_AGE_MS) return false;
  if (!lastShown) return true;
  const dtS = Math.max(1, (sample.timestamp - lastShown.timestamp) / 1000);
  // A shown position older than 10 minutes says nothing about where we can be now.
  if (dtS > 600) return true;
  const slack = acc + (lastShown.accuracyM ?? 50);
  return haversineMeters(sample, lastShown) - slack <= MAX_SPEED_MPS * dtS;
}

/** The position to draw: the trusted fix, unless a newer plausible approximate one exists. */
export function shownFix(trusted: GNSSRawSample | null, approx: GNSSRawSample | null): GNSSRawSample | null {
  if (!approx) return trusted;
  if (!trusted) return approx;
  return approx.timestamp > trusted.timestamp + 10_000 ? approx : trusted;
}
