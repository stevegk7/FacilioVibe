// capture-smoke (WS-A): the save pipeline with fake blobs against the mock
// appStore (?mock=1 → localStorage KV, in-memory object URLs).
//  - capture row + thumb + per-marker crops + emb.* vectors land in KV
//  - the saved vectors actually match back through loadSiteIndex
//  - the 15s model-load race, lost, persists embeddingStatus:'pending'
import { describe, expect, it } from 'vitest';
import { appStore } from '../api/appStore';
import { saveCapture, type BlobEmbedder } from '../vision/capturePipeline';
import {
  loadSiteIndex,
  type CaptureRow,
  type StoredVector,
} from '../vision/captureStore';
import { dequantize, l2Normalize } from '../vision/quantize';

function mockMode() {
  window.history.replaceState({}, '', '/?mock=1');
}

const jpeg = (label: string) => new Blob([label], { type: 'image/jpeg' });

/** Deterministic per-blob vectors so match results are assertable. */
const VEC_BY_SIZE = new Map<number, Float32Array>();
function fakeVector(seed: number): Float32Array {
  const v = new Float32Array(16);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed * 31 + i * 7) + 1.5;
  return v;
}
const stubEmbedder: BlobEmbedder = {
  modelId: 'stub-test',
  async embedBlob(blob) {
    const hit = VEC_BY_SIZE.get(blob.size);
    if (hit) return hit;
    const v = fakeVector(blob.size);
    VEC_BY_SIZE.set(blob.size, v);
    return v;
  },
};

function cosine(a: Float32Array, b: Float32Array): number {
  const na = l2Normalize(a);
  const nb = l2Normalize(b);
  let dot = 0;
  for (let i = 0; i < na.length; i++) dot += na[i] * nb[i];
  return dot;
}

describe('capture save pipeline (mock mode)', () => {
  it('uploads photo+thumb+crops, writes the capture row and emb.* vectors', async () => {
    mockMode();

    const markers = [
      { assetId: 3001, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } },
      { assetId: 3002, rect: { x: 0.55, y: 0.4, w: 0.35, h: 0.4 } },
    ];
    const row = await saveCapture(
      {
        photo: jpeg('full-photo-bytes'),
        markers,
        siteId: 1001,
        spaceName: 'Server Room',
        geo: { lat: 12.97, lng: 77.59, accuracy: 30, at: 1755000000000 },
      },
      {
        id: 'cap-a',
        thumbFn: async () => jpeg('thumb'),
        // crop content differs per marker so each vector is distinct
        cropFn: async (_photo, rect) => jpeg(`crop@${rect.x}`),
        loadEmbed: async () => stubEmbedder,
      },
    );

    expect(row.embeddingStatus).toBe('done');

    // capture row landed under capture.<id> with all four uploads recorded
    const stored = await appStore.kvGet<CaptureRow>('surveys', 'capture.cap-a');
    expect(stored).not.toBeNull();
    expect(typeof stored?.photoFileId).toBe('number');
    expect(typeof stored?.thumbFileId).toBe('number');
    expect(stored?.thumbFileId).not.toBe(stored?.photoFileId);
    expect(stored?.spaceName).toBe('Server Room');
    expect(stored?.geo?.lat).toBe(12.97);
    expect(stored?.markers).toHaveLength(2);
    const cropIds = (stored?.markers ?? []).map((m) => m.cropFileId);
    expect(new Set([stored?.photoFileId, stored?.thumbFileId, ...cropIds]).size).toBe(4);

    // vectors landed under emb.<siteId>.<captureId>.<markerIdx>, modelId-stamped
    const vecs = await appStore.kvList<StoredVector>('surveys', 'emb.1001.cap-a.');
    expect(vecs.map((e) => e.key).sort()).toEqual(['emb.1001.cap-a.0', 'emb.1001.cap-a.1']);
    for (const { value } of vecs) {
      expect(value.modelId).toBe('stub-test');
      expect(value.captureId).toBe('cap-a');
      expect(value.dim).toBe(16);
      expect(typeof value.q).toBe('string');
      expect(value.s).toBeGreaterThan(0);
    }
    const v0 = vecs.find((e) => e.key.endsWith('.0'))!.value;
    expect(v0.assetId).toBe(3001);

    // int8 quantization round-trips: stored vector ≈ the embedded one
    const original = await stubEmbedder.embedBlob(jpeg('crop@0.1'));
    expect(cosine(dequantize(v0), original)).toBeGreaterThan(0.99);

    // and the site index built from KV matches the crop back to its asset
    const index = await loadSiteIndex(1001, 'stub-test');
    expect(index.size).toBe(2);
    const top = index.search(original, 3);
    expect(top[0]?.assetId).toBe(3001);
  });

  it('model-load race lost → capture persists with embeddingStatus pending, no vectors', async () => {
    mockMode();

    const row = await saveCapture(
      {
        photo: jpeg('photo-two'),
        markers: [{ assetId: 3004, rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } }],
        siteId: 1002,
      },
      {
        id: 'cap-b',
        thumbFn: async () => jpeg('thumb-two'),
        cropFn: async () => jpeg('crop-two'),
        // the model never loads — the 15s race (shrunk to 25ms here) must win
        loadEmbed: () => new Promise<BlobEmbedder>(() => {}),
        modelTimeoutMs: 25,
      },
    );

    expect(row.embeddingStatus).toBe('pending');

    const stored = await appStore.kvGet<CaptureRow>('surveys', 'capture.cap-b');
    expect(stored?.embeddingStatus).toBe('pending');
    // photo, thumb and the crop still made it — only the vectors are deferred
    expect(typeof stored?.photoFileId).toBe('number');
    expect(typeof stored?.markers[0]?.cropFileId).toBe('number');
    expect(await appStore.kvList('surveys', 'emb.1002.cap-b.')).toHaveLength(0);
  });
});
