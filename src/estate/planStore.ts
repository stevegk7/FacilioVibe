/**
 * Where imported floor plans live.
 *
 * The plan document itself goes to the app's file store — the two shipped plans
 * are 137 KB and 399 KB, which is a file, not a KV value. What goes in KV is the
 * small binding record: which floor a plan belongs to, and the fileId to fetch it
 * back with. That split also means re-binding or removing a plan never rewrites
 * the geometry.
 *
 * Keys live in the `settings` collection under `plan.<floorId>`, alongside the
 * other org-level settings (`org.links`, `perm.placeAsset`, `sitegeo.<siteId>`).
 */
import { appStore } from '../api/appStore';
import type { PlanDocument } from './planExtract';

/** What we keep in KV. Small on purpose — the geometry is in the file store. */
export interface PlanBinding {
  /** The plan's own id, and the key it takes in the estate's `plans` map. */
  planId: string;
  /** File-store id of the plan JSON. */
  fileId: number;
  /** Shown in the floor list; the plan's name, not the file's. */
  name: string;
  widthM: number;
  depthM: number;
  rooms: number;
  importedAt: string;
  /** Original file name, so "where did this come from" is answerable. */
  source?: string;
}

export const PLAN_KEY_PREFIX = 'plan.';
export const planKey = (floorId: number) => `${PLAN_KEY_PREFIX}${floorId}`;

/** Store the plan document and bind it to a floor. Resolves to the binding. */
export async function savePlanForFloor(
  floorId: number,
  plan: PlanDocument,
): Promise<PlanBinding> {
  const blob = new Blob([JSON.stringify(plan)], { type: 'application/json' });
  const fileId = await appStore.uploadPhoto(blob, `plan-${plan.id}.json`);

  const binding: PlanBinding = {
    planId: plan.id,
    fileId,
    name: plan.name,
    widthM: plan.widthM,
    depthM: plan.depthM,
    rooms: plan.rooms.length,
    importedAt: new Date().toISOString(),
    source: plan.source || undefined,
  };
  await appStore.kvPut('settings', planKey(floorId), binding);
  return binding;
}

export async function removePlanForFloor(floorId: number): Promise<void> {
  // The plan file is left in the store on purpose: deleting it would break any
  // other floor bound to the same fileId, and an orphaned plan costs nothing.
  await appStore.kvDelete('settings', planKey(floorId));
}

export async function listPlanBindings(): Promise<Record<number, PlanBinding>> {
  const rows = await appStore.kvList<PlanBinding>('settings', PLAN_KEY_PREFIX, 500);
  const out: Record<number, PlanBinding> = {};
  for (const row of rows) {
    const floorId = Number(row.key.slice(PLAN_KEY_PREFIX.length));
    if (Number.isFinite(floorId) && row.value?.fileId) out[floorId] = row.value;
  }
  return out;
}

/**
 * Fetch the plan documents for a set of bindings.
 *
 * One fetch per distinct fileId, and a failed plan is skipped rather than fatal:
 * that floor falls back to the schematic layout, which is a real fallback. The
 * alternative — refusing to build the estate because one plan 404'd — would take
 * the whole 3D view down for a single bad import.
 */
export async function loadBoundPlans(
  bindings: Record<number, PlanBinding>,
): Promise<{ plans: Record<string, PlanDocument>; planBindings: Record<number, string> }> {
  const plans: Record<string, PlanDocument> = {};
  const planBindings: Record<number, string> = {};

  const byFile = new Map<number, PlanBinding>();
  for (const binding of Object.values(bindings)) byFile.set(binding.fileId, binding);

  await Promise.all(
    [...byFile.values()].map(async (binding) => {
      try {
        const url = await appStore.getPhotoUrl(binding.fileId);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        plans[binding.planId] = (await res.json()) as PlanDocument;
      } catch (err) {
        console.warn(`[estate] plan ${binding.planId} could not be loaded:`, (err as Error)?.message ?? err);
      }
    }),
  );

  for (const [floorId, binding] of Object.entries(bindings)) {
    if (plans[binding.planId]) planBindings[Number(floorId)] = binding.planId;
  }
  return { plans, planBindings };
}
