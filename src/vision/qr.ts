// Lifted from asset-lens/src/vision/qr.ts; extractAssetId extended for the
// Facilio `facilio_<id>` qrVal format and bare `?asset=` query strings.
/**
 * QR short-circuit: a decoded sticker identifies the exact asset instantly —
 * no AI needed. Native BarcodeDetector where it exists (Android Chrome),
 * bundled jsQR elsewhere (iOS Safari). Decodes off the same downscaled canvas
 * the quality gates use (≤640px).
 */
interface BarcodeDetectorLike {
  detect(
    source: CanvasImageSource,
  ): Promise<{ rawValue: string; cornerPoints?: { x: number; y: number }[] }[]>;
}

export interface QrDecode {
  data: string;
  /** Corner pixels IN `frameW`x`frameH` SPACE (the decode canvas), when the
   * decoder reports them — they let the caller compute the code's angular
   * offset from the camera axis instead of pretending it was dead-centre. */
  corners: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
  } | null;
  frameW: number;
  frameH: number;
}

let detector: BarcodeDetectorLike | null | undefined;
let jsqrMod: typeof import('jsqr') | null = null;

export async function decodeQr(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  work: HTMLCanvasElement,
): Promise<QrDecode | null> {
  if (detector === undefined) {
    detector =
      'BarcodeDetector' in window
        ? new (
            window as unknown as {
              BarcodeDetector: new (o: { formats: string[] }) => BarcodeDetectorLike;
            }
          ).BarcodeDetector({ formats: ['qr_code'] })
        : null;
  }
  const scale = Math.min(1, 640 / srcW);
  work.width = Math.round(srcW * scale);
  work.height = Math.round(srcH * scale);
  const ctx = work.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, work.width, work.height);
  try {
    if (detector) {
      const found = await detector.detect(work);
      const hit = found[0];
      if (!hit?.rawValue) return null;
      const c = hit.cornerPoints;
      return {
        data: hit.rawValue,
        // BarcodeDetector order: top-left, top-right, bottom-right, bottom-left
        corners:
          c && c.length === 4
            ? { topLeft: c[0], topRight: c[1], bottomRight: c[2], bottomLeft: c[3] }
            : null,
        frameW: work.width,
        frameH: work.height,
      };
    }
    jsqrMod ??= await import('jsqr');
    const img = ctx.getImageData(0, 0, work.width, work.height);
    const res = jsqrMod.default(img.data, img.width, img.height, {
      inversionAttempts: 'dontInvert',
    });
    if (!res?.data) return null;
    const loc = res.location;
    return {
      data: res.data,
      corners: loc
        ? {
            topLeft: loc.topLeftCorner,
            topRight: loc.topRightCorner,
            bottomLeft: loc.bottomLeftCorner,
            bottomRight: loc.bottomRightCorner,
          }
        : null,
      frameW: work.width,
      frameH: work.height,
    };
  } catch {
    return null;
  }
}

/**
 * Extract a plausible asset id from a code. Handles, in order:
 *  - the Facilio qrVal format `facilio_<id>` (any digit count)
 *  - bare digit runs of 3+ (short runs are too collision-prone)
 *  - `?asset=` / `?id=` / `?qr=` params on a URL or a bare query string
 *    (explicit params accept any digit count — intent is unambiguous)
 *  - trailing digits on a URL path (3+)
 * Anything else → null.
 */
export function extractAssetId(code: string): number | null {
  const t = code.trim();
  const fac = t.match(/^facilio[_-](\d+)$/i);
  if (fac) return Number(fac[1]);
  if (/^\d{3,}$/.test(t)) return Number(t);
  const fromParams = (params: URLSearchParams): number | null => {
    for (const k of ['asset', 'id', 'qr']) {
      const v = params.get(k);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    return null;
  };
  if (t.startsWith('?')) {
    return fromParams(new URLSearchParams(t));
  }
  try {
    const url = new URL(t);
    const fromQuery = fromParams(url.searchParams);
    if (fromQuery !== null) return fromQuery;
    const m = url.pathname.match(/(\d{3,})(?:\/)?$/);
    if (m) return Number(m[1]);
  } catch {
    /* not a URL */
  }
  return null;
}

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().slice(0, 200);
}
