/**
 * Zero-latency local intents. The ladder shape is lifted from
 * "/Users/rajkumars/Documents/Fun projects/asset-lens/src/screens/ScanScreen.tsx"
 * (onVoice, lines 495-539) and rewritten as a PURE function: no queries, no
 * refs, no side effects — matching is testable as a table and the caller
 * decides what to do with the action.
 *
 * Order matters. The record's own status catalogue wins first (saying a status
 * name IS the command), then the two phrase aliases, then UI verbs. A miss
 * returns null, which is the signal to fall through to the agent tool loop —
 * the slow path is only paid when the fast path can't answer.
 */
import type { WorkOrderStatus } from '../api/types';

export type VoiceUiVerb = 'rescan' | 'minimize' | 'expand' | 'pin' | 'tasks' | 'clear';

export type VoiceAction =
  | { type: 'change_status'; workOrderId: number; status: string; label: string }
  | { type: 'ui'; verb: VoiceUiVerb };

export interface IntentCtx {
  statuses: WorkOrderStatus[];
  workOrderInView?: number;
  assetInView?: number;
}

function statusAction(
  workOrderId: number,
  hit: WorkOrderStatus | undefined,
): VoiceAction | null {
  return hit
    ? { type: 'change_status', workOrderId, status: hit.value, label: hit.label }
    : null;
}

export function matchIntent(text: string, ctx: IntentCtx): VoiceAction | null {
  const said = text.toLowerCase().trim();
  if (!said) return null;
  const statuses = ctx.statuses ?? [];
  const workOrderId = ctx.workOrderInView;

  // (a) a status name spoken while a work order is in view is the transition.
  if (workOrderId !== undefined) {
    const named = statuses.find(
      (s) => said.includes(s.value.toLowerCase()) || said.includes(s.label.toLowerCase()),
    );
    if (named) return statusAction(workOrderId, named);

    // (b) phrase aliases for the two transitions technicians actually say.
    if (/start work|begin work/.test(said)) {
      const hit = statuses.find((s) => /progress/i.test(s.label) || /progress/i.test(s.value));
      if (hit) return statusAction(workOrderId, hit);
    }
    if (/pause|hold/.test(said)) {
      const hit = statuses.find((s) => /hold/i.test(s.label) || /hold/i.test(s.value));
      if (hit) return statusAction(workOrderId, hit);
    }
  }

  // (c) UI verbs — no record needed, they drive the surface the user is looking at.
  if (/rescan|scan again|next/.test(said)) return { type: 'ui', verb: 'rescan' };
  if (/minimi[sz]e/.test(said)) return { type: 'ui', verb: 'minimize' };
  if (/expand|maximi[sz]e/.test(said)) return { type: 'ui', verb: 'expand' };
  if (/pin (the )?(card|note|work ?order)|place (here|card|it)/.test(said)) {
    return { type: 'ui', verb: 'pin' };
  }
  if (/tasks|checklist/.test(said)) return { type: 'ui', verb: 'tasks' };
  if (/clear board|clear all/.test(said)) return { type: 'ui', verb: 'clear' };

  // (d) miss — the agent loop takes it.
  return null;
}
