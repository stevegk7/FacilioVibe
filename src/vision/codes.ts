// QR code registry over the 'codes' KV collection. Key = normalized code,
// value = CodeEntry (src/api/types). A code identifies exactly ONE thing —
// when two lanes disagree about what that thing is, we ASK (conflict sheet),
// never silently repoint, never guess.
import { appStore } from '../api/appStore';
import type { CodeEntry } from '../api/types';
import { extractAssetId, normalizeCode } from './qr';

export type CodeTarget =
  | { type: 'asset'; assetId: number }
  | { type: 'space'; spaceId: number }
  | { type: 'floor'; floorId: number }
  | { type: 'survey'; surveyId: string };

export type CodeResolution =
  /** Nothing known about this code → offer the link-code sheet. */
  | { kind: 'unknown'; code: string }
  /** One unambiguous target (registry entry, or the id the code itself encodes). */
  | { kind: 'target'; code: string; entry: CodeEntry }
  /**
   * The registry maps the code to one target while the code itself encodes a
   * DIFFERENT asset id — two targets for one sticker. The caller must open
   * the conflict sheet and let the user decide.
   */
  | { kind: 'conflict'; code: string; entry: CodeEntry; impliedAssetId: number };

export async function getCodeEntry(raw: string): Promise<CodeEntry | null> {
  return appStore.kvGet<CodeEntry>('codes', normalizeCode(raw));
}

/** Explicit link (user action from the link/conflict sheet). Overwrites. */
export async function linkCode(raw: string, target: CodeTarget): Promise<CodeEntry> {
  const code = normalizeCode(raw);
  const entry: CodeEntry = {
    code,
    type: target.type,
    ...(target.type === 'asset' ? { assetId: target.assetId } : {}),
    ...(target.type === 'space' ? { spaceId: target.spaceId } : {}),
    ...(target.type === 'floor' ? { floorId: target.floorId } : {}),
    ...(target.type === 'survey' ? { surveyId: target.surveyId } : {}),
    createdAt: new Date().toISOString(),
  };
  await appStore.kvPut('codes', code, entry);
  return entry;
}

export async function unlinkCode(raw: string): Promise<void> {
  await appStore.kvDelete('codes', normalizeCode(raw));
}

/**
 * Resolve a scanned code against BOTH lanes: the registry entry and the id
 * the code intrinsically encodes (`facilio_<id>`, URL params, digits).
 * Registry + matching intrinsic id, or registry alone, or intrinsic alone →
 * 'target'. Registry pointing anywhere other than the intrinsic asset →
 * 'conflict'. Neither → 'unknown'.
 */
export async function resolveCode(raw: string): Promise<CodeResolution> {
  const code = normalizeCode(raw);
  const entry = await appStore.kvGet<CodeEntry>('codes', code);
  const impliedAssetId = extractAssetId(raw);

  if (entry) {
    const agrees = entry.type === 'asset' && entry.assetId === impliedAssetId;
    if (impliedAssetId !== null && !agrees) {
      return { kind: 'conflict', code, entry, impliedAssetId };
    }
    return { kind: 'target', code, entry };
  }

  if (impliedAssetId !== null) {
    // Intrinsic asset code — synthesized, NOT persisted (no silent writes).
    return {
      kind: 'target',
      code,
      entry: { code, type: 'asset', assetId: impliedAssetId, createdAt: '' },
    };
  }

  return { kind: 'unknown', code };
}

/** Human-readable one-liner for a CodeEntry — sheets and toasts share it. */
export function describeEntry(entry: CodeEntry): string {
  switch (entry.type) {
    case 'asset':
      return `Asset #${entry.assetId}`;
    case 'space':
      return `Space #${entry.spaceId}`;
    case 'floor':
      return `Floor #${entry.floorId}`;
    case 'survey':
      return `Survey ${entry.surveyId}`;
  }
}
