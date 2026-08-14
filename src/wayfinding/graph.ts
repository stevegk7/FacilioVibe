/**
 * The navigation graph.
 *
 * Facilio models geometry in places (floor plans), but it models TOPOLOGY
 * nowhere: there is no corridor, door, portal, stair or lift entity, and no
 * traversability between anything. So the graph is app-owned — and because
 * floor plans are optional and most orgs never author one, this graph is built
 * from data THIS app already creates: survey standpoints, their QR codes and
 * their GPS tags.
 *
 * Nodes are therefore free (every standpoint is one). Edges are the single
 * irreducible authoring cost, and the graph editor exists to make them cheap.
 *
 * Stored as ONE document per site (`settings` key `wf.graph.<siteId>`) so a
 * route needs exactly one read.
 */
import { appStore } from '../api/appStore';
import type { Survey } from '../api/types';

export type NodeKind = 'standpoint' | 'entrance' | 'lift' | 'stairs' | 'junction';
export type EdgeKind = 'walk' | 'lift' | 'stairs' | 'door';

export interface WayNode {
  id: string;
  kind: NodeKind;
  name: string;
  buildingId?: number;
  floorId?: number;
  /** From Facilio's floor.floorlevel — drives "take the lift to L9". */
  floorLevel?: number;
  /** Set when this node IS a survey standpoint (then it needs no authoring). */
  surveyId?: string;
  /** QR value that puts you here when scanned. */
  code?: string;
  lat?: number;
  lng?: number;
}

export interface WayEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Walking distance. Omitted = fall back to the kind's default cost. */
  meters?: number;
  /** Overrides the generated instruction ("Use the service corridor"). */
  instruction?: string;
  /** Edges are two-way unless this is set. */
  oneWay?: boolean;
}

export interface WayGraph {
  siteId: number;
  nodes: WayNode[];
  edges: WayEdge[];
  updatedAt: string;
}

const PREFIX = 'wf.graph.';

export function graphKey(siteId: number): string {
  return `${PREFIX}${siteId}`;
}

export function emptyGraph(siteId: number): WayGraph {
  return { siteId, nodes: [], edges: [], updatedAt: new Date().toISOString() };
}

export async function loadGraph(siteId: number): Promise<WayGraph> {
  const stored = await appStore.kvGet<WayGraph>('settings', graphKey(siteId));
  if (!stored) return emptyGraph(siteId);
  return {
    siteId,
    nodes: Array.isArray(stored.nodes) ? stored.nodes : [],
    edges: Array.isArray(stored.edges) ? stored.edges : [],
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
  };
}

export async function saveGraph(graph: WayGraph): Promise<void> {
  await appStore.kvPut('settings', graphKey(graph.siteId), {
    ...graph,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Standpoints become nodes automatically. An author never has to re-enter a
 * survey that already exists — they only draw the edges between them.
 *
 * A stored node for the same survey wins, so hand-edits (a better name, a
 * floor correction) are never clobbered by the derived version.
 */
export function withSurveyNodes(graph: WayGraph, surveys: Survey[]): WayGraph {
  const claimed = new Set(graph.nodes.map((n) => n.surveyId).filter(Boolean) as string[]);
  const derived: WayNode[] = surveys
    .filter((s) => !claimed.has(s.id))
    .map((s) => ({
      id: `sv:${s.id}`,
      kind: 'standpoint' as NodeKind,
      name: s.name,
      buildingId: s.buildingId,
      floorId: s.floorId,
      surveyId: s.id,
      code: s.qrCode,
      lat: s.geo?.lat,
      lng: s.geo?.lng,
    }));
  return { ...graph, nodes: [...graph.nodes, ...derived] };
}

/** The node a scanned code puts you at, if any. */
export function nodeForCode(graph: WayGraph, code: string): WayNode | undefined {
  const wanted = code.trim().toLowerCase();
  return graph.nodes.find((n) => (n.code ?? '').trim().toLowerCase() === wanted);
}

export function nodeForSurvey(graph: WayGraph, surveyId: string): WayNode | undefined {
  return graph.nodes.find((n) => n.surveyId === surveyId);
}

export function nodeById(graph: WayGraph, id: string): WayNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** Nodes you can start a route from by scanning something. */
export function scannableNodes(graph: WayGraph): WayNode[] {
  return graph.nodes.filter((n) => Boolean(n.code));
}
