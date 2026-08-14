// Lifted from asset-lens/src/vision/quality.ts (verbatim thresholds).
/**
 * Cheap frame-quality gates on a 64×64 luma downsample (<5ms): block
 * embedding on dark/blurry/moving frames and surface a hint instead.
 */
export interface FrameQuality {
  luma: number;
  sharpness: number;
  motion: number;
  ok: boolean;
  hint?: 'dark' | 'blur' | 'moving';
}

const N = 64;

export function toTinyLuma(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  work: HTMLCanvasElement,
): Uint8ClampedArray {
  work.width = N;
  work.height = N;
  const ctx = work.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  const out = new Uint8ClampedArray(N * N);
  for (let i = 0; i < N * N; i++) {
    out[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  }
  return out;
}

export function frameQuality(tiny: Uint8ClampedArray, prev: Uint8ClampedArray | null): FrameQuality {
  let sum = 0;
  for (let i = 0; i < tiny.length; i++) sum += tiny[i];
  const luma = sum / tiny.length;

  // mean absolute gradient as a sharpness proxy
  let grad = 0;
  let n = 0;
  for (let y = 0; y < N - 1; y++) {
    for (let x = 0; x < N - 1; x++) {
      const i = y * N + x;
      grad += Math.abs(tiny[i] - tiny[i + 1]) + Math.abs(tiny[i] - tiny[i + N]);
      n += 2;
    }
  }
  const sharpness = grad / n;

  let motion = 0;
  if (prev && prev.length === tiny.length) {
    let d = 0;
    for (let i = 0; i < tiny.length; i++) d += Math.abs(tiny[i] - prev[i]);
    motion = d / tiny.length;
  }

  const hint =
    luma < 40 ? ('dark' as const) : sharpness < 3.5 ? ('blur' as const) : motion > 9 ? ('moving' as const) : undefined;
  return { luma, sharpness, motion, ok: !hint, hint };
}
