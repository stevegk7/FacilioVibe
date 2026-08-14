/**
 * Horizontal image-shift estimation — the primitive behind two accuracy
 * upgrades:
 *
 *  - FOV SELF-CALIBRATION (src/ar/fovCal): the gyro says how many degrees the
 *    phone turned; the image says how many pixels the scene moved. Their
 *    ratio IS the focal length — measured on THIS device, replacing the
 *    assumed 68° camera constant (each degree of FOV error is overlay slide).
 *
 *  - SUB-FRAME VISUAL Δ (src/ar/relocalize): matching the live frame to the
 *    nearest sweep frame quantizes Δ to the frame spacing (~±14°). Cross-
 *    correlating the two frames' profiles measures the residual rotation
 *    BETWEEN them, taking visual relocalization to a degree or two.
 *
 * A frame is reduced to a 64-bin COLUMN PROFILE (mean luma per column,
 * zero-meaned). Pure rotation about the vertical axis ≈ horizontal image
 * translation, so the best cross-correlation lag between two profiles is the
 * rotation in pixels. Parabolic interpolation around the peak gives
 * sub-bin precision.
 */

export const PROFILE_BINS = 64;
/** Rows sampled for the profile — enough to average out foreground clutter. */
const PROFILE_ROWS = 48;
/** Lags beyond this fraction of the width leave too little overlap to trust. */
const MAX_LAG_FRACTION = 0.5;

/** Column-mean luma profile of a frame, zero-meaned. */
export function columnProfile(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  work: HTMLCanvasElement,
): Float32Array {
  work.width = PROFILE_BINS;
  work.height = PROFILE_ROWS;
  const ctx = work.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, PROFILE_BINS, PROFILE_ROWS);
  const px = ctx.getImageData(0, 0, PROFILE_BINS, PROFILE_ROWS).data;
  const out = new Float32Array(PROFILE_BINS);
  for (let x = 0; x < PROFILE_BINS; x++) {
    let sum = 0;
    for (let y = 0; y < PROFILE_ROWS; y++) {
      const i = (y * PROFILE_BINS + x) * 4;
      sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    }
    out[x] = sum / PROFILE_ROWS;
  }
  let mean = 0;
  for (let x = 0; x < PROFILE_BINS; x++) mean += out[x];
  mean /= PROFILE_BINS;
  for (let x = 0; x < PROFILE_BINS; x++) out[x] -= mean;
  return out;
}

export interface ProfileShift {
  /** Bins the CONTENT of `b` is displaced rightward relative to `a`.
   * (Panning the camera right moves scene content LEFT: negative shift.) */
  shiftBins: number;
  /** Normalized peak correlation, 0..1 — below ~0.5 the scene disagreed. */
  confidence: number;
}

/**
 * Best-lag normalized cross-correlation of two profiles, sub-bin refined.
 * Returns null when either profile is too flat to carry signal (a blank
 * wall cannot vote on rotation).
 */
export function profileShift(a: Float32Array, b: Float32Array): ProfileShift | null {
  const n = Math.min(a.length, b.length);
  const maxLag = Math.floor(n * MAX_LAG_FRACTION);
  const energy = (v: Float32Array) => {
    let e = 0;
    for (let i = 0; i < n; i++) e += v[i] * v[i];
    return e;
  };
  const ea = energy(a);
  const eb = energy(b);
  if (ea < 1e-3 || eb < 1e-3) return null;

  const scores = new Float32Array(2 * maxLag + 1);
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      dot += a[i] * b[j];
      na += a[i] * a[i];
      nb += b[j] * b[j];
    }
    const denom = Math.sqrt(na * nb);
    const score = denom > 1e-6 ? dot / denom : 0;
    scores[lag + maxLag] = score;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (!Number.isFinite(best)) return null;

  // parabolic sub-bin refinement around the peak
  let lag = bestLag;
  const k = bestLag + maxLag;
  if (k > 0 && k < scores.length - 1) {
    const y0 = scores[k - 1];
    const y1 = scores[k];
    const y2 = scores[k + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) lag = bestLag + (0.5 * (y0 - y2)) / denom;
  }
  // best lag satisfies b[i + lag] ≈ a[i] ⇒ b IS a displaced rightward by lag
  return { shiftBins: lag, confidence: Math.max(0, Math.min(1, best)) };
}

/** A profile shift in DEGREES, given the capture frame's horizontal FOV. */
export function shiftDegrees(shiftBins: number, captureHFovDeg: number): number {
  return (shiftBins / PROFILE_BINS) * captureHFovDeg;
}
