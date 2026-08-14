/**
 * The conversational Wayfinder — the pure half.
 *
 * The AI lane's first job is NOT language: most requests name a real place,
 * and the portfolio graph can answer those instantly, offline, and without
 * ever inventing a location. Only what deterministic resolution cannot hold
 * goes on to the agent lanes the screen already runs.
 *
 * Everything here resolves against actual graph nodes. A destination that is
 * not a node cannot be offered — that is the no-fabrication rule, enforced by
 * construction rather than by prompt.
 */
import type { AutoGraph, AutoNode, AutoRoute } from './autoGraph';
import { findNode } from './autoGraph';

export interface WfChip {
  label: string;
  action:
    | { kind: 'pick-node'; nodeId: string }
    | { kind: 'show-3d' }
    | { kind: 'guide-outdoor' }
    | { kind: 'arrived' };
}

export interface WfMessage {
  role: 'user' | 'ai';
  text: string;
  chips?: WfChip[];
  at: number;
}

const CHAT_KEY = 'fv.wayfinder.chat';

export function loadChat(): WfMessage[] {
  try {
    const raw = sessionStorage.getItem(CHAT_KEY);
    const parsed = raw ? (JSON.parse(raw) as WfMessage[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    return [];
  }
}

export function storeChat(messages: WfMessage[]): void {
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-40)));
  } catch {
    /* storage full or blocked — the thread just won't survive a reload */
  }
}

/* ---------- floor references ---------- */

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

export interface FloorRef {
  /** The number said ("floor 9", "9th floor", "level 9", "L9"). */
  level?: number;
  /** "ground floor" — matched by name, not number. */
  ground?: boolean;
  /** The query with the floor phrase removed, for name matching. */
  rest: string;
}

/** Pull a floor reference out of a request, if one is there. */
export function parseFloorRef(text: string): FloorRef {
  let rest = text;
  let level: number | undefined;
  let ground = false;

  const pats: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [/\b(?:on\s+)?(?:the\s+)?(\d+)(?:st|nd|rd|th)?\s+floor\b/i, (m) => { level = Number(m[1]); }],
    [/\bfloor\s+(\d+)\b/i, (m) => { level = Number(m[1]); }],
    [/\blevel\s+(\d+)\b/i, (m) => { level = Number(m[1]); }],
    [/\bL(\d+)\b/, (m) => { level = Number(m[1]); }],
    [
      new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(${Object.keys(ORDINALS).join('|')})\\s+floor\\b`, 'i'),
      (m) => { level = ORDINALS[m[1].toLowerCase()]; },
    ],
    [/\b(?:on\s+)?(?:the\s+)?ground\s+floor\b/i, () => { ground = true; }],
  ];
  for (const [re, take] of pats) {
    const m = rest.match(re);
    if (m) {
      take(m);
      rest = rest.replace(re, ' ');
      break;
    }
  }
  // Conversational shell words add nothing to a name search.
  rest = rest
    .replace(/\b(take me to|navigate to|route( me)? to|go to|where is|show me|find|i need to go to|directions? to|the|a|an)\b/gi, ' ')
    .replace(/[?.!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { level, ground, rest };
}

/* ---------- destination resolution ---------- */

export type Resolution =
  | { kind: 'one'; node: AutoNode }
  | { kind: 'many'; candidates: AutoNode[]; question: string }
  | { kind: 'none' };

/** Does this node sit on a floor matching the reference? */
function onFloor(graph: AutoGraph, node: AutoNode, ref: FloorRef): boolean {
  if (ref.level == null && !ref.ground) return true;
  if (node.kind === 'floor') {
    return matchesFloor(node, ref);
  }
  if (node.floorId == null) return false;
  const floor = graph.nodes.find((n) => n.kind === 'floor' && n.recordId === node.floorId);
  return !!floor && matchesFloor(floor, ref);
}

function matchesFloor(floor: AutoNode, ref: FloorRef): boolean {
  if (ref.ground) return /\bground\b|^g$/i.test(floor.label);
  if (ref.level == null) return true;
  if (floor.level === ref.level) return true;
  // Floors are often named "Floor 9" / "L9" while floorlevel is unset or 0-based.
  return new RegExp(`(?:^|\\b)(?:floor\\s*|l|level\\s*)${ref.level}(?:\\b|$)`, 'i').test(floor.label);
}

/**
 * Resolve a natural request against the portfolio. Deterministic and
 * side-effect free: one match is an answer, several are a question with the
 * real options, none is an honest none — never a guess presented as fact.
 */
export function resolvePortfolio(graph: AutoGraph | null, text: string): Resolution {
  if (!graph) return { kind: 'none' };
  const ref = parseFloorRef(text);
  const q = ref.rest || text.trim();
  if (q.length < 2) return { kind: 'none' };

  let hits = findNode(graph, q).filter((n) => n.kind !== 'core');
  // "plant room on mechanical floor" — a NAMED floor the numeric parser can't
  // strip. Retry the left of " on " for the place, and keep the right side as
  // a filter word against the floor's label.
  if (hits.length === 0 && / on /i.test(q)) {
    const [place, where] = q.split(/ on /i).map((s) => s.trim());
    hits = findNode(graph, place).filter((n) => n.kind !== 'core');
    if (where) {
      const scoped = hits.filter((n) => {
        if (n.floorId == null) return false;
        const floor = graph.nodes.find((f) => f.kind === 'floor' && f.recordId === n.floorId);
        return !!floor && floor.label.toLowerCase().includes(where.replace(/\bfloor\b/i, '').trim().toLowerCase());
      });
      if (scoped.length > 0) hits = scoped;
    }
  }
  if (ref.level != null || ref.ground) hits = hits.filter((n) => onFloor(graph, n, ref));
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'one', node: hits[0] };

  // Identical labels (an "AHU" per floor) need the floor to tell them apart.
  const seen = new Set<string>();
  const distinct = hits.filter((n) => {
    const key = `${n.kind}:${n.label.toLowerCase()}:${n.floorId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (distinct.length === 1) return { kind: 'one', node: distinct[0] };
  return {
    kind: 'many',
    candidates: distinct.slice(0, 4),
    question: `I found ${distinct.length} matches. Which one do you need?`,
  };
}

/** "Tower B · Floor 2" — enough context to tell twins apart on a chip. */
export function nodeWhere(graph: AutoGraph, node: AutoNode): string {
  const parts: string[] = [];
  if (node.buildingId != null) {
    const b = graph.nodes.find((n) => n.kind === 'building' && n.recordId === node.buildingId);
    if (b) parts.push(b.label);
  }
  if (node.floorId != null) {
    const f = graph.nodes.find((n) => n.kind === 'floor' && n.recordId === node.floorId);
    if (f) parts.push(f.label);
  }
  return parts.join(' · ') || node.kind;
}

/* ---------- route → words ---------- */

export function routeText(route: AutoRoute, toLabel: string): string {
  if (route.unroutable) return '';
  const steps = route.legs.map((leg) => leg.instruction);
  const total = Math.round(route.distanceM);
  return `Route to ${toLabel} — about ${total} m:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

/**
 * No drawable route — say so, then give the best real guidance the hierarchy
 * holds. Composed only from nodes that exist; the wording admits the limit
 * instead of dressing a guess as a route.
 */
export function fallbackGuidance(graph: AutoGraph, dest: AutoNode): string {
  const bits: string[] = [`I couldn't draw an automatic route to ${dest.label}.`];
  const building = dest.buildingId != null
    ? graph.nodes.find((n) => n.kind === 'building' && n.recordId === dest.buildingId)
    : undefined;
  const floor = dest.floorId != null
    ? graph.nodes.find((n) => n.kind === 'floor' && n.recordId === dest.floorId)
    : undefined;
  if (building) bits.push(`Head to ${building.label}.`);
  if (floor) {
    const hasCore = building?.recordId != null &&
      graph.nodes.some((n) => n.kind === 'core' && n.buildingId === building.recordId);
    bits.push(hasCore ? `Take the stairs or lift to ${floor.label}.` : `Go to ${floor.label}.`);
  }
  if (dest.kind === 'asset' || dest.kind === 'space') {
    bits.push(`${dest.label} is on that floor — ask on site, or open the floor in 3D to see its position.`);
  }
  return bits.join(' ');
}

/* ---------- the 3D handoff payload ---------- */

export interface PendingRoutePayload {
  legs: Array<{ kind: 'indoor' | 'outdoor'; buildingId?: string; floorId?: number; points: { x: number; z: number }[] }>;
  dest?: { kind: 'asset' | 'space'; recordId: number };
}

/** What the estate screen needs to draw, fly AND highlight — stable ids only. */
export function handoffPayload(
  legs: PendingRoutePayload['legs'],
  dest: AutoNode | null,
): PendingRoutePayload {
  const payload: PendingRoutePayload = { legs };
  if (dest && (dest.kind === 'asset' || dest.kind === 'space') && dest.recordId != null) {
    payload.dest = { kind: dest.kind, recordId: dest.recordId };
  }
  return payload;
}
