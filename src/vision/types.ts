// Local geometry + embedding-transport types for the vision layer.
// QuantVec matches the `{ q, s, dim }` wire shape already used by
// SweepFrame.vec in src/api/types.ts — the two must stay compatible.

/** Normalized 0..1 rect within a photo/frame. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** int8+base64 quantised embedding with its per-vector scale. */
export interface QuantVec {
  q: string;
  s: number;
  dim: number;
}

/** One reference embedding row feeding the match index. */
export interface CandidateEmbedding {
  /** KV key the row came from — handed back so a match is traceable. */
  key: string;
  assetId: number;
  vec: QuantVec;
}

export interface Match {
  assetId: number;
  score: number;
  refKey: string;
}
