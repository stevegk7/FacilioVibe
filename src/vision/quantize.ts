// Lifted from asset-lens/src/vision/quantize.ts (QuantVec import adapted).
import type { QuantVec } from './types';

/**
 * Per-vector int8 scalar quantization for embedding transport/storage.
 * Inputs are L2-normalized, so components have RMS ~1/sqrt(dim) — a naive
 * ×127 would crush them into a few levels; the per-vector scale keeps ~7 bits
 * of real precision. Cosine of two quantized vectors ≈ dot(qA,qB)·sA·sB.
 * ~1.7KB base64 per 1280-d vector vs ~12KB as JSON floats.
 */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

export function quantizeInt8(v: Float32Array): QuantVec {
  const n = l2Normalize(v);
  let max = 0;
  for (let i = 0; i < n.length; i++) {
    const a = Math.abs(n[i]);
    if (a > max) max = a;
  }
  const s = max > 0 ? max / 127 : 1;
  const q = new Int8Array(n.length);
  for (let i = 0; i < n.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(n[i] / s)));
  return { q: int8ToBase64(q), s, dim: n.length };
}

export function dequantize(qv: QuantVec): Float32Array {
  const q = base64ToInt8(qv.q);
  const out = new Float32Array(qv.dim);
  const n = Math.min(q.length, qv.dim);
  for (let i = 0; i < n; i++) out[i] = q[i] * qv.s;
  return out;
}

function int8ToBase64(arr: Int8Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToInt8(b64: string): Int8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int8Array(bytes.buffer);
}
