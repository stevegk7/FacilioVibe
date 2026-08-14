// Quantized-vector helpers for the AR relocalization lane.
// DEDUPED (WS-A merge): src/vision/quantize.ts is the canonical implementation
// — this module is a thin re-export so ar/* imports stay stable.
export type { QuantVec } from '../vision/types';
export { quantizeInt8, dequantize, l2Normalize } from '../vision/quantize';
