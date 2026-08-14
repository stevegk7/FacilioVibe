// Lifted from asset-lens/src/vision/matcher.ts (types import adapted).
import type { CandidateEmbedding, Match } from './types';
import { dequantize, l2Normalize } from './quantize';

/**
 * Brute-force cosine index over the scan bundle. At realistic scale
 * (≤ a few thousand reference embeddings per site) a contiguous Float32Array
 * arena scan is <5ms — no ANN structure needed.
 */
export interface MatchIndex {
  dim: number;
  size: number;
  search(query: Float32Array, k: number): Match[];
}

export function buildIndex(rows: CandidateEmbedding[]): MatchIndex {
  const usable = rows.filter((r) => r.vec && r.vec.dim > 0);
  const dim = usable[0]?.vec.dim ?? 0;
  const same = usable.filter((r) => r.vec.dim === dim);
  const arena = new Float32Array(same.length * dim);
  same.forEach((r, i) => {
    // rows were normalized before quantization; renormalize to erase int8 error
    const v = l2Normalize(dequantize(r.vec));
    arena.set(v, i * dim);
  });
  return {
    dim,
    size: same.length,
    search(query: Float32Array, k: number): Match[] {
      if (dim === 0 || query.length !== dim) return [];
      const q = l2Normalize(query);
      // per-asset max-pooling: an asset's score is its best reference match
      const best = new Map<number, Match>();
      for (let i = 0; i < same.length; i++) {
        let dot = 0;
        const off = i * dim;
        for (let d = 0; d < dim; d++) dot += q[d] * arena[off + d];
        const row = same[i];
        const prev = best.get(row.assetId);
        if (!prev || dot > prev.score) {
          best.set(row.assetId, { assetId: row.assetId, score: dot, refKey: row.key });
        }
      }
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
    },
  };
}
