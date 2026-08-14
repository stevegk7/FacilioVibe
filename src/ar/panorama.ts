/**
 * Projecting survey markers onto the sweep photos.
 *
 * A vendor arriving cold gets far more from "here is a photo of the room with
 * the AHU circled" than from an AR overlay they have to earn by standing in
 * the right spot. The sweep already turns on the spot every ~30°, so the
 * frames ARE a rough panorama — they just need to be kept as images and the
 * markers projected back onto them.
 *
 * Everything here is pure so the geometry can be tested without a camera.
 */
import type { Survey, SurveyMarker, SweepFrame } from '../api/types';

/**
 * Horizontal field of view of a typical phone rear camera, in degrees.
 * Frames are captured every ~28°, so a marker usually lands on more than one
 * frame — we show it on the frame it sits closest to the centre of.
 */
export const FRAME_FOV_X = 62;
/** Vertical FOV for a 4:3-ish portrait frame. */
export const FRAME_FOV_Y = 46;

export interface MarkerOnFrame {
  marker: SurveyMarker;
  /** 0..1 across the frame, 0.5 = centre. */
  x: number;
  /** 0..1 down the frame, 0.5 = centre. */
  y: number;
  /** Degrees off the frame's centre — smaller is a better frame for it. */
  offCentre: number;
}

function wrap(deg: number): number {
  return ((deg + 540) % 360) - 180;
}

/** Absolute bearing of a marker (same rule the AR view renders by). */
export function markerBearing(survey: Survey, marker: SurveyMarker): number {
  return ((survey.sweep[0]?.heading ?? 0) + marker.heading + 360) % 360;
}

/** Where a marker falls on one frame, or null when it is outside its view. */
export function projectMarker(
  survey: Survey,
  frame: SweepFrame,
  marker: SurveyMarker,
): MarkerOnFrame | null {
  const dx = wrap(markerBearing(survey, marker) - frame.heading);
  if (Math.abs(dx) > FRAME_FOV_X / 2) return null;
  const dy = marker.pitch - frame.pitch;
  if (Math.abs(dy) > FRAME_FOV_Y / 2) return null;
  return {
    marker,
    x: 0.5 + dx / FRAME_FOV_X,
    // screen y grows downward; looking UP at a marker puts it HIGHER
    y: 0.5 - dy / FRAME_FOV_Y,
    offCentre: Math.abs(dx),
  };
}

/**
 * The markers to draw on each frame.
 *
 * A marker visible on three overlapping frames is drawn only on the one it is
 * most centred in — otherwise the same asset appears three times as you swipe
 * and the panorama stops reading as one room.
 */
export function markersByFrame(survey: Survey): MarkerOnFrame[][] {
  const best = new Map<string, number>(); // marker id -> frame index
  const projected = survey.sweep.map((frame) =>
    survey.markers
      .map((marker) => projectMarker(survey, frame, marker))
      .filter((p): p is MarkerOnFrame => p !== null),
  );

  projected.forEach((list, frameIndex) => {
    for (const hit of list) {
      const incumbent = best.get(hit.marker.id);
      if (incumbent === undefined) {
        best.set(hit.marker.id, frameIndex);
        continue;
      }
      const rival = projected[incumbent].find((p) => p.marker.id === hit.marker.id);
      if (rival && hit.offCentre < rival.offCentre) best.set(hit.marker.id, frameIndex);
    }
  });

  return projected.map((list, frameIndex) =>
    list.filter((hit) => best.get(hit.marker.id) === frameIndex),
  );
}

/** Frames that actually have a stored image, in sweep order. */
export function viewableFrames(survey: Survey): Array<{ frame: SweepFrame; index: number }> {
  return survey.sweep
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => typeof frame.fileId === 'number');
}
