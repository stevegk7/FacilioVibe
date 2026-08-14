/**
 * Auto-graph: a wayfinding graph derived wholesale from the 3D estate.
 *
 * graph.ts's WayGraph is the hand-authored one — survey standpoints for nodes,
 * human-drawn edges, honest about only knowing what somebody mapped. This is
 * its opposite number: the portfolio hierarchy the estate already computes
 * (site > building > floor > space > asset) gives nodes for free, plan-room
 * geometry gives doorway candidates, and the only invented pieces are the
 * circulation points every building must have anyway (a floor's walkable
 * centre, one stair core). Coverage over precision: every asset is reachable
 * on day one, and a route through this graph is a containment path, not a
 * measured survey.
 *
 * PURE: estate data in, graph out. No SDK, no store, no engine, no window.
 *
 * Two coordinate frames coexist and never mix inside a leg: floor-scoped nodes
 * (asset/space/floor/core) carry FLOOR-LOCAL metres — the same frame as
 * EstateSpace polygons, origin at the plate centre — while building and site
 * nodes carry the estate's WORLD metres. There is still no transform to WGS84;
 * geo exists only on site nodes, and only when the caller supplies it.
 */
import type { EstateBuilding, EstateData, EstateFloor, EstateSpace } from '../estate/types';
import { haversineMeters } from './geo';

export type AutoNodeKind = 'site' | 'building' | 'floor' | 'space' | 'asset' | 'core';
export type AutoEdgeKind = 'walk' | 'door' | 'stairs' | 'outdoor';

export interface AutoNode {
  /** 'site:1001' | 'building:201' | 'floor:301' | 'space:401' | 'asset:9001' | 'core:201'. */
  id: string;
  kind: AutoNodeKind;
  /** The Facilio record id. Absent on a name-keyed site and on a synthetic core. */
  recordId?: number;
  label: string;
  buildingId?: number;
  floorId?: number;
  /** Floor-local metres for floor-scoped nodes; world metres for buildings/sites. */
  x?: number;
  z?: number;
  /** Facilio floor.floorlevel — drives the "per level" stair cost. */
  level?: number;
  geo?: { lat: number; lng: number };
}

export interface AutoEdge {
  id: string;
  from: string;
  to: string;
  /** All auto edges are bidirectional — containment has no one-way corridors. */
  kind: AutoEdgeKind;
  /** Infinity when the edge exists topologically but cannot be costed. */
  meters: number;
  outdoor?: boolean;
  /**
   * Kept in the graph rather than dropped, so a UI can say WHY two sites do
   * not route ("add geo to both sites") instead of showing a silent island.
   * Dijkstra skips these.
   */
  unroutable?: boolean;
  /**
   * A landmark somebody authored for this edge, applied from the overlay.
   * Never derived — if it is here, a human wrote it, which is exactly why it
   * outranks the generated phrasing.
   */
  instruction?: string;
}

export interface AutoGraph {
  nodes: AutoNode[];
  edges: AutoEdge[];
}

export type LegKind = 'indoor' | 'vertical' | 'outdoor';

export interface AutoLeg {
  kind: LegKind;
  floorId?: number;
  buildingId?: number;
  /** Floor-local for indoor/vertical legs, world for outdoor legs. */
  points: Array<{ x: number; z: number }>;
  /** Node ids in walking order, boundary nodes included. */
  nodes: string[];
  distanceM: number;
  instruction: string;
}

export type AutoRoute =
  | { unroutable?: false; legs: AutoLeg[]; distanceM: number }
  | { unroutable: true; reason: string };

/* ---------- tuning (metres) ---------- */

/** Stair travel per level of difference — the number the spec of a leg reports. */
const VERTICAL_M_PER_LEVEL = 4;
/**
 * Two plan rooms count as adjacent when their rectangles face each other within
 * a wall's thickness. 0.6 m matches the plan extractor's door-seal radius: the
 * same distance the flood fill jumps to merge rooms through an opening.
 */
const WALL_TOL_M = 0.6;
/** Shortest shared wall run that could plausibly hold a doorway. */
const DOORWAY_MIN_M = 0.9;
/** Crossing a building's entrance threshold. */
const BUILDING_DOOR_M = 5;
/** No outdoor hop is free — even "the site" is a short walk from the door. */
const OUTDOOR_MIN_M = 5;
/** Cost of a hop whose endpoints carry no geometry at all. */
const FALLBACK_WALK_M = 10;

/* ---------- small helpers ---------- */

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const dist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(bx - ax, bz - az);

/** Distance between two nodes when both have coords, else the fallback. */
function nodeDist(a: AutoNode, b: AutoNode, min: number): number {
  if (a.x == null || a.z == null || b.x == null || b.z == null) return FALLBACK_WALK_M;
  return Math.max(min, dist(a.x, a.z, b.x, b.z));
}

/** A space's walkable centre: plan centroid when measured, polygon mean otherwise. */
function spaceCenter(sp: EstateSpace): { x: number; z: number } | null {
  const cx = num(sp['centerX']);
  const cz = num(sp['centerZ']);
  if (cx != null && cz != null) return { x: cx, z: cz };
  if (Array.isArray(sp.polygon) && sp.polygon.length) {
    const xs = sp.polygon.map((p) => p[0]);
    const zs = sp.polygon.map((p) => p[1]);
    return {
      x: xs.reduce((a, b) => a + b, 0) / xs.length,
      z: zs.reduce((a, b) => a + b, 0) / zs.length,
    };
  }
  return null;
}

/** The rectangles a room occupies — the plan decomposition, or its polygon bbox. */
function spaceRects(sp: EstateSpace): number[][] | null {
  if (Array.isArray(sp.rects) && sp.rects.length) return sp.rects;
  if (Array.isArray(sp.polygon) && sp.polygon.length) {
    const xs = sp.polygon.map((p) => p[0]);
    const zs = sp.polygon.map((p) => p[1]);
    return [[Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]];
  }
  return null;
}

/**
 * Doorway candidate: some rectangle of A faces some rectangle of B across at
 * most a wall's thickness, with an overlap long enough for a door. This is the
 * cheap stand-in for re-running the extractor's flood fill with the seal on —
 * the seal is what actually joins rooms, but it is never recorded (see
 * planExtract.js), so we recover the same adjacency from the rects.
 */
function rectsShareWall(A: number[][], B: number[][]): boolean {
  for (const a of A) {
    for (const b of B) {
      const [ax0, az0, ax1, az1] = a;
      const [bx0, bz0, bx1, bz1] = b;
      const vGap = Math.min(Math.abs(ax1 - bx0), Math.abs(bx1 - ax0));
      if (vGap <= WALL_TOL_M && Math.min(az1, bz1) - Math.max(az0, bz0) >= DOORWAY_MIN_M) {
        return true;
      }
      const hGap = Math.min(Math.abs(az1 - bz0), Math.abs(bz1 - az0));
      if (hGap <= WALL_TOL_M && Math.min(ax1, bx1) - Math.max(ax0, bx0) >= DOORWAY_MIN_M) {
        return true;
      }
    }
  }
  return false;
}

const floorLevel = (f: EstateFloor): number =>
  typeof f.floorlevel === 'number' ? f.floorlevel : 0;

const floorLabel = (f: EstateFloor): string => f.tenantName || f.name;

/* ---------- build ---------- */

export interface AutoGraphOptions {
  /**
   * lat/lng per site, keyed by String(siteId) when the buildings carry one,
   * else by the site's name (buildEstate emits only siteName today). Sites
   * without geo still exist in the graph; the edges between them are marked
   * unroutable instead of guessed.
   */
  siteGeo?: Record<string, { lat: number; lng: number }>;
}

export function buildAutoGraph(estate: EstateData, opts: AutoGraphOptions = {}): AutoGraph {
  const nodes: AutoNode[] = [];
  const edges: AutoEdge[] = [];
  const siteGeo = opts.siteGeo ?? {};

  const addEdge = (
    from: string,
    to: string,
    kind: AutoEdgeKind,
    meters: number,
    extra?: Pick<AutoEdge, 'outdoor' | 'unroutable'>,
  ) => edges.push({ id: `${from}--${to}`, from, to, kind, meters, ...extra });

  /* Sites come from two places: the buildings' own site fields, and
     estate.siteNames — a site with no buildings yet is still a destination
     (the "walk over to the depot" case), it just has nothing indoors. */
  interface SiteAcc {
    key: string;
    label: string;
    recordId?: number;
    buildings: EstateBuilding[];
  }
  const sites = new Map<string, SiteAcc>();
  const siteKeyOfBuilding = new Map<number, string>();

  for (const b of estate.buildings) {
    const sid = typeof b.siteId === 'number' ? b.siteId : undefined;
    const label = b.siteName || (sid != null ? `Site ${sid}` : 'Site');
    const key = sid != null ? String(sid) : label;
    const acc = sites.get(key) ?? { key, label, recordId: sid, buildings: [] };
    acc.buildings.push(b);
    sites.set(key, acc);
    siteKeyOfBuilding.set(b.recordId, key);
  }
  for (const name of estate.siteNames) {
    if (![...sites.values()].some((s) => s.label === name)) {
      sites.set(name, { key: name, label: name, buildings: [] });
    }
  }

  const siteNodeId = (key: string) => `site:${key}`;

  for (const site of sites.values()) {
    const geo = siteGeo[site.key] ?? siteGeo[site.label];
    let x: number | undefined;
    let z: number | undefined;
    if (site.buildings.length) {
      x = site.buildings.reduce((a, b) => a + b.x, 0) / site.buildings.length;
      z = site.buildings.reduce((a, b) => a + b.z, 0) / site.buildings.length;
    }
    nodes.push({
      id: siteNodeId(site.key),
      kind: 'site',
      recordId: site.recordId,
      label: site.label,
      x,
      z,
      ...(geo ? { geo } : {}),
    });
  }

  for (const b of estate.buildings) {
    const bId = `building:${b.recordId}`;
    nodes.push({
      id: bId,
      kind: 'building',
      recordId: b.recordId,
      label: b.name,
      buildingId: b.recordId,
      x: b.x,
      z: b.z,
    });

    const siteKey = siteKeyOfBuilding.get(b.recordId);
    if (siteKey) {
      const site = nodes.find((n) => n.id === siteNodeId(siteKey));
      const meters =
        site?.x != null && site.z != null
          ? Math.max(OUTDOOR_MIN_M, dist(b.x, b.z, site.x, site.z))
          : OUTDOOR_MIN_M;
      addEdge(bId, siteNodeId(siteKey), 'outdoor', meters, { outdoor: true });
    }

    /* One stair core per building, at the plate centre — because a schematic
       building has no drawn stair, and even a plan-bound one has stairs only
       as raw polylines. A single hub cannot make EVERY floor pair cost exactly
       4 m/level, so edge weights anchor on the lowest floor (routes from the
       ground, the common case, are exact) and routeOnGraph re-measures the
       vertical leg as 4 m x level difference when it phrases the journey. */
    const levels = b.floors.map(floorLevel);
    const minLevel = levels.length ? Math.min(...levels) : 0;
    const coreId = `core:${b.recordId}`;
    if (b.floors.length > 1) {
      nodes.push({
        id: coreId,
        kind: 'core',
        label: 'Stair core',
        buildingId: b.recordId,
        x: 0,
        z: 0,
      });
    }

    let entry: EstateFloor | null = null;
    for (const f of b.floors) {
      if (!entry || floorLevel(f) < floorLevel(entry)) entry = f;
    }

    for (const f of b.floors) {
      const fId = `floor:${f.recordId}`;
      const centers = f.spaces
        .map(spaceCenter)
        .filter((c): c is { x: number; z: number } => c != null);
      /* The floor's circulation point is the mean of its room centres — always
         inside the rooms' bounding box, so a leg through it never leaves the
         floor it claims to be on. An empty floor falls back to the plate centre. */
      const fx = centers.length ? centers.reduce((a, c) => a + c.x, 0) / centers.length : 0;
      const fz = centers.length ? centers.reduce((a, c) => a + c.z, 0) / centers.length : 0;
      const floorNode: AutoNode = {
        id: fId,
        kind: 'floor',
        recordId: f.recordId,
        label: floorLabel(f),
        buildingId: b.recordId,
        floorId: f.recordId,
        level: floorLevel(f),
        x: fx,
        z: fz,
      };
      nodes.push(floorNode);

      if (b.floors.length > 1) {
        addEdge(
          fId,
          coreId,
          'stairs',
          Math.max(0.5, VERTICAL_M_PER_LEVEL * (floorLevel(f) - minLevel)),
        );
      }
      if (f === entry) addEdge(fId, `building:${b.recordId}`, 'walk', BUILDING_DOOR_M);

      const spaceNodes = new Map<number, AutoNode>();
      for (const sp of f.spaces) {
        const c = spaceCenter(sp);
        const spNode: AutoNode = {
          id: `space:${sp.recordId}`,
          kind: 'space',
          recordId: sp.recordId,
          label: sp.name,
          buildingId: b.recordId,
          floorId: f.recordId,
          level: floorLevel(f),
          ...(c ?? {}),
        };
        nodes.push(spNode);
        spaceNodes.set(sp.recordId, spNode);
        addEdge(spNode.id, fId, 'walk', nodeDist(spNode, floorNode, 1));
      }

      /* Doorway candidates — plan rooms only. Synthesised (schematic) rooms
         are a layout invention with no walls; claiming a doorway between two
         of them would be geometry we made up twice over. */
      const planSpaces = f.spaces.filter((sp) => sp.fromPlan === true);
      for (let i = 0; i < planSpaces.length; i++) {
        for (let j = i + 1; j < planSpaces.length; j++) {
          const A = spaceRects(planSpaces[i]);
          const B = spaceRects(planSpaces[j]);
          if (!A || !B || !rectsShareWall(A, B)) continue;
          const na = spaceNodes.get(planSpaces[i].recordId);
          const nb = spaceNodes.get(planSpaces[j].recordId);
          if (na && nb) addEdge(na.id, nb.id, 'door', nodeDist(na, nb, 1));
        }
      }

      for (const m of f.markers) {
        if (m.markerModuleName !== 'asset') continue; // WO pins ride on their asset
        const aNode: AutoNode = {
          id: `asset:${m.recordId}`,
          kind: 'asset',
          recordId: m.recordId,
          label: m.name || m.code || `Asset #${m.recordId}`,
          buildingId: b.recordId,
          floorId: f.recordId,
          level: floorLevel(f),
          ...(m.x != null && m.z != null ? { x: m.x, z: m.z } : {}),
        };
        nodes.push(aNode);
        const owner = m.spaceId != null ? spaceNodes.get(m.spaceId) : undefined;
        /* Site-level plant sits on the corridor with spaceId null — it hangs
           off the floor's circulation point instead of a room. */
        addEdge(aNode.id, owner ? owner.id : fId, 'walk', nodeDist(aNode, owner ?? floorNode, 1));
      }
    }
  }

  /* Site-to-site: real distance when both ends are geolocated, and an honest
     "exists but uncosted" edge when not — Infinity, never a guess. */
  const siteList = [...sites.values()];
  const geoOf = (s: SiteAcc) => siteGeo[s.key] ?? siteGeo[s.label];
  for (let i = 0; i < siteList.length; i++) {
    for (let j = i + 1; j < siteList.length; j++) {
      const ga = geoOf(siteList[i]);
      const gb = geoOf(siteList[j]);
      if (ga && gb) {
        addEdge(
          siteNodeId(siteList[i].key),
          siteNodeId(siteList[j].key),
          'outdoor',
          Math.max(OUTDOOR_MIN_M, haversineMeters(ga, gb)),
          { outdoor: true },
        );
      } else {
        addEdge(siteNodeId(siteList[i].key), siteNodeId(siteList[j].key), 'outdoor', Infinity, {
          outdoor: true,
          unroutable: true,
        });
      }
    }
  }

  return { nodes, edges };
}

/* ---------- routing ---------- */

interface Hop {
  a: AutoNode;
  b: AutoNode;
  meters: number;
}

const hopKind = (h: Hop): LegKind => {
  if (h.a.kind === 'core' || h.b.kind === 'core') return 'vertical';
  if (
    h.a.kind === 'site' ||
    h.a.kind === 'building' ||
    h.b.kind === 'site' ||
    h.b.kind === 'building'
  ) {
    return 'outdoor';
  }
  return 'indoor';
};

/* ---------------- the router's working set ----------------
   This used to say "these graphs are small". They are not: every asset in the
   portfolio is a node, so V tracks the asset register, and the cost showed up
   exactly where it hurts — a far route, which is the one somebody asks for when
   they do not know the building.

   Measured on the compiled module before this change: 8,821 nodes → 795ms;
   21,101 nodes → 5,104ms; 84,401 nodes → 94,083ms. A cross-site refusal paid it
   twice, because distinguishing "no path" from "the site hop needs geo" runs a
   second search. Two things were quadratic-ish and one was pure repetition:
   selection scanned the whole distance map every iteration, and the adjacency
   and node index were rebuilt from scratch on every single call. */

/** Binary min-heap with lazy deletion — no decrease-key, just push duplicates. */
class MinHeap {
  private items: Array<{ id: string; d: number }> = [];

  push(id: string, d: number): void {
    const a = this.items;
    a.push({ id, d });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].d <= a[i].d) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }

  pop(): { id: string; d: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as { id: string; d: number };
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < a.length && a[l].d < a[small].d) small = l;
        if (r < a.length && a[r].d < a[small].d) small = r;
        if (small === i) break;
        [a[small], a[i]] = [a[i], a[small]];
        i = small;
      }
    }
    return top;
  }
}

type Adjacency = Map<string, Array<{ to: string; meters: number }>>;

/**
 * Per-graph caches.
 *
 * A WeakMap keyed on the graph object, so nothing is retained once a rebuild
 * replaces it — and the graph IS replaced wholesale on every rebuild, which is
 * what makes caching safe here: an AutoGraph is derived and never mutated in
 * place, so a cached index cannot go stale behind a caller's back.
 */
const graphCache = new WeakMap<
  AutoGraph,
  { byId?: Map<string, AutoNode>; strict?: Adjacency; permissive?: Adjacency }
>();

function cacheFor(graph: AutoGraph) {
  let entry = graphCache.get(graph);
  if (!entry) {
    entry = {};
    graphCache.set(graph, entry);
  }
  return entry;
}

function nodeIndex(graph: AutoGraph): Map<string, AutoNode> {
  const entry = cacheFor(graph);
  entry.byId ??= new Map(graph.nodes.map((n) => [n.id, n]));
  return entry.byId;
}

function adjacency(graph: AutoGraph, allowUnroutable: boolean): Adjacency {
  const entry = cacheFor(graph);
  const key = allowUnroutable ? 'permissive' : 'strict';
  const cached = entry[key];
  if (cached) return cached;

  const adj: Adjacency = new Map();
  const push = (from: string, to: string, meters: number) => {
    const list = adj.get(from);
    if (list) list.push({ to, meters });
    else adj.set(from, [{ to, meters }]);
  };
  for (const e of graph.edges) {
    if (e.unroutable || !Number.isFinite(e.meters)) {
      if (!allowUnroutable) continue;
      // A nominal cost, only used to answer "WOULD there be a path" for the reason text.
      push(e.from, e.to, FALLBACK_WALK_M);
      push(e.to, e.from, FALLBACK_WALK_M);
      continue;
    }
    push(e.from, e.to, e.meters);
    push(e.to, e.from, e.meters);
  }
  entry[key] = adj;
  return adj;
}

function shortestPath(
  graph: AutoGraph,
  fromId: string,
  toId: string,
  allowUnroutable: boolean,
): Hop[] | null {
  const byId = nodeIndex(graph);
  const adj = adjacency(graph, allowUnroutable);

  const distTo = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { node: string; meters: number }>();
  const settled = new Set<string>();
  const queue = new MinHeap();
  queue.push(fromId, 0);

  for (;;) {
    const top = queue.pop();
    if (!top) break;
    // Lazy deletion: a node can sit in the heap several times, once per
    // improvement. The first pop is the real one; later copies are stale.
    if (settled.has(top.id)) continue;
    if (top.id === toId) break;
    settled.add(top.id);
    const best = top.d;
    for (const { to, meters } of adj.get(top.id) ?? []) {
      if (settled.has(to)) continue;
      const candidate = best + meters;
      if (candidate < (distTo.get(to) ?? Infinity)) {
        distTo.set(to, candidate);
        prev.set(to, { node: top.id, meters });
        queue.push(to, candidate);
      }
    }
  }

  if (!prev.has(toId)) return null;
  const hops: Hop[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const hop = prev.get(cursor);
    if (!hop) return null;
    const a = byId.get(hop.node);
    const b = byId.get(cursor);
    if (!a || !b) return null;
    hops.unshift({ a, b, meters: hop.meters });
    cursor = hop.node;
  }
  return hops;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Which site a node belongs to.
 *
 * AutoNode carries buildingId and floorId but no siteId, so this walks the
 * containment edge the builder already drew: building → site. Exists because a
 * screen that knows an asset knows its site too, and asking the user to pick the
 * site it just told them about is the difference between one tap and four.
 *
 * Undefined for a node with no building (a site-level asset, a bare site) —
 * callers treat that as "cannot narrow", never as an error.
 */
export function siteOfNode(graph: AutoGraph, node: AutoNode): AutoNode | undefined {
  if (node.kind === 'site') return node;
  if (node.buildingId == null) return undefined;
  const buildingId = `building:${node.buildingId}`;
  for (const e of graph.edges) {
    const other = e.from === buildingId ? e.to : e.to === buildingId ? e.from : null;
    if (other?.startsWith('site:')) return graph.nodes.find((n) => n.id === other);
  }
  return undefined;
}

/**
 * The edge a leg ARRIVES on — the one a landmark is written against.
 *
 * Looked up by endpoints because a Hop carries no edge id and this is not a hot
 * path; threading the id through Dijkstra to save a scan of a small edge list
 * would be the wrong trade. Exported so the screen's "add a landmark" control
 * and the phrasing below can never disagree about which edge that is.
 */
export function legEdge(graph: AutoGraph, leg: Pick<AutoLeg, 'nodes'>): AutoEdge | undefined {
  if (leg.nodes.length < 2) return undefined;
  const a = leg.nodes[leg.nodes.length - 2];
  const b = leg.nodes[leg.nodes.length - 1];
  return graph.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

export function routeOnGraph(graph: AutoGraph, fromId: string, toId: string): AutoRoute {
  // Shared with the search rather than rebuilt: routeOnGraph runs on every
  // render that changes an endpoint, and this map is the whole node list.
  const byId = nodeIndex(graph);
  const start = byId.get(fromId);
  const goal = byId.get(toId);
  if (!start) return { unroutable: true, reason: `unknown node "${fromId}"` };
  if (!goal) return { unroutable: true, reason: `unknown node "${toId}"` };
  if (fromId === toId) return { legs: [], distanceM: 0 };

  const hops = shortestPath(graph, fromId, toId, false);
  if (!hops) {
    /* Distinguish "no edges at all" from "the only way through is an uncosted
       site hop" — the second has a fix the user can actually do. */
    const wouldConnect = shortestPath(graph, fromId, toId, true) != null;
    return {
      unroutable: true,
      reason: wouldConnect
        ? `no routable path from "${start.label}" to "${goal.label}" — the connecting site-to-site hop needs geo (lat/lng) on both sites`
        : `no path from "${start.label}" to "${goal.label}" — the graph has no connecting edges`,
    };
  }

  /* Group hops into legs: consecutive hops of one movement kind, indoor runs
     further split per floor so a leg's points stay in one coordinate frame. */
  interface RawLeg {
    kind: LegKind;
    hops: Hop[];
  }
  const rawLegs: RawLeg[] = [];
  for (const hop of hops) {
    const kind = hopKind(hop);
    const last = rawLegs[rawLegs.length - 1];
    const sameFloor =
      kind !== 'indoor' ||
      (last?.hops[0] && last.hops[0].a.floorId === (hop.a.floorId ?? hop.b.floorId));
    if (last && last.kind === kind && sameFloor) last.hops.push(hop);
    else rawLegs.push({ kind, hops: [hop] });
  }

  const legs: AutoLeg[] = rawLegs.map((leg) => {
    const legNodes: AutoNode[] = [leg.hops[0].a, ...leg.hops.map((h) => h.b)];
    const first = legNodes[0];
    const last = legNodes[legNodes.length - 1];

    let distanceM = leg.hops.reduce((a, h) => a + h.meters, 0);
    if (leg.kind === 'vertical' && first.level != null && last.level != null) {
      // Re-measured from the real levels; the hub's edge weights are only ranking.
      distanceM = VERTICAL_M_PER_LEVEL * Math.abs(last.level - first.level);
    }

    const pointNodes =
      leg.kind === 'outdoor'
        ? legNodes.filter((n) => n.kind === 'building' || n.kind === 'site')
        : legNodes;
    const points = pointNodes
      .filter((n) => n.x != null && n.z != null)
      .map((n) => ({ x: n.x as number, z: n.z as number }));

    const floorScoped = legNodes.find((n) => n.floorId != null);
    return {
      kind: leg.kind,
      ...(leg.kind === 'indoor' && floorScoped ? { floorId: floorScoped.floorId } : {}),
      ...(legNodes.find((n) => n.buildingId != null)
        ? { buildingId: legNodes.find((n) => n.buildingId != null)?.buildingId }
        : {}),
      points,
      nodes: legNodes.map((n) => n.id),
      distanceM: round1(distanceM),
      instruction: '', // phrased below, with lookahead
    };
  });

  const nodeById = (id: string) => byId.get(id) as AutoNode;
  const authoredFor = (leg: AutoLeg): string | undefined =>
    legEdge(graph, leg)?.instruction?.trim() || undefined;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const next = legs[i + 1];
    const last = nodeById(leg.nodes[leg.nodes.length - 1]);
    // A human's landmark beats every generated sentence below. This is the rule
    // the survey lane has always had and the derived graph never did.
    const authored = authoredFor(leg);
    if (authored) {
      leg.instruction = authored;
      continue;
    }
    if (leg.kind === 'vertical') {
      leg.instruction = `Take stairs to ${last.label}`;
    } else if (leg.kind === 'outdoor') {
      const target =
        [...leg.nodes]
          .map(nodeById)
          .reverse()
          .find((n) => n.kind === 'building' || n.kind === 'site') ?? last;
      leg.instruction = `Walk to ${target.label}`;
    } else if (next?.kind === 'vertical') {
      leg.instruction = `Head to ${nodeById(next.nodes[1]).label}`;
    } else if (next?.kind === 'outdoor') {
      leg.instruction = 'Head to the exit';
    } else {
      leg.instruction = `Walk to ${last.label}`;
    }
  }

  return { legs, distanceM: round1(legs.reduce((a, l) => a + l.distanceM, 0)) };
}

/* ---------- lookup ---------- */

/**
 * Case-insensitive name/id lookup, ranked: exact id, exact label, label
 * prefix, label substring, id substring. Ties break toward the shorter label —
 * "Pump 7" over "Pump 7 isolation valve" for the query "pump".
 */
export function findNode(graph: AutoGraph, query: string): AutoNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ n: AutoNode; s: number }> = [];
  for (const n of graph.nodes) {
    const label = n.label.toLowerCase();
    const id = n.id.toLowerCase();
    const s =
      id === q
        ? 100
        : label === q
          ? 90
          : label.startsWith(q)
            ? 70
            : label.includes(q)
              ? 50
              : id.includes(q)
                ? 25
                : 0;
    if (s > 0) scored.push({ n, s });
  }
  return scored
    .sort(
      (a, b) =>
        b.s - a.s || a.n.label.length - b.n.label.length || a.n.label.localeCompare(b.n.label),
    )
    .map((e) => e.n);
}
