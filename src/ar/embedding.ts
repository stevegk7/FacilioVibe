// Injectable embedding seam for sweep frames. WS-B ships a deterministic
// 64-d luma stub; the integrator swaps in the real MobileNet embedder from
// src/vision via setEmbedFn() without touching the survey code.
import { quantizeInt8, type QuantVec } from './quant';

export type EmbedFn = (src: CanvasImageSource) => Promise<QuantVec>;

export const EMBED_DIM = 64;
/** Embedder identity stored on each survey — vectors from another model never mix. */
export const EMBED_MODEL_ID = 'luma64-v0';

/**
 * Default stub: 8×8 grayscale downsample of the frame → 64-d vector.
 * Deterministic for a given image; good enough to exercise the whole
 * survey/relocalize pipeline before the MobileNet embedder lands.
 */
export const lumaEmbed: EmbedFn = async (src) => {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) return syntheticVec(0); // jsdom / headless: keep the lane deterministic
  ctx.drawImage(src, 0, 0, 8, 8);
  const { data } = ctx.getImageData(0, 0, 8, 8);
  const v = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    const o = i * 4;
    v[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255 - 0.5;
  }
  return quantizeInt8(v);
};

let currentEmbed: EmbedFn = lumaEmbed;

/** Integrator hook: swap the sweep-frame embedder (e.g. for MobileNet). */
export function setEmbedFn(fn: EmbedFn): void {
  currentEmbed = fn;
}

export function getEmbedFn(): EmbedFn {
  return currentEmbed;
}

/**
 * Direction-coded vector for mock sweeps and tests: a von-Mises-style bump
 * over 64 evenly spaced directions, so nearby headings are cosine-similar
 * and opposite headings are not. Lets relocalization behave sensibly in
 * ?mock=1 where there is no camera at all.
 */
export function syntheticVec(headingDeg: number): QuantVec {
  const v = new Float32Array(EMBED_DIM);
  const theta = (headingDeg * Math.PI) / 180;
  for (let i = 0; i < EMBED_DIM; i++) {
    const phi = (i / EMBED_DIM) * 2 * Math.PI;
    v[i] = Math.exp(3 * (Math.cos(theta - phi) - 1));
  }
  return quantizeInt8(v);
}
