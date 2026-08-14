/**
 * FOV-correct perspective projection — the other half of "the pin moved".
 *
 * The old layout mapped degrees to pixels linearly at innerWidth/60: it
 * assumed the screen showed 60° of the world horizontally. A portrait phone
 * camera cropped by object-fit:cover actually shows ~35-40°. The overlay was
 * therefore moving at roughly HALF the speed of the video behind it — pan the
 * phone and the pin visibly slides across the real scene, then "arrives" when
 * the pan stops. No amount of filtering fixes a projection that disagrees
 * with the camera about how big a degree is.
 *
 * This module computes the DISPLAYED field of view from the real video
 * dimensions + the cover crop, and projects marker directions through a true
 * perspective (tangent) camera model, roll included.
 */
import { dirVector, rotateInv, type Quat } from './fusion';

const RAD = Math.PI / 180;

/**
 * Long-axis FOV of a phone main camera delivering video. No browser API
 * exposes intrinsics (W3C mediacapture #416 never shipped) — this is the
 * researched universal fallback: 16:9 main cameras cluster at 65-72° on the
 * long axis; 68° is within ±3° of everything current. Wrong by a few degrees
 * = a slight scale error near the edges; wrong by the 20°+ the old constant
 * was = the slide the user reported.
 */
export const CAMERA_LONG_AXIS_FOV_DEG = 68;

export interface ViewFov {
  /** tan(half horizontal displayed FOV) */
  halfTanX: number;
  /** tan(half vertical displayed FOV) */
  halfTanY: number;
}

/** Fallback when no video metadata exists (desktop, jsdom): the old 60°/75°
 * assumption, so mock mode and tests keep their geometry. */
export function defaultFov(): ViewFov {
  return { halfTanX: Math.tan(30 * RAD), halfTanY: Math.tan(37.5 * RAD) };
}

/**
 * Displayed FOV of a `object-fit: cover` video in a viewport.
 * Crop happens in TANGENT space (the image plane is flat), not in degrees.
 */
export function displayedFov(
  videoW: number,
  videoH: number,
  viewW: number,
  viewH: number,
  longAxisFovDeg = CAMERA_LONG_AXIS_FOV_DEG,
): ViewFov {
  if (!videoW || !videoH || !viewW || !viewH) return defaultFov();
  const longTan = Math.tan((longAxisFovDeg / 2) * RAD);
  // camera-frame half-tangents: long axis carries the assumed FOV, the short
  // axis scales by the sensor crop's aspect
  const camTanY = videoH >= videoW ? longTan : longTan * (videoH / videoW);
  const camTanX = videoH >= videoW ? longTan * (videoW / videoH) : longTan;
  // cover: scale so the video fills, then the overflow is cropped off-screen
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const shownX = Math.min(1, viewW / (videoW * scale));
  const shownY = Math.min(1, viewH / (videoH * scale));
  return { halfTanX: camTanX * shownX, halfTanY: camTanY * shownY };
}

/**
 * FOV of the RAW camera frame (the thing QR decoding sees) — no cover crop,
 * just the sensor's aspect against the long-axis constant. A different pixel
 * space from the displayed view: never mix the two.
 */
export function captureFov(frameW: number, frameH: number, longAxisFovDeg = CAMERA_LONG_AXIS_FOV_DEG): ViewFov {
  const longTan = Math.tan((longAxisFovDeg / 2) * RAD);
  return frameH >= frameW
    ? { halfTanX: longTan * (frameW / frameH), halfTanY: longTan }
    : { halfTanX: longTan, halfTanY: longTan * (frameH / frameW) };
}

export interface QrCorners {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
}

/**
 * Angular offset of a decoded QR from the camera's optical axis.
 *
 * "Wherever the phone pointed when the decode fired" is up to a half-frame
 * (~17°) away from where the QR actually is. The decoder hands back the
 * code's corner pixels; the diagonal intersection is its centre even under
 * perspective, and atan through the focal length turns that into the real
 * angular offset — so a survey's origin is the direction OF THE QR, at
 * enrolment and at every later scan alike.
 */
export function qrAngularOffset(
  corners: QrCorners,
  frameW: number,
  frameH: number,
  fov = captureFov(frameW, frameH),
): { yawDeg: number; pitchDeg: number } {
  const { topLeft: a, bottomRight: c, topRight: b, bottomLeft: d } = corners;
  // intersection of the two diagonals (falls back to the centroid when the
  // quad is degenerate — a decode that bad should not steer anything far)
  const den = (a.x - c.x) * (b.y - d.y) - (a.y - c.y) * (b.x - d.x);
  let cx = (a.x + b.x + c.x + d.x) / 4;
  let cy = (a.y + b.y + c.y + d.y) / 4;
  if (Math.abs(den) > 1e-9) {
    const t = ((a.x - b.x) * (b.y - d.y) - (a.y - b.y) * (b.x - d.x)) / den;
    cx = a.x + t * (c.x - a.x);
    cy = a.y + t * (c.y - a.y);
  }
  const fx = frameW / 2 / fov.halfTanX;
  const fy = frameH / 2 / fov.halfTanY;
  return {
    yawDeg: Math.atan((cx - frameW / 2) / fx) / RAD,
    pitchDeg: Math.atan(-(cy - frameH / 2) / fy) / RAD,
  };
}

export interface Projected {
  /** px from screen centre, +right */
  x: number;
  /** px from screen centre, +down */
  y: number;
  /** true when the direction is in front of the camera and near the frame */
  visible: boolean;
  /** signed horizontal angle to the marker, deg — drives the edge chevrons */
  dxDeg: number;
}

/**
 * Project a stored direction through the camera. One rotation (world→device),
 * one perspective divide — every axis, roll included, nothing bolted on.
 */
export function projectDirection(
  bearingDeg: number,
  pitchDeg: number,
  pose: Quat,
  viewW: number,
  viewH: number,
  fov: ViewFov,
): Projected {
  const v = rotateInv(pose, dirVector(bearingDeg, pitchDeg));
  // device frame: x right, y up, camera looks along -z
  const dxDeg = Math.atan2(v[0], -v[2]) / RAD;
  if (v[2] > -0.05) {
    // beside or behind the camera — never place, only a chevron
    return { x: 0, y: 0, visible: false, dxDeg: v[2] > 0 ? (dxDeg >= 0 ? 120 : -120) : dxDeg };
  }
  const x = ((viewW / 2) * (v[0] / -v[2])) / fov.halfTanX;
  const y = ((viewH / 2) * (-v[1] / -v[2])) / fov.halfTanY;
  // a card slightly past the edge is still "visible" so it eases out instead
  // of popping; beyond the margin the chevron takes over
  const visible = Math.abs(x) <= viewW / 2 + 140 && Math.abs(y) <= viewH / 2 + 160;
  return { x, y, visible, dxDeg };
}
