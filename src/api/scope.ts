/**
 * What the signed-in person may SEE, applied in the data layer.
 *
 * This is `recordPolicy.js` for people instead of records, and it is deliberate
 * that it lives here rather than in the screens: there are eight separate
 * work-order read paths (five screens, the AR window, the voice tool loop and
 * the 3D estate's own raw payload), and a rule applied in the seam is one every
 * caller inherits — including the ones nobody remembers to update, and
 * including a URL typed by hand.
 *
 * Admins are unfiltered. Technicians see work assigned to them and the assets,
 * rooms, floors and buildings that work touches — nothing else.
 *
 * EMAIL is the key that actually works, and that is now measured rather than
 * assumed. Work order 14275667 — the first in org #2915 ever assigned — carries
 * `assignedTo: {id: 2282340, name, email}`, and 2282340 is a THIRD id space:
 * not the org user id (2281806, what createdBy carries) and not the employee
 * record id (11038324195, what list-employees returns). Matching on either id
 * alone would have shown that technician nothing at all.
 *
 * So the id comparisons stay as a fallback for orgs whose assignment points
 * somewhere this one's does not, but the email is what carries it — compared
 * here in JS because a '+' in an address breaks a server-side filter
 * (ONBOARDING §6). If none of the three are present, the row is not mine: it
 * fails closed, never open. The real row shape is pinned in scope.test.ts.
 */
import type { Role } from './roles';
import type { WorkOrder, Asset, Space } from './types';

export interface SessionScope {
  role: Role;
  /** Org user id from getCurrentUser(). */
  uid?: number;
  /** Employee record id — the id space work-order assignment actually uses. */
  employeeId?: number;
  email?: string;
}

/**
 * Deny until a session says otherwise. A read that somehow beats the session
 * resolution returns nothing rather than everything.
 */
const DENY: SessionScope = { role: 'technician' };

let current: SessionScope = DENY;

/**
 * Bumped on every scope change so derived work (the real provider memoises one
 * work-order sweep per session) can tell a stale answer from a current one.
 * Without it, signing in as someone else would keep the previous person's world.
 */
let generation = 0;

export function setSessionScope(next: SessionScope): void {
  current = next;
  generation += 1;
}

export function sessionScope(): SessionScope {
  return current;
}

export function scopeGeneration(): number {
  return generation;
}

/** Test seam — restores the deny-by-default state between cases. */
export function resetSessionScope(): void {
  current = DENY;
  generation += 1;
}

/**
 * Rows arrive in three shapes: a mapped WorkOrder, a raw row with an expanded
 * lookup object, and a raw row with a bare id where the expand did not apply.
 * One extractor so every caller agrees on what "the assignee" means.
 */
interface AssigneeLike {
  assignedToId?: number;
  assignedToEmail?: string;
  assignedTo?: unknown;
}

function assigneeOf(row: AssigneeLike): { id?: number; email?: string } {
  const raw = row.assignedTo;
  if (typeof raw === 'number') return { id: row.assignedToId ?? raw, email: row.assignedToEmail };
  if (raw && typeof raw === 'object') {
    const lookup = raw as { id?: number; email?: string };
    return {
      id: row.assignedToId ?? lookup.id,
      email: row.assignedToEmail ?? lookup.email,
    };
  }
  return { id: row.assignedToId, email: row.assignedToEmail };
}

function sameEmail(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isMine(row: AssigneeLike, scope: SessionScope = current): boolean {
  const { id, email } = assigneeOf(row);
  if (id !== undefined) {
    if (scope.employeeId !== undefined && id === scope.employeeId) return true;
    if (scope.uid !== undefined && id === scope.uid) return true;
  }
  return sameEmail(email, scope.email);
}

/**
 * Idempotent, like `visibleRows` — filtering a filtered list is the same list,
 * so a defensive second pass downstream costs nothing and can never be wrong.
 */
export function visibleWorkOrders<T extends AssigneeLike>(
  rows: T[] | undefined,
  scope: SessionScope = current,
): T[] {
  if (scope.role === 'admin') return rows ?? [];
  return (rows ?? []).filter((row) => isMine(row, scope));
}

/** The assets a set of work orders is raised against — a technician's whole world. */
export function assetIdsFrom(workOrders: { resourceId?: number }[] | undefined): Set<number> {
  const ids = new Set<number>();
  for (const wo of workOrders ?? []) if (wo.resourceId !== undefined) ids.add(wo.resourceId);
  return ids;
}

export interface AllowedPlaces {
  spaceIds: Set<number>;
  floorIds: Set<number>;
  buildingIds: Set<number>;
  siteIds: Set<number>;
}

/**
 * Walk from the technician's assets up to the places that contain them.
 *
 * An asset's space pointer can target ANY level of the tree — site, building,
 * floor or leaf space (realProvider's resolveScopeSpaceIds says so, and fixture
 * asset 3006 parents straight to a site) — so every level is collected from
 * whatever the pointer happens to hit, plus that space's own ancestry.
 */
export function allowedPlaces(
  assets: Asset[] | undefined,
  spaces: Space[] | undefined,
  assetIds: Set<number>,
): AllowedPlaces {
  const places: AllowedPlaces = {
    spaceIds: new Set(),
    floorIds: new Set(),
    buildingIds: new Set(),
    siteIds: new Set(),
  };
  const byId = new Map<number, Space>();
  for (const space of spaces ?? []) byId.set(space.id, space);

  for (const asset of assets ?? []) {
    if (!assetIds.has(asset.id) || asset.spaceId === undefined) continue;
    const pointer = asset.spaceId;
    places.spaceIds.add(pointer);
    // The pointer may itself BE a floor/building/site id, so record it at every
    // level it could belong to, then add the ancestry the space row reports.
    const space = byId.get(pointer);
    if (space) {
      if (space.floorId !== undefined) places.floorIds.add(space.floorId);
      if (space.buildingId !== undefined) places.buildingIds.add(space.buildingId);
      if (space.siteId !== undefined) places.siteIds.add(space.siteId);
    }
    places.floorIds.add(pointer);
    places.buildingIds.add(pointer);
    places.siteIds.add(pointer);
  }
  return places;
}

/** Assets a technician may see: the ones their work orders are raised against. */
export function visibleAssets(
  assets: Asset[] | undefined,
  assetIds: Set<number>,
  scope: SessionScope = current,
): Asset[] {
  if (scope.role === 'admin') return assets ?? [];
  return (assets ?? []).filter((asset) => assetIds.has(asset.id));
}

/** True when a work order is readable by this session — the getWorkOrder guard. */
export function canReadWorkOrder(wo: WorkOrder | null, scope: SessionScope = current): boolean {
  if (!wo) return false;
  return scope.role === 'admin' || isMine(wo, scope);
}
