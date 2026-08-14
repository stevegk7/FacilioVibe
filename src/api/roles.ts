/**
 * Who the signed-in person is allowed to be, and what that lets them do.
 *
 * The platform will not tell us. `getCurrentUser()` returns four fields and an
 * orgId (types.ts CurrentUser) with no role on it, and the CMMS employee module
 * has no `role` field at all — asking for one fails loudly with INVALID_FIELD.
 * So role, like `permissions.ts` before it, is an APP setting: a list of admin
 * emails in the app's own KV store, editable by an admin in Settings.
 *
 * Two deliberate differences from permissions.ts, both because this gate is
 * about seeing other people's work rather than placing a marker:
 *
 * 1. It is DENY by default. An email nobody has listed is a technician. That is
 *    the safe direction for a gate whose whole job is to stop one technician
 *    reading another's work.
 *
 * 2. Deny-by-default plus a KV store that degrades to empty (appStore.ts reads
 *    swallow a missing function) would lock EVERY admin out of the very screen
 *    that edits the list — including the day fvApi is not yet promoted on a
 *    channel. So BOOTSTRAP_ADMINS resolves without touching the store at all,
 *    and a resolution carries WHERE it came from, so the UI can say "couldn't
 *    read permissions" instead of quietly demoting someone.
 */
import { appStore, appStoreUnavailable } from './appStore';

export type Role = 'admin' | 'technician';

/**
 * Admins of last resort. These resolve before the store is consulted, so the
 * org can never lock itself out of Settings — a real risk under deny-by-default.
 * Keep it short; everyone else belongs in the editable list.
 */
export const BOOTSTRAP_ADMINS: readonly string[] = ['yaaminy.sk+vibeathon2026@facilio.com'];

/**
 * A capability is a thing you can DO, not a screen you can see. Screens come
 * and go; "may reassign someone else's work order" is the durable question, and
 * naming it here keeps the answer in one place instead of scattered role checks.
 */
export type Capability =
  // portfolio + estate
  | 'estate.viewAll'
  | 'portfolio.edit'
  | 'asset.edit'
  // work orders
  | 'wo.viewAll'
  | 'wo.create'
  | 'wo.assign'
  | 'wo.delete'
  // field tools
  | 'survey.manage'
  | 'round.manage'
  | 'ar.configure'
  | 'wayfinder.edit'
  // admin surfaces
  | 'dashboard.org'
  | 'settings.admin'
  | 'diagnostics.view'
  | 'people.manage';

/**
 * The permission matrix, stated once. Technicians hold exactly two of these:
 * raising work is part of doing the job, and the estate/AR/wayfinder reads they
 * get are scoped by assignment rather than by capability (see scope.ts).
 */
const MATRIX: Record<Capability, readonly Role[]> = {
  'estate.viewAll': ['admin'],
  'portfolio.edit': ['admin'],
  'asset.edit': ['admin'],
  'wo.viewAll': ['admin'],
  'wo.create': ['admin', 'technician'],
  'wo.assign': ['admin'],
  'wo.delete': ['admin'],
  'survey.manage': ['admin'],
  'round.manage': ['admin'],
  'ar.configure': ['admin'],
  'wayfinder.edit': ['admin'],
  'dashboard.org': ['admin'],
  'settings.admin': ['admin'],
  'diagnostics.view': ['admin'],
  'people.manage': ['admin'],
};

/** Pure so every gate in the app can be tested without a session or a store. */
export function can(role: Role, capability: Capability): boolean {
  return MATRIX[capability].includes(role);
}

export const ROLES_KEY = 'perm.roles';

export interface RoleMap {
  /** Lower-cased emails that get the admin role. Everyone else is a technician. */
  admins: string[];
}

export const EMPTY_ROLE_MAP: RoleMap = { admins: [] };

/** Where a role decision came from — so the UI can be honest about a degraded store. */
export type RoleSource = 'bootstrap' | 'map' | 'default' | 'unavailable';

export interface RoleResolution {
  role: Role;
  source: RoleSource;
}

export function normaliseRoleMap(raw: unknown): RoleMap {
  const value = (raw ?? {}) as Partial<RoleMap>;
  return {
    admins: Array.isArray(value.admins)
      ? value.admins.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

function normaliseEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * The whole decision, pure.
 *
 * `storeDown` is passed in rather than read here so the rule stays testable and
 * the caller keeps the one piece of I/O. It only changes the REASON, never the
 * answer: an unreadable store denies exactly as an empty one does.
 */
export function resolveRole(
  email: string | undefined,
  map: RoleMap | null,
  storeDown = false,
): RoleResolution {
  const address = normaliseEmail(email);
  if (address && BOOTSTRAP_ADMINS.includes(address)) return { role: 'admin', source: 'bootstrap' };
  if (address && map?.admins.includes(address)) return { role: 'admin', source: 'map' };
  if (storeDown) return { role: 'technician', source: 'unavailable' };
  return { role: 'technician', source: 'default' };
}

export async function loadRoleMap(): Promise<RoleMap> {
  return normaliseRoleMap(await appStore.kvGet('settings', ROLES_KEY));
}

export async function saveRoleMap(map: RoleMap): Promise<void> {
  await appStore.kvPut('settings', ROLES_KEY, normaliseRoleMap(map));
}

/** Resolve the signed-in person's role, including a degraded-store reason. */
export async function loadRole(email: string | undefined): Promise<RoleResolution> {
  const map = await loadRoleMap();
  return resolveRole(email, map, appStoreUnavailable() !== null);
}
