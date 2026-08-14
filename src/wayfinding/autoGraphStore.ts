/**
 * Overlay storage for the auto-graph.
 *
 * buildAutoGraph derives its graph wholesale from the estate, so it is thrown
 * away and rebuilt on every load — nothing hand-authored can live INSIDE it.
 * Corrections live here instead: a small overlay document per site (edges an
 * author added, edge ids an author removed) that is re-applied to whatever the
 * next rebuild produces. Endpoints that no longer exist after a rebuild are
 * dropped at apply time, never persisted away — the estate may grow them back.
 *
 * Same one-document-per-site shape as graph.ts (`settings` key
 * `wf.autograph.<siteId>`), so an overlay costs exactly one read.
 */
import { appStore } from '../api/appStore';
import type { AutoEdge, AutoGraph } from './autoGraph';

export interface AutoGraphOverlay {
  addEdges: AutoEdge[];
  removeEdgeIds: string[];
  version: number;
}

const PREFIX = 'wf.autograph.';

export function overlayKey(siteId: number | string): string {
  return `${PREFIX}${siteId}`;
}

/**
 * A stored document is only trusted field by field — the key may hold an old
 * shape (or hand-edited junk), and a bad overlay must degrade to "no overlay",
 * never take the Wayfinder screen down.
 */
export async function loadOverlay(siteId: number | string): Promise<AutoGraphOverlay | null> {
  let stored: unknown;
  try {
    stored = await appStore.kvGet('settings', overlayKey(siteId));
  } catch {
    return null;
  }
  if (stored == null || typeof stored !== 'object') return null;
  const doc = stored as Record<string, unknown>;
  return {
    addEdges: Array.isArray(doc.addEdges) ? (doc.addEdges as AutoEdge[]) : [],
    removeEdgeIds: Array.isArray(doc.removeEdgeIds)
      ? (doc.removeEdgeIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
    version: typeof doc.version === 'number' ? doc.version : 0,
  };
}

export async function saveOverlay(
  siteId: number | string,
  overlay: AutoGraphOverlay,
): Promise<void> {
  await appStore.kvPut('settings', overlayKey(siteId), overlay);
}

/**
 * Split an overlay's added edges into applicable and dangling. Separate from
 * applyOverlay so the editor UI can tell the author "2 of your edges no longer
 * attach" instead of silently thinning the overlay.
 */
export function validateOverlay(
  graph: AutoGraph,
  overlay: AutoGraphOverlay,
): { ok: AutoEdge[]; dropped: number } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const ok = overlay.addEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { ok, dropped: overlay.addEdges.length - ok.length };
}

/**
 * Re-apply an overlay to a (freshly rebuilt) graph. Pure — returns a new
 * graph, the input is never touched. Removals run first so an overlay can
 * replace a derived edge: remove the old id, add its correction.
 */
export function applyOverlay(graph: AutoGraph, overlay: AutoGraphOverlay | null): AutoGraph {
  if (!overlay) return { nodes: [...graph.nodes], edges: [...graph.edges] };
  const removed = new Set(overlay.removeEdgeIds);
  return {
    nodes: [...graph.nodes],
    edges: [
      ...graph.edges.filter((e) => !removed.has(e.id)),
      ...validateOverlay(graph, overlay).ok,
    ],
  };
}
