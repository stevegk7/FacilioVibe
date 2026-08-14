/**
 * Per-device FOV self-calibration.
 *
 * No browser exposes camera intrinsics, so the projection ships with an
 * assumed 68° long-axis FOV — every degree it is wrong slides the overlay
 * against the scene. But the truth is measurable in the field: over a small
 * pan the GYRO reports the rotation in degrees and the IMAGE reports it in
 * pixels; their ratio is the focal length. A few seconds of the normal
 * look-around a technician does anyway calibrates the device for good.
 *
 *   observation:  f_bins = shiftBins / tan(dθ)
 *   focal:        robust median of observations (MAD-filtered)
 *   camera FOV:   hFov = 2·atan((PROFILE_BINS/2) / f_bins)  →  long axis by
 *                 the frame's aspect
 *
 * Accepted only for gentle, level pans (1–8° between samples, small pitch
 * change, decent correlation) — pushing a mid-swing blurred pair in would
 * poison the estimate the projection then trusts forever.
 */
import { PROFILE_BINS, profileShift, type ProfileShift } from './imageShift';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const STORE_KEY = 'fv.cal.fovLong';
const MIN_STEP_DEG = 1;
const MAX_STEP_DEG = 8;
const MAX_PITCH_STEP_DEG = 3;
const MIN_CONFIDENCE = 0.6;
const SAMPLES_TO_CONVERGE = 24;
/** Anything outside this is a broken measurement, not a real phone camera. */
const FOV_MIN = 45;
const FOV_MAX = 90;

let samples: number[] = [];
let calibrated: number | null = null;
let loaded = false;
/** Frame geometry the stored calibration was measured through. */
let calGeom: string | null = null;
/** Frame geometry the camera is delivering now (setCameraGeometry). */
let liveGeom: string | null = null;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    // Legacy calibrations were a bare number with no record of the frame they
    // were measured through — including, on iPad, a zoomed one. They have no
    // geometry, so the first setCameraGeometry() discards them.
    const parsed: unknown = raw.startsWith('{') ? JSON.parse(raw) : Number(raw);
    const v = typeof parsed === 'number' ? parsed : (parsed as { fov?: number })?.fov;
    const geom = typeof parsed === 'object' ? ((parsed as { geom?: string })?.geom ?? null) : null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= FOV_MIN && v <= FOV_MAX) {
      calibrated = v;
      calGeom = geom;
    }
  } catch {
    /* storage unavailable — assumed FOV it is */
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ fov: calibrated, geom: calGeom }));
  } catch {
    /* session-only calibration still helps */
  }
}

/**
 * Declare the frame geometry the camera is now delivering.
 *
 * A focal length measured in pixels is only meaningful for the frame shape it
 * was measured in. When the camera starts handing back a different one — a
 * zoom reset, a constraint change, a different device — the stored FOV
 * describes a lens that is no longer there, and the projection would keep
 * trusting it forever. Discard and re-measure; a few seconds of normal
 * look-around re-converges it.
 */
export function setCameraGeometry(w: number, h: number): void {
  if (!w || !h) return;
  load();
  const geom = `${w}x${h}`;
  if (liveGeom === geom) return;
  liveGeom = geom;
  if (calibrated != null && calGeom !== geom) {
    calibrated = null;
    samples = [];
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing persisted — the in-memory reset is what matters */
    }
  }
}

/** The long-axis FOV the projection should use: calibrated, else the given
 * default (the shipped 68° constant lives in src/ar/projection). */
export function longAxisFovDeg(fallback: number): number {
  load();
  return calibrated ?? fallback;
}

export function isCalibrated(): boolean {
  load();
  return calibrated != null;
}

export interface CalSample {
  prev: Float32Array;
  next: Float32Array;
  /** Heading change between the two frames (deg, wrapped). */
  dHeadingDeg: number;
  dPitchDeg: number;
  /** Portrait: width/height of the capture frame — converts hFov→long axis. */
  frameW: number;
  frameH: number;
}

/**
 * Feed one frame pair. Returns the shift when accepted (diagnostics/tests).
 * Convergence writes the calibration to localStorage and stops accepting.
 */
export function observeCalSample(s: CalSample): ProfileShift | null {
  load();
  if (calibrated != null) return null;
  const step = Math.abs(s.dHeadingDeg);
  if (step < MIN_STEP_DEG || step > MAX_STEP_DEG) return null;
  if (Math.abs(s.dPitchDeg) > MAX_PITCH_STEP_DEG) return null;
  const shift = profileShift(s.prev, s.next);
  if (!shift || shift.confidence < MIN_CONFIDENCE) return null;

  // Panning right (heading +) moves content left (shift −): the signs must
  // disagree or the correlation locked onto something that is not rotation.
  if (Math.sign(shift.shiftBins) === Math.sign(s.dHeadingDeg)) return null;

  const fBins = Math.abs(shift.shiftBins) / Math.tan(step * RAD);
  const hFov = 2 * Math.atan(PROFILE_BINS / 2 / fBins) * DEG;
  // profile spans the frame WIDTH; portrait's long axis is the height
  const t = Math.tan((hFov / 2) * RAD);
  const longTan = s.frameH >= s.frameW ? t * (s.frameH / s.frameW) : t;
  const longFov = 2 * Math.atan(longTan) * DEG;
  if (longFov < FOV_MIN || longFov > FOV_MAX) return null;

  samples.push(longFov);
  if (samples.length >= SAMPLES_TO_CONVERGE) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mad = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[
      Math.floor(sorted.length / 2)
    ];
    const kept = samples.filter((v) => Math.abs(v - median) <= Math.max(2, 3 * mad));
    const keptSorted = [...kept].sort((a, b) => a - b);
    calibrated = keptSorted[Math.floor(keptSorted.length / 2)];
    samples = [];
    // Stamped with the frame it was measured through — see setCameraGeometry.
    calGeom = liveGeom ?? `${s.frameW}x${s.frameH}`;
    persist();
  }
  return shift;
}

/** TEST ONLY. */
export function __resetFovCalForTest(): void {
  samples = [];
  calibrated = null;
  loaded = false;
  calGeom = null;
  liveGeom = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}
