/**
 * The journey model — what the Wayfinder screen is ABOUT, kept pure.
 *
 * Research grounding (docs/WAYFINDING.md): technicians are repeat users of the
 * same buildings, and the strongest field study on offer (n=422) found route
 * PREVIEW preferred over forced turn-by-turn by exactly that population — so
 * preview is the default and guided mode is opt-in. Positioning is discrete
 * (you are where you last scanned), so progress NEVER advances on its own:
 * a tap says "done", a scan PROVES "here", and the two must never disagree —
 * a scan wins.
 */
import type { Route, RouteStep } from './router';
import type { WayNode } from './graph';

/** Where the technician is, and how honestly we know it. */
export interface Anchor {
  nodeId: string;
  /** scan = proved by a code; gps = nearest entrance guess; pick = chosen by hand. */
  via: 'scan' | 'gps' | 'pick';
  /** epoch ms when this became true. Scans age; the UI must show it. */
  at: number;
}

/** What the route is aimed at. The node is the routable fact; the asset is
 * the reason (and what the AR arrow will point at after arrival). */
export interface Destination {
  nodeId: string;
  label: string;
  assetId?: number;
  workOrderId?: number;
}

export type JourneyPhase = 'preview' | 'guided' | 'arrived';

/** A scan is fresh for 5 minutes, then visibly stale — never silently wrong. */
export const ANCHOR_FRESH_MS = 5 * 60_000;

export function anchorAgeText(anchor: Anchor, now = Date.now()): string {
  if (anchor.via === 'gps') return 'nearest entrance by GPS';
  if (anchor.via === 'pick') return 'set by hand';
  const mins = Math.floor((now - anchor.at) / 60_000);
  if (mins < 1) return 'scanned just now';
  if (mins === 1) return 'scanned 1 min ago';
  return `scanned ${mins} min ago`;
}

export function anchorIsStale(anchor: Anchor, now = Date.now()): boolean {
  return anchor.via === 'scan' && now - anchor.at > ANCHOR_FRESH_MS;
}

/**
 * Walking-time estimate, deliberately conservative (a technician carries
 * tools). Distance-less steps fall back to each kind's typical length, and
 * vertical transport pays a fixed wait/ride overhead — a lift is mostly
 * waiting, not walking.
 */
const WALK_M_PER_S = 1.2;
const FALLBACK_METERS = { walk: 25, door: 4, stairs: 12, lift: 8 } as const;
const VERTICAL_OVERHEAD_S = { stairs: 25, lift: 45 } as const;

export function estimateSeconds(steps: RouteStep[]): number {
  let seconds = 0;
  for (const step of steps) {
    const meters = step.meters ?? FALLBACK_METERS[step.edge.kind];
    seconds += meters / WALK_M_PER_S;
    if (step.edge.kind === 'lift' || step.edge.kind === 'stairs') {
      seconds += VERTICAL_OVERHEAD_S[step.edge.kind];
    }
  }
  return Math.round(seconds);
}

export function minutesText(seconds: number): string {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  return `~${mins} min`;
}

/** A floor change is the highest-error moment indoors — it gets its own
 * interstitial treatment in the UI, so the render layer asks here. */
export function isFloorChange(step: RouteStep): boolean {
  return step.edge.kind === 'lift' || step.edge.kind === 'stairs';
}

/** Human label for the floor a step lands on, for phase headers. */
function floorLabelOf(node: WayNode): string | null {
  if (node.floorLevel != null) return `Level ${node.floorLevel}`;
  return null;
}

export interface FloorPhase {
  /** "Level 3" when known, else null (single-phase routes don't label). */
  label: string | null;
  startIndex: number;
  count: number;
}

/**
 * Group consecutive steps into per-floor phases (working-memory research puts
 * the chunk limit around four segments — phases are how a long route stays
 * readable). A vertical step belongs to the phase it ARRIVES at.
 */
export function floorPhases(steps: RouteStep[]): FloorPhase[] {
  const phases: FloorPhase[] = [];
  // Survey-derived nodes carry no floorLevel, so a known label persists until
  // a node that DOES know its level says otherwise — walking within a floor
  // must not lose the phase.
  let current: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    current = floorLabelOf(steps[i].to) ?? floorLabelOf(steps[i].from) ?? current;
    const last = phases[phases.length - 1];
    if (last && last.label === current) last.count += 1;
    else phases.push({ label: current, startIndex: i, count: 1 });
  }
  return phases;
}

/**
 * Where a scanned node lands on the route: the index of the first step that
 * DEPARTS from it (you now stand there, that step is next), the step count
 * when it is the destination, or null when it is off this route entirely.
 */
export function progressForNode(route: Route, startNodeId: string, scannedNodeId: string): number | null {
  if (route.destination.id === scannedNodeId) return route.steps.length;
  if (startNodeId === scannedNodeId) return 0;
  const index = route.steps.findIndex((s) => s.from.id === scannedNodeId);
  return index >= 0 ? index : null;
}

/**
 * The arrival phase implied by the current route.
 *
 * Pure and total, which is the entire point: the screen used to inline this as
 * two `if`s that both required a route to EXIST, so the `route === null` case —
 * the normal answer for any standpoint with no authored edges, which is every
 * standpoint created in the AR tab — fell through and left the phase untouched.
 * A technician who arrived at the plant room and then scanned an unconnected
 * standpoint kept "You've arrived" on screen, with the AR handoff still offered,
 * at a place the asset is not.
 *
 * No route means "not arrived" exactly as loudly as a long one. Only a route
 * with zero steps left is arrival, because only that is evidence of it.
 */
export function arrivalPhase(
  route: { steps: unknown[] } | null | undefined,
  phase: JourneyPhase,
): JourneyPhase {
  if (route && route.steps.length === 0) return 'arrived';
  return phase === 'arrived' ? 'preview' : phase;
}
