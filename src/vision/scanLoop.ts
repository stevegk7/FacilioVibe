// The live recognition loop (roadmap 3): one 300ms tick drives, in order,
// the QR lane (always first — a sticker beats AI), the cheap quality gate,
// and the embedding/match lane on its own self-tuned cadence.
import { useEffect, useState } from 'react';
import { isMockMode } from '../api/provider';
import type { CameraState } from '../components/camera/useCamera';
import { loadEmbedder, type Embedder } from './embedder';
import { loadSiteIndex } from './captureStore';
import type { MatchIndex } from './matcher';
import { frameQuality, toTinyLuma } from './quality';
import { decodeQr } from './qr';
import { CAMERA_LONG_AXIS_FOV_DEG, captureFov, qrAngularOffset } from '../ar/projection';
import { longAxisFovDeg } from '../ar/fovCal';
import type { NormRect } from './types';

export const TICK_MS = 300;
export const QR_DEDUP_MS = 4000;
export const EMBED_MIN_INTERVAL_MS = 500;
export const EMBED_MAX_INTERVAL_MS = 1500;
export const LOCK_SCORE = 0.6;
export const LOCK_MARGIN = 0.08;
export const LOCK_STABLE_TICKS = 2;
/** 0.7 center crop — periphery is context, the middle is what you're aiming at. */
const CENTER_CROP: NormRect = { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };

export interface ScanCandidate {
  assetId: number;
  score: number;
}

export interface QrHit {
  code: string;
  /** Epoch ms of the decode — a new object per (re)fire, so effects re-run. */
  at: number;
  /** Angular offset of the code from the camera axis at decode time (deg),
   * when the decoder reported corners. Lets presence anchor to where the QR
   * ACTUALLY IS, not to wherever the phone happened to point. */
  offYaw?: number;
  offPitch?: number;
}

export interface ScanStats {
  ticks: number;
  embeds: number;
  /** Last embed cost in ms. */
  embedMs: number;
  /** Current self-tuned embed interval. */
  embedIntervalMs: number;
  indexSize: number;
}

export interface ScanLoopResult {
  /** Top-3 site-index matches for the current query vector. */
  candidates: ScanCandidate[];
  /** Set once a candidate holds score≥0.6 and margin≥0.08 for 2 straight ticks. */
  locked: ScanCandidate | null;
  /** Last decoded QR (4s dedup per code — the same sticker re-fires later). */
  qrHit: QrHit | null;
  /** Why embedding is blocked right now ('dark' | 'blur' | 'moving'), else null. */
  hint: string | null;
  stats: ScanStats;
}

interface CameraLike {
  videoRef: { current: HTMLVideoElement | null };
  frameCanvasRef: { current: HTMLCanvasElement | null };
  state: CameraState;
}

export interface UseScanLoopArgs {
  camera: CameraLike;
  siteId?: number;
  enabled: boolean;
  /** Injectable embedder — defaults to the real one (stub in mock mode/tests). */
  embedder?: Embedder;
  /** Injectable index — defaults to loadSiteIndex(siteId, modelId). */
  index?: MatchIndex;
}

const EMPTY_STATS: ScanStats = { ticks: 0, embeds: 0, embedMs: 0, embedIntervalMs: EMBED_MIN_INTERVAL_MS, indexSize: 0 };

export function useScanLoop({ camera, siteId, enabled, embedder, index }: UseScanLoopArgs): ScanLoopResult {
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [locked, setLocked] = useState<ScanCandidate | null>(null);
  const [qrHit, setQrHit] = useState<QrHit | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [stats, setStats] = useState<ScanStats>(EMPTY_STATS);

  // Loop-internal mutable state — none of it should re-render on its own.
  const running = camera.state === 'live' && enabled;
  const videoRef = camera.videoRef;
  const frameCanvasRef = camera.frameCanvasRef;

  useEffect(() => {
    if (!running) {
      setCandidates([]);
      setLocked(null);
      setHint(null);
      setQrHit(null);
      setStats(EMPTY_STATS);
      return;
    }

    let disposed = false;
    const qrCanvas = document.createElement('canvas');
    const qualityCanvas = document.createElement('canvas');
    let prevTiny: Uint8ClampedArray | null = null;
    let qrBusy = false;
    let lastQr: { code: string; at: number } | null = null;
    let embedBusy = false;
    let lastEmbedAt = 0;
    let embedInterval = EMBED_MIN_INTERVAL_MS;
    const recentVecs: Float32Array[] = [];
    let lockAssetId: number | null = null;
    let lockStreak = 0;
    const stat: ScanStats = { ...EMPTY_STATS };

    // The embedder and index resolve async; the loop skips matching until ready.
    let live: { embedder: Embedder; index: MatchIndex } | null = null;
    void (async () => {
      try {
        const emb = embedder ?? (await loadEmbedder(isMockMode()));
        const idx = index ?? (await loadSiteIndex(siteId, emb.modelId));
        if (!disposed) {
          live = { embedder: emb, index: idx };
          stat.indexSize = idx.size;
        }
      } catch {
        /* no embedder/index → QR lane still runs */
      }
    })();

    const frameSource = (): { src: CanvasImageSource; w: number; h: number } | null => {
      const fc = frameCanvasRef.current;
      if (fc && fc.width) return { src: fc, w: fc.width, h: fc.height };
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth) {
        return { src: video, w: video.videoWidth, h: video.videoHeight };
      }
      return null;
    };

    const tick = () => {
      const frame = frameSource();
      if (!frame) return;
      stat.ticks++;

      // ---- 1. QR lane: FIRST, every tick (reentrancy-guarded) ----
      if (!qrBusy) {
        qrBusy = true;
        void decodeQr(frame.src, frame.w, frame.h, qrCanvas)
          .then((hit) => {
            if (disposed || !hit) return;
            const now = Date.now();
            // time-based dedup: the same sticker re-fires after 4s
            if (!lastQr || lastQr.code !== hit.data || now - lastQr.at >= QR_DEDUP_MS) {
              lastQr = { code: hit.data, at: now };
              const off = hit.corners
                ? qrAngularOffset(
                    hit.corners,
                    hit.frameW,
                    hit.frameH,
                    captureFov(hit.frameW, hit.frameH, longAxisFovDeg(CAMERA_LONG_AXIS_FOV_DEG)),
                  )
                : null;
              setQrHit({
                code: hit.data,
                at: now,
                offYaw: off?.yawDeg,
                offPitch: off?.pitchDeg,
              });
            }
          })
          .finally(() => {
            qrBusy = false;
          });
      }

      // ---- 2. quality gate: bad frames block embedding, surface a hint ----
      let quality;
      try {
        const tiny = toTinyLuma(frame.src, frame.w, frame.h, qualityCanvas);
        quality = frameQuality(tiny, prevTiny);
        prevTiny = tiny;
      } catch {
        return; // no 2d canvas (jsdom) — QR lane already ran
      }
      if (!quality.ok) {
        setHint(quality.hint ?? null);
        setStats({ ...stat });
        return;
      }
      setHint(null);

      // ---- 3. embed lane on its own cadence ----
      const now = performance.now();
      if (!live || embedBusy || now - lastEmbedAt < embedInterval) {
        setStats({ ...stat, embedIntervalMs: embedInterval });
        return;
      }
      embedBusy = true;
      lastEmbedAt = now;
      const { embedder: emb, index: idx } = live;
      void (async () => {
        try {
          const t0 = performance.now();
          const vec = await emb.embed(frame.src, frame.w, frame.h, CENTER_CROP);
          const cost = performance.now() - t0;
          // self-tune: stay well under 25% duty cycle, never slower than 1.5s
          embedInterval = Math.min(
            EMBED_MAX_INTERVAL_MS,
            Math.max(EMBED_MIN_INTERVAL_MS, cost * 4),
          );
          stat.embeds++;
          stat.embedMs = Math.round(cost);
          stat.embedIntervalMs = Math.round(embedInterval);

          // query vector = mean of the last 2 frame embeddings
          recentVecs.push(vec);
          if (recentVecs.length > 2) recentVecs.shift();
          const query = meanVec(recentVecs);
          const matches = idx.search(query, 3);
          if (disposed) return;
          setCandidates(matches.map((m) => ({ assetId: m.assetId, score: m.score })));

          // auto-lock: score + margin over runner-up, stable 2 consecutive ticks
          const top = matches[0];
          const second = matches[1];
          const eligible =
            !!top && top.score >= LOCK_SCORE && top.score - (second?.score ?? -1) >= LOCK_MARGIN;
          if (eligible && top.assetId === lockAssetId) {
            lockStreak++;
          } else {
            lockAssetId = eligible ? top.assetId : null;
            lockStreak = eligible ? 1 : 0;
          }
          if (eligible && lockStreak >= LOCK_STABLE_TICKS) {
            setLocked({ assetId: top.assetId, score: top.score });
          }
          setStats({ ...stat });
        } catch {
          /* embed failure: skip this cycle */
        } finally {
          embedBusy = false;
        }
      })();
    };

    const timer = setInterval(tick, TICK_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [running, siteId, embedder, index, videoRef, frameCanvasRef]);

  return { candidates, locked, qrHit, hint, stats };
}

function meanVec(vecs: Float32Array[]): Float32Array {
  if (vecs.length === 1) return vecs[0];
  const out = new Float32Array(vecs[0].length);
  for (const v of vecs) {
    for (let i = 0; i < out.length; i++) out[i] += v[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= vecs.length;
  return out;
}
