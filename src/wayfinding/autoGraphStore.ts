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

/**
 * A landmark somebody wrote for a derived edge.
 *
 * The research finding the whole route surface is built on is that landmark phrasing
 * beats distance ("past the red fire-hose cabinet, then left" versus "18m"),
 * because a landmark also lets you confirm you are still on the right path. The
 * survey lane has carried authored instructions since the rebuild; the derived
 * portfolio graph could only ever say "Walk to X", and had no way to be taught.
 *
 * Kept as a NOTE against an edge id rather than as a replacement edge: the
 * derived edge keeps its geometry and its cost, and a rebuild that regenerates
 * the same edge id keeps the sentence.
 */
export interface EdgeNote {
  instruction: string;
  /** ISO — shown as provenance, and the tiebreak if two authors ever collide. */
  at: string;
  by?: string;
}

export interface AutoGraphOverlay {
  addEdges: AutoEdge[];
  removeEdgeIds: string[];
  /** Landmark text per derived edge id. Absent in documents written before this. */
  edgeNotes: Record<string, EdgeNote>;
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
    edgeNotes: readEdgeNotes(doc.edgeNotes),
    version: typeof doc.version === 'number' ? doc.version : 0,
  };
}

/** Field-by-field, like everything else here: a hand-edited note must degrade
    to "no note" rather than putting a `[object Object]` in someone's route. */
function readEdgeNotes(raw: unknown): Record<string, EdgeNote> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, EdgeNote> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || typeof value !== 'object') continue;
    const note = value as Record<string, unknown>;
    const instruction = typeof note.instruction === 'string' ? note.instruction.trim() : '';
    if (!instruction) continue;
    out[id] = {
      instruction,
      at: typeof note.at === 'string' ? note.at : '',
      ...(typeof note.by === 'string' ? { by: note.by } : {}),
    };
  }
  return out;
}

export async function saveOverlay(
  siteId: number | string,
  overlay: AutoGraphOverlay,
): Promise<void> {
  await appStore.kvPut('settings', overlayKey(siteId), overlay);
}

/** Thrown when someone else wrote the overlay since this author last read it. */
export class OverlayConflictError extends Error {
  constructor() {
    super('Someone else changed this site’s route notes — reopen and try again.');
    this.name = 'OverlayConflictError';
  }
}

/**
 * Write a landmark against a derived edge, refusing to clobber a concurrent edit.
 *
 * `version` has existed on this document since it was written and nothing ever
 * read it: saves were a straight kvPut, so two authors silently overwrote each
 * other — and because preview and production share one database, "two authors"
 * includes a developer exercising the editor against preview while a technician
 * is in the field.
 *
 * This is conflict DETECTION, not a transaction. The store has no
 * compare-and-swap, so a genuinely simultaneous pair of writes can still
 * interleave; what this reliably catches is the real case, two people editing
 * minutes apart. Passing `expectedVersion` from the copy the author was looking
 * at is what makes that possible.
 */
export async function saveEdgeNote(
  siteId: number | string,
  edgeId: string,
  note: { instruction: string; by?: string; at: string },
  expectedVersion: number,
): Promise<AutoGraphOverlay> {
  const current = (await loadOverlay(siteId)) ?? {
    addEdges: [],
    removeEdgeIds: [],
    edgeNotes: {},
    version: 0,
  };
  if (current.version !== expectedVersion) throw new OverlayConflictError();

  const instruction = note.instruction.trim();
  const edgeNotes = { ...current.edgeNotes };
  // An empty instruction is how a note is REMOVED — the same control that adds
  // one has to be able to take a wrong one back out.
  if (instruction) edgeNotes[edgeId] = { instruction, at: note.at, ...(note.by ? { by: note.by } : {}) };
  else delete edgeNotes[edgeId];

  const next: AutoGraphOverlay = { ...current, edgeNotes, version: current.version + 1 };
  await saveOverlay(siteId, next);
  return next;
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
  // Notes ride ON the derived edge rather than replacing it, so an edge keeps
  // its geometry and cost and only gains a sentence. A note whose edge no longer
  // exists after a rebuild is simply not applied — and, like a dangling added
  // edge, is never persisted away, because the estate may grow it back.
  const notes = overlay.edgeNotes ?? {};
  const withNote = (e: AutoEdge): AutoEdge => {
    const note = notes[e.id];
    return note ? { ...e, instruction: note.instruction } : e;
  };
  return {
    nodes: [...graph.nodes],
    edges: [
      ...graph.edges.filter((e) => !removed.has(e.id)).map(withNote),
      ...validateOverlay(graph, overlay).ok.map(withNote),
    ],
  };
}
