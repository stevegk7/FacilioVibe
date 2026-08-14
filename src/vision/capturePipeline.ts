// The capture save pipeline (roadmap 4): photo+thumb uploaded in PARALLEL,
// then one crop per marker, then each crop embedded behind a model-load race —
// if the model isn't ready in 15s the capture still lands, stamped
// embeddingStatus:'pending', and vectors can be backfilled later.
//
// Every canvas-touching step is injectable so the pipeline runs under jsdom
// with fake blobs (capture-smoke.test.tsx) exactly as it runs on-device.
import { appStore } from '../api/appStore';
import { isMockMode } from '../api/provider';
import type { GeoFix } from '../api/types';
import { cropBlob, makeThumb } from '../components/camera/useCamera';
import { loadEmbedder } from './embedder';
import { quantizeInt8 } from './quantize';
import {
  putCapture,
  putVector,
  type CaptureMarker,
  type CaptureRow,
  type StoredVector,
} from './captureStore';
import type { NormRect } from './types';

export const MODEL_LOAD_TIMEOUT_MS = 15_000;

export interface PendingMarker {
  assetId: number;
  rect: NormRect;
}

export interface CaptureInput {
  photo: Blob;
  markers: PendingMarker[];
  siteId?: number;
  spaceName?: string;
  geo?: GeoFix | null;
}

/** Blob-level embedder — the pipeline never touches canvases directly. */
export interface BlobEmbedder {
  modelId: string;
  embedBlob(blob: Blob): Promise<Float32Array>;
}

export interface CaptureDeps {
  thumbFn?: (photo: Blob) => Promise<Blob>;
  cropFn?: (photo: Blob, rect: NormRect) => Promise<Blob>;
  /** Defaults to the real embedder (stub in mock mode) wrapped for blobs. */
  loadEmbed?: () => Promise<BlobEmbedder>;
  modelTimeoutMs?: number;
  id?: string;
  now?: () => Date;
}

async function defaultLoadEmbed(): Promise<BlobEmbedder> {
  const embedder = await loadEmbedder(isMockMode());
  return {
    modelId: embedder.modelId,
    async embedBlob(blob) {
      const bmp = await createImageBitmap(blob);
      try {
        return await embedder.embed(bmp, bmp.width, bmp.height);
      } finally {
        bmp.close();
      }
    },
  };
}

/** Resolve to null when `p` loses the race — errors also count as a loss. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function makeId(now: Date): string {
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run the whole save: uploads → crops → embeddings → KV. Returns the stored
 * row. Callers invalidate the ['captures'] react-query key afterwards.
 */
export async function saveCapture(
  input: CaptureInput,
  deps: CaptureDeps = {},
): Promise<CaptureRow> {
  const thumbFn = deps.thumbFn ?? makeThumb;
  const cropFn = deps.cropFn ?? ((photo: Blob, rect: NormRect) => cropBlob(photo, rect));
  const loadEmbed = deps.loadEmbed ?? defaultLoadEmbed;
  const timeoutMs = deps.modelTimeoutMs ?? MODEL_LOAD_TIMEOUT_MS;
  const now = deps.now?.() ?? new Date();
  const id = deps.id ?? makeId(now);

  // 1. photo + thumb — in PARALLEL
  const [photoFileId, thumbFileId] = await Promise.all([
    appStore.uploadPhoto(input.photo, `capture-${id}.jpg`),
    thumbFn(input.photo).then((thumb) => appStore.uploadPhoto(thumb, `capture-${id}-thumb.jpg`)),
  ]);

  // 2. one crop per marker
  const crops = await Promise.all(input.markers.map((m) => cropFn(input.photo, m.rect)));
  const cropFileIds = await Promise.all(
    crops.map((crop, i) => appStore.uploadPhoto(crop, `capture-${id}-crop${i}.jpg`)),
  );
  const markers: CaptureMarker[] = input.markers.map((m, i) => ({
    assetId: m.assetId,
    rect: m.rect,
    cropFileId: cropFileIds[i],
  }));

  // 3. embed each crop behind the model-load race
  let embeddingStatus: CaptureRow['embeddingStatus'] = 'done';
  const vectors: StoredVector[] = [];
  if (markers.length > 0) {
    const embedder = await raceTimeout(loadEmbed(), timeoutMs);
    if (!embedder) {
      embeddingStatus = 'pending';
    } else {
      try {
        for (let i = 0; i < crops.length; i++) {
          const vec = await embedder.embedBlob(crops[i]);
          vectors.push({
            assetId: markers[i].assetId,
            captureId: id,
            markerIdx: i,
            modelId: embedder.modelId,
            ...quantizeInt8(vec),
          });
        }
      } catch {
        // any embed failure → whole capture marked pending, no partial index
        embeddingStatus = 'pending';
        vectors.length = 0;
      }
    }
  }

  // 4. write capture + vectors
  const row: CaptureRow = {
    id,
    siteId: input.siteId,
    spaceName: input.spaceName,
    photoFileId,
    thumbFileId,
    markers,
    geo: input.geo ?? null,
    createdAt: now.toISOString(),
    embeddingStatus,
  };
  await putCapture(row);
  for (const v of vectors) {
    await putVector(input.siteId, v);
  }
  return row;
}
