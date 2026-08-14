// Embedding-index storage over the appStore KV ('surveys' collection).
//
//   capture.<id>                      → CaptureRow (photo/thumb/marker fileIds)
//   emb.<siteId>.<captureId>.<idx>    → StoredVector (int8+base64, modelId-stamped)
//
// The site bundle is one prefix list: kvList('surveys', `emb.<siteId>.`).
// File ids are what we persist — object URLs are session junk (photoCache).
import { appStore } from '../api/appStore';
import type { GeoFix } from '../api/types';
import { buildIndex, type MatchIndex } from './matcher';
import type { CandidateEmbedding, NormRect, QuantVec } from './types';

export interface CaptureMarker {
  assetId: number;
  rect: NormRect;
  cropFileId: number;
}

export interface CaptureRow {
  id: string;
  siteId?: number;
  spaceName?: string;
  photoFileId: number;
  thumbFileId: number;
  markers: CaptureMarker[];
  geo?: GeoFix | null;
  createdAt: string;
  /** 'pending' = crops stored but not embedded (model-load race lost). */
  embeddingStatus: 'done' | 'pending';
}

export interface StoredVector extends QuantVec {
  assetId: number;
  captureId: string;
  markerIdx: number;
  /** Embedder identity — vectors from another model never mix. */
  modelId: string;
}

const COLL = 'surveys' as const;

export const captureKey = (id: string) => `capture.${id}`;
export const embKey = (siteId: number, captureId: string, markerIdx: number) =>
  `emb.${siteId}.${captureId}.${markerIdx}`;
export const embPrefix = (siteId: number) => `emb.${siteId}.`;

/** Vectors for captures without a site bucket under siteId 0. */
export const siteBucket = (siteId: number | undefined) => siteId ?? 0;

export async function putCapture(row: CaptureRow): Promise<void> {
  await appStore.kvPut(COLL, captureKey(row.id), row);
}

export async function getCapture(id: string): Promise<CaptureRow | null> {
  return appStore.kvGet<CaptureRow>(COLL, captureKey(id));
}

/** All captures, newest first. */
export async function listCaptures(): Promise<CaptureRow[]> {
  const entries = await appStore.kvList<CaptureRow>(COLL, 'capture.', 500);
  return entries.map((e) => e.value).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function putVector(siteId: number | undefined, v: StoredVector): Promise<void> {
  await appStore.kvPut(COLL, embKey(siteBucket(siteId), v.captureId, v.markerIdx), v);
}

export async function listSiteVectors(siteId: number | undefined): Promise<StoredVector[]> {
  const entries = await appStore.kvList<StoredVector>(COLL, embPrefix(siteBucket(siteId)), 2000);
  return entries.map((e) => e.value);
}

/**
 * Build the in-memory match index for a site. When `modelId` is given only
 * vectors stamped with it are used — embeddings from different models never
 * mix in one arena.
 */
export async function loadSiteIndex(
  siteId: number | undefined,
  modelId?: string,
): Promise<MatchIndex> {
  const entries = await appStore.kvList<StoredVector>(COLL, embPrefix(siteBucket(siteId)), 2000);
  const rows: CandidateEmbedding[] = entries
    .filter((e) => !modelId || e.value.modelId === modelId)
    .map((e) => ({
      key: e.key,
      assetId: e.value.assetId,
      vec: { q: e.value.q, s: e.value.s, dim: e.value.dim },
    }));
  return buildIndex(rows);
}

/** Delete a capture row AND its emb.* vectors (photos stay in the file store). */
export async function deleteCapture(row: CaptureRow): Promise<void> {
  await appStore.kvDelete(COLL, captureKey(row.id));
  await Promise.all(
    row.markers.map((_, idx) =>
      appStore.kvDelete(COLL, embKey(siteBucket(row.siteId), row.id, idx)),
    ),
  );
}
