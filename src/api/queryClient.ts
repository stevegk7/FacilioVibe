import { QueryClient } from '@tanstack/react-query';

/**
 * Structural JSON-safety check for the persister. A `Map` in the query cache
 * survives JSON.stringify as `{}` and rehydrates as a plain object — the next
 * `.get()` call throws, and the blank screen only appears on the SECOND load.
 * So: anything that wouldn't round-trip JSON.parse(JSON.stringify(x))
 * unchanged is refused persistence outright. The query still works — it just
 * refetches instead of rehydrating.
 */
export function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'undefined': // dropped by JSON inside objects; refuse to be strict
    case 'bigint':
    case 'function':
    case 'symbol':
      return false;
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false; // cycle
  seen.add(value);

  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, seen));

  // Only plain objects. Map/Set/Date/Blob/TypedArray/class instances all fail
  // here — exactly the values that lie through JSON.stringify.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;

  return Object.values(value).every((v) => isJsonSafe(v, seen));
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Memory-only cache. Nothing survives a reload, so a record can never
        // outlive the org it belongs to.
        refetchOnMount: 'always',
        staleTime: 30_000,
        gcTime: 5 * 60 * 1000,
        retry: 1,
      },
    },
  });
}

const STORAGE_KEY = 'fv.queryCache';
const IDENTITY_KEY = 'fv.cacheIdentity';

/**
 * Query results are NOT persisted.
 *
 * They were, and it caused a real correctness bug: one storage slot with a 24h
 * life, no org scoping, so a session that had read org A's sites rehydrated
 * them while signed into org B — and the stale copy paints before (or instead
 * of) the live refetch. Records are per-org and per-user; a disk cache that
 * does not model that is worse than no cache.
 *
 * The in-memory cache still de-dupes within a session, which is where nearly
 * all of the benefit was. If offline reads are wanted later, reintroduce
 * persistence keyed by `${orgId}:${userId}` and drop it on identity change.
 *
 * This clears anything an earlier build left behind.
 */
export function purgeLegacyPersistedCache(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(IDENTITY_KEY);
  } catch {
    /* storage can be blocked in a third-party iframe — nothing to purge there */
  }
}
