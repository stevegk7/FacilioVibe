// Presence model + decay policy. Decision logic lifted from the watchdog in
// asset-lens src/screens/ScanScreen.tsx:332-355, extracted pure so the
// timings are testable without a camera:
//   - markers belong to the PLACE: without fresh proof of presence they hide
//   - a scanned physical sticker (qr) is far stronger proof than indoor GPS,
//     so it lives 180s vs 20s for visual matches, and the geo distance gate
//     applies ONLY to non-QR presence with an accurate fix (<50m), >100m out
//   - forced presence (no usable Δ source, e.g. room codes) never decays
import type { GeoFix, Survey, SurveyMarker } from '../api/types';
import { haversineMeters } from '../wayfinding/geo';

export interface Presence {
  surveyId: string;
  /** Heading offset to apply to marker directions (relocalization Δ). */
  delta: number;
  /** No usable Δ/decay source — opened by explicit user intent; never decays. */
  forced?: boolean;
  via?: 'qr' | 'visual';
  /**
   * When this proof was established (epoch ms).
   *
   * Decay used to be measured ONLY from the visual relocalizer's last match,
   * so a scanned QR — the strongest proof we have — expired on a clock it
   * never set: pan away, the visual matcher stops matching, and markers
   * vanished under a technician who had not moved. Proof is now whichever is
   * more recent, this or the matcher.
   */
  at?: number;
}

export const QR_STALE_MS = 180_000;
// A visual match is weak proof, but 20s was short enough that simply looking
// at the equipment you came to work on lost the markers.
export const VISUAL_STALE_MS = 45_000;
export const GEO_TRIP_METERS = 100;
export const GEO_ACCURACY_GATE_M = 50;

export type DecayVerdict = { decayed: false } | { decayed: true; reason: 'left-area' | 'stale' };

export function presenceDecayCheck(args: {
  presence: Presence;
  survey: Survey | undefined;
  fix: GeoFix | null;
  /** Relocalizer.lastMatchAt (epoch ms) — 0 means "no proof recorded". */
  lastMatchAt: number;
  now: number;
}): DecayVerdict {
  const { presence, survey, fix, lastMatchAt, now } = args;
  if (presence.forced) return { decayed: false };
  const isQr = presence.via === 'qr';
  const tooFar =
    !isQr && survey?.geo && fix && fix.accuracy < GEO_ACCURACY_GATE_M
      ? haversineMeters(survey.geo, fix) > GEO_TRIP_METERS
      : false;
  if (tooFar) return { decayed: true, reason: 'left-area' };
  const staleMs = isQr ? QR_STALE_MS : VISUAL_STALE_MS;
  // The freshest proof of either kind keeps presence alive.
  const provenAt = Math.max(presence.at ?? 0, lastMatchAt);
  if (provenAt > 0 && now - provenAt > staleMs) return { decayed: true, reason: 'stale' };
  return { decayed: false };
}

/** A visual match's Δ is quantized to the nearest sweep frame (~28° apart),
 * so consecutive estimates can disagree by several degrees while the phone
 * has not moved. Below this, keep the Δ we have — pins must not wobble. */
export const VISUAL_DELTA_HYSTERESIS_DEG = 5;

/**
 * Fold a fresh visual relocalization match into presence.
 *
 * The rules that keep pins STILL:
 *  - a QR Δ is exact (corner-corrected scan) — a visual match may refresh its
 *    CLOCK but never overwrite its Δ. Stomping the exact Δ with a ±14°
 *    frame-quantized guess every 1.5s was the "pointer keeps moving" bug.
 *  - visual-only presence keeps its Δ until the estimate disagrees by more
 *    than the hysteresis — real drift, not quantization noise.
 */
export function refreshedPresence(
  prev: Presence | null,
  match: { surveyId: string; delta: number },
  now: number,
): Presence {
  if (prev && prev.surveyId === match.surveyId) {
    const drift = Math.abs(((match.delta - prev.delta + 540) % 360) - 180);
    const delta =
      prev.via === 'qr' || drift < VISUAL_DELTA_HYSTERESIS_DEG ? prev.delta : match.delta;
    return { ...prev, delta, at: now };
  }
  return { surveyId: match.surveyId, delta: match.delta, via: 'visual', at: now };
}

/**
 * Absolute render bearing for a survey marker. Markers are stored RELATIVE
 * TO SWEEP FRAME 0 (see src/api/types.ts):
 *   abs = (sweep[0].heading + marker.heading + relocΔ + 360) % 360
 */
export function markerAbsBearing(survey: Survey, marker: SurveyMarker, delta: number): number {
  return ((survey.sweep[0]?.heading ?? 0) + marker.heading + delta + 360) % 360;
}

/** Typical distance of pinned room equipment when nothing better is known.
 * Being ±2m wrong still corrects MOST of the parallax at room scale, and
 * distant markers (where the assumption over-corrects) have little parallax
 * to begin with. */
export const DEFAULT_MARKER_RANGE_M = 4;

/**
 * Reproject a marker for a viewer who has WALKED off the standpoint.
 *
 * A stored marker is a ray from the standpoint; standing elsewhere, the same
 * physical object lies in a different direction — that is parallax, and no
 * amount of rotation accuracy fixes it. With the marker's range (measured or
 * assumed) and the viewer's dead-reckoned offset, the object's position is
 * a known point, and the corrected bearing/pitch is plain geometry:
 *
 *   object  = standpoint + range · ray(bearing, pitch)
 *   viewer  = standpoint + (offsetE, offsetN)
 *   render  = direction(viewer → object)
 */
export function parallaxCorrected(
  absBearingDeg: number,
  pitchDeg: number,
  rangeM: number,
  offset: { x: number; y: number },
): { bearing: number; pitch: number } {
  const RAD = Math.PI / 180;
  const horiz = rangeM * Math.cos(pitchDeg * RAD);
  const up = rangeM * Math.sin(pitchDeg * RAD);
  const ox = horiz * Math.sin(absBearingDeg * RAD) - offset.x;
  const oy = horiz * Math.cos(absBearingDeg * RAD) - offset.y;
  const d = Math.hypot(ox, oy);
  if (d < 0.15) {
    // standing (almost) on the object — direction is meaningless, keep as-is
    return { bearing: absBearingDeg, pitch: pitchDeg };
  }
  return {
    bearing: ((Math.atan2(ox, oy) / RAD) % 360 + 360) % 360,
    pitch: Math.atan2(up, d) / RAD,
  };
}
