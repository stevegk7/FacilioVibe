// Lifted from asset-lens/src/vision/embedder.ts (NormRect import adapted).
import type { NormRect } from './types';

/**
 * On-device embedding model behind a dynamic import — tfjs + MobileNet live
 * in a lazy chunk loaded only when Capture saves or Scan opens. The mock
 * embedder derives a deterministic vector from crop pixels so capture→scan
 * matching works (and is test-assertable) without any model.
 *
 * NOTE (research-verified): @tensorflow-models/mobilenet wraps v1/v2 only;
 * v2 α=1.0 → 1280-d from model.infer(img, true). Never hardcode the dim —
 * it is PROBED at load.
 */
export interface Embedder {
  modelId: string;
  dim: number;
  backend: string;
  embed(src: CanvasImageSource, srcW: number, srcH: number, crop?: NormRect): Promise<Float32Array>;
}

/**
 * The three backend calls we make on tfjs.
 *
 * They are real exports of @tensorflow/tfjs-core (globals.d.ts) reaching the
 * tfjs entrypoint through a chain of `export *`, but TypeScript 7 does not
 * follow that chain — tfjs-core's index.d.ts opens with an `/// <amd-module>`
 * declaration, which takes it out of the normal resolution path, so the
 * namespace type arrives without them. Runtime is unaffected (Vite resolves
 * the real ESM build), so narrow the three functions we actually call instead
 * of casting the whole namespace to `any` and losing the rest of the types.
 */
interface TfRuntime {
  setBackend(backendName: string): Promise<boolean>;
  ready(): Promise<void>;
  getBackend(): string;
}

let livePromise: Promise<Embedder> | null = null;
let stubInstance: Embedder | null = null;

export function loadEmbedder(mock: boolean): Promise<Embedder> {
  if (mock) {
    stubInstance ??= createStubEmbedder();
    return Promise.resolve(stubInstance);
  }
  livePromise ??= (async () => {
    const tf = (await import('@tensorflow/tfjs')) as unknown as TfRuntime;
    const mobilenet = await import('@tensorflow-models/mobilenet');
    try {
      await tf.setBackend('webgl');
    } catch {
      /* wasm/cpu fallback below */
    }
    await tf.ready();
    const model = await mobilenet.load({ version: 2, alpha: 1.0 });
    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // probe the output dim once
    const probeT = model.infer(canvas, true);
    const dim = probeT.shape[probeT.shape.length - 1] ?? 0;
    probeT.dispose();
    return {
      modelId: 'mnv2_100_224@tfjs',
      dim,
      backend: tf.getBackend(),
      async embed(src, srcW, srcH, crop) {
        const r = crop ?? { x: 0, y: 0, w: 1, h: 1 };
        ctx.drawImage(src, r.x * srcW, r.y * srcH, r.w * srcW, r.h * srcH, 0, 0, 224, 224);
        const t = model.infer(canvas, true);
        const data = await t.data();
        t.dispose();
        return new Float32Array(data);
      },
    };
  })();
  return livePromise;
}

/** Deterministic 64-d embedding from an 8×8 luma grid of the crop (mock/tests). */
function createStubEmbedder(): Embedder {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  return {
    modelId: 'stub-8x8',
    dim: 64,
    backend: 'stub',
    async embed(src, srcW, srcH, crop) {
      // context resolved lazily so merely loading the stub stays jsdom-safe
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('stub embedder needs a 2d canvas');
      const r = crop ?? { x: 0, y: 0, w: 1, h: 1 };
      ctx.drawImage(src, r.x * srcW, r.y * srcH, r.w * srcW, r.h * srcH, 0, 0, 8, 8);
      const px = ctx.getImageData(0, 0, 8, 8).data;
      const v = new Float32Array(64);
      for (let i = 0; i < 64; i++) {
        v[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
      }
      return v;
    },
  };
}
