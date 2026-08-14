/**
 * Dijkstra over the app-owned graph, plus the phrasing of each hop.
 *
 * This replaces `indoorLegs`' greedy nearest-waypoint chain, which walked in a
 * straight line between geotagged surveys and would happily route through a
 * wall. Here a hop only exists if somebody declared an edge, so the route is
 * only ever as good as the graph — which is the honest trade.
 *
 * Distances are real ONLY where an edge carries `meters` or both endpoints are
 * geotagged. Nothing here invents a distance to an asset: markers are bearing
 * rays with no range, so the last leg is handed to the AR arrow, not measured.
 */
import { haversineMeters, initialBearingDeg } from './geo';
import { compassWord } from './bearing';
import type { EdgeKind, WayEdge, WayGraph, WayNode } from './graph';

/** Cost when an edge carries no measured distance. Vertical moves are dear so
 *  a route prefers walking one floor's length over a needless lift ride. */
const DEFAULT_COST: Record<EdgeKind, number> = {
  walk: 25,
  door: 5,
  stairs: 60,
  lift: 90,
};

export interface RouteStep {
  from: WayNode;
  to: WayNode;
  edge: WayEdge;
  meters?: number;
  /** One line a technician can act on without looking at anything else. */
  text: string;
}

export interface Route {
  steps: RouteStep[];
  /** Sum of known distances; undefined when no step had one. */
  totalMeters?: number;
  destination: WayNode;
}

function edgeMeters(edge: WayEdge, from: WayNode, to: WayNode): number | undefined {
  if (typeof edge.meters === 'number') return edge.meters;
  if (from.lat != null && from.lng != null && to.lat != null && to.lng != null) {
    return haversineMeters({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng });
  }
  return undefined;
}

function cost(edge: WayEdge, from: WayNode, to: WayNode): number {
  return edgeMeters(edge, from, to) ?? DEFAULT_COST[edge.kind];
}

/** Adjacency, honouring one-way edges. */
function neighbours(graph: WayGraph): Map<string, Array<{ edge: WayEdge; to: string }>> {
  const map = new Map<string, Array<{ edge: WayEdge; to: string }>>();
  const push = (from: string, to: string, edge: WayEdge) => {
    const list = map.get(from) ?? [];
    list.push({ edge, to });
    map.set(from, list);
  };
  for (const edge of graph.edges) {
    push(edge.from, edge.to, edge);
    if (!edge.oneWay) push(edge.to, edge.from, edge);
  }
  return map;
}

function floorPhrase(from: WayNode, to: WayNode): string {
  const a = from.floorLevel;
  const b = to.floorLevel;
  if (a == null || b == null || a === b) return to.name;
  const delta = Math.abs(b - a);
  return `${to.name} — ${b > a ? 'up' : 'down'} ${delta} floor${delta === 1 ? '' : 's'}`;
}

export function stepText(from: WayNode, to: WayNode, edge: WayEdge, meters?: number): string {
  if (edge.instruction) return edge.instruction;

  if (edge.kind === 'lift' || edge.kind === 'stairs') {
    const how = edge.kind === 'lift' ? 'Take the lift' : 'Take the stairs';
    return `${how} to ${floorPhrase(from, to)}`;
  }
  if (edge.kind === 'door') return `Go through to ${to.name}`;

  // A walk reads better with distance and a compass word when we have them.
  const parts: string[] = [];
  if (meters != null) parts.push(`${Math.round(meters)}m`);
  if (from.lat != null && from.lng != null && to.lat != null && to.lng != null) {
    parts.push(
      compassWord(
        initialBearingDeg({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }),
      ),
    );
  }
  return parts.length ? `Head to ${to.name} — ${parts.join(' ')}` : `Head to ${to.name}`;
}

/**
 * Shortest path from → to. Returns null when there is NO path — never a
 * partial route, because half a route walked confidently is worse than being
 * told the building isn't mapped yet.
 */
export function findRoute(graph: WayGraph, fromId: string, toId: string): Route | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = byId.get(fromId);
  const goal = byId.get(toId);
  if (!start || !goal) return null;
  if (fromId === toId) return { steps: [], totalMeters: 0, destination: goal };

  const adj = neighbours(graph);
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { node: string; edge: WayEdge }>();
  const settled = new Set<string>();

  // Small graphs (tens of nodes) — a linear scan beats a heap in clarity.
  for (;;) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!settled.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    if (current === toId) break;
    settled.add(current);

    const here = byId.get(current);
    if (!here) continue;
    for (const { edge, to } of adj.get(current) ?? []) {
      const next = byId.get(to);
      if (!next || settled.has(to)) continue;
      const candidate = best + cost(edge, here, next);
      if (candidate < (dist.get(to) ?? Infinity)) {
        dist.set(to, candidate);
        prev.set(to, { node: current, edge });
      }
    }
  }

  if (!dist.has(toId) || !prev.has(toId)) return null;

  const steps: RouteStep[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const hop = prev.get(cursor);
    if (!hop) return null;
    const from = byId.get(hop.node) as WayNode;
    const to = byId.get(cursor) as WayNode;
    const meters = edgeMeters(hop.edge, from, to);
    steps.unshift({ from, to, edge: hop.edge, meters, text: stepText(from, to, hop.edge, meters) });
    cursor = hop.node;
  }

  const known = steps.map((s) => s.meters).filter((m): m is number => m != null);
  return {
    steps,
    totalMeters: known.length ? known.reduce((a, b) => a + b, 0) : undefined,
    destination: goal,
  };
}

/** The node closest to a GPS fix — how an outdoor arrival picks its entrance. */
export function nearestNode(
  graph: WayGraph,
  fix: { lat: number; lng: number },
  kinds?: WayNode['kind'][],
): WayNode | null {
  let best: WayNode | null = null;
  let bestM = Infinity;
  for (const node of graph.nodes) {
    if (node.lat == null || node.lng == null) continue;
    if (kinds && !kinds.includes(node.kind)) continue;
    const m = haversineMeters(fix, { lat: node.lat, lng: node.lng });
    if (m < bestM) {
      bestM = m;
      best = node;
    }
  }
  return best;
}
