// Public surface of the vision layer. The AR screen wiring (roadmap 5) is
// done by the integrator against THESE exports — nothing else in src/vision
// should need importing from outside.

// live recognition loop
export {
  useScanLoop,
  TICK_MS,
  QR_DEDUP_MS,
  LOCK_SCORE,
  LOCK_MARGIN,
  LOCK_STABLE_TICKS,
} from './scanLoop';
export type { ScanCandidate, ScanLoopResult, ScanStats, QrHit, UseScanLoopArgs } from './scanLoop';

// embedding index storage (KV over appStore)
export {
  loadSiteIndex,
  listCaptures,
  getCapture,
  putCapture,
  putVector,
  listSiteVectors,
  deleteCapture,
  captureKey,
  embKey,
  embPrefix,
} from './captureStore';
export type { CaptureRow, CaptureMarker, StoredVector } from './captureStore';

// capture save pipeline
export { saveCapture, MODEL_LOAD_TIMEOUT_MS } from './capturePipeline';
export type { CaptureInput, CaptureDeps, BlobEmbedder, PendingMarker } from './capturePipeline';

// QR lane
export { decodeQr, extractAssetId, normalizeCode } from './qr';
export {
  resolveCode,
  linkCode,
  unlinkCode,
  getCodeEntry,
  describeEntry,
} from './codes';
export type { CodeResolution, CodeTarget } from './codes';

// building blocks
export { loadEmbedder } from './embedder';
export type { Embedder } from './embedder';
export { buildIndex } from './matcher';
export type { MatchIndex } from './matcher';
export { quantizeInt8, dequantize, l2Normalize } from './quantize';
export { frameQuality, toTinyLuma } from './quality';
export type { FrameQuality } from './quality';
export type { NormRect, QuantVec, CandidateEmbedding, Match } from './types';
