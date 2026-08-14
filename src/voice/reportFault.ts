/**
 * voice → photo → analyze → create-WO (roadmap 8).
 *
 * The whole point is that the technician says "report a fault", points the
 * camera, and a real work order exists a few seconds later — with the RIGHT
 * asset on it. Two rules keep that honest:
 *
 *  1. the draft agent writes the words, but the asset is decided by the vision
 *     confirm agent against a candidate list the APP built (identifyAsset's
 *     fabrication guard forces any invented id to null);
 *  2. when the verdict is no-match and more than one candidate was plausible,
 *     nothing is created — the caller is handed the candidates to confirm.
 *     A wrongly-attributed work order is worse than one more tap.
 */
import type { VoiceDeps } from './deps';
import type { WoDraft } from '../api/agents';
import type { Asset, LocationScope } from '../api/types';

export type FaultStage =
  | 'uploading'
  | 'drafting'
  | 'identifying'
  | 'confirm'
  | 'creating'
  | 'done';

export interface FaultCtx {
  /** Where the user is working — scopes the candidate search. */
  scope?: LocationScope;
  /** The asset the AR/capture surface already has locked, if any. */
  assetInView?: { id: number; name: string };
  /** Human-readable labels for the draft prompt (site / space / asset / survey). */
  names?: { site?: string; space?: string; asset?: string; survey?: string };
}

export interface FaultResult {
  fileId: number;
  draft: WoDraft;
  /** Set when a work order was created. */
  workOrderId?: number;
  /** The asset the WO was raised against. */
  assetId?: number;
  /** Set INSTEAD of workOrderId when identification was ambiguous. */
  needsConfirm?: Asset[];
  confidence?: number;
  reason?: string;
}

/** The context sentence the draft agent sees — names, never bare ids. */
export function faultContext(ctx: FaultCtx): string {
  const parts = [
    ctx.names?.site && `site ${ctx.names.site}`,
    ctx.names?.space && `space ${ctx.names.space}`,
    ctx.names?.asset && `asset ${ctx.names.asset}`,
    ctx.names?.survey && `survey ${ctx.names.survey}`,
  ].filter(Boolean);
  return parts.length
    ? `Fault reported at ${parts.join(', ')}.`
    : 'Fault reported; location unknown.';
}

/** Shared tail: create the WO and say the number out loud. */
export async function createFaultWorkOrder(
  draft: WoDraft,
  assetId: number | undefined,
  ctx: FaultCtx,
  deps: VoiceDeps,
): Promise<number> {
  const workOrderId = await deps.createWorkOrder({
    subject: draft.subject,
    description: draft.description,
    resourceId: assetId,
    siteId: ctx.scope?.siteId,
    // narrowest scope wins — the WO lands with real building/space values
    spaceId: ctx.scope?.floorId ?? ctx.scope?.buildingId,
  });
  // The draft agent proposes the checklist too — a work order born from a
  // photo arrives EXECUTABLE, not just described. Task failures never sink
  // the create: the record exists, the checklist is best-effort.
  for (const subject of draft.tasks ?? []) {
    try {
      await deps.addWorkOrderTask(workOrderId, subject);
    } catch {
      break;
    }
  }
  deps.speak(`Created work order ${workOrderId}: ${draft.subject}.`);
  return workOrderId;
}

export async function runReportFault(
  photo: Blob,
  ctx: FaultCtx,
  deps: VoiceDeps,
  onStage?: (stage: FaultStage) => void,
): Promise<FaultResult> {
  onStage?.('uploading');
  const fileId = await deps.uploadPhoto(photo, `fault-${Date.now()}.jpg`);

  onStage?.('drafting');
  const draft = await deps.draftWorkOrder(fileId, faultContext(ctx));

  onStage?.('identifying');
  const candidates: Array<{ id: number; name: string }> = ctx.assetInView
    ? [ctx.assetInView]
    : (await deps.searchAssets({ scope: ctx.scope })).slice(0, 5);

  let assetId: number | undefined;
  let confidence: number | undefined;
  let reason: string | undefined;
  if (candidates.length > 0) {
    const verdict = await deps.identifyAsset([fileId], candidates);
    confidence = verdict.confidence;
    reason = verdict.reason;
    if (verdict.assetId === null && candidates.length > 1) {
      onStage?.('confirm');
      return {
        fileId,
        draft,
        needsConfirm: candidates,
        confidence,
        reason,
      };
    }
    assetId = verdict.assetId ?? candidates[0]?.id;
  }

  onStage?.('creating');
  const workOrderId = await createFaultWorkOrder(draft, assetId, ctx, deps);
  onStage?.('done');
  return { fileId, draft, workOrderId, assetId, confidence, reason };
}
