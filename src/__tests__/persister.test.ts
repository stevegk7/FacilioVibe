// Query results are NOT persisted to disk.
//
// They were, and it produced a real correctness bug: a single localStorage
// slot with a 24h life and no org scoping, so a session that had read org A's
// sites rehydrated them while signed into org B — the stale copy painting
// before (or instead of) the live refetch. Records are per-org and per-user;
// a disk cache that does not model that is worse than no cache.
//
// isJsonSafe is kept because it is the guard any future persistence must use
// (a Map survives JSON.stringify as {} and rehydrates broken on the SECOND
// load — the failure that is invisible in a first-run test).
import { describe, expect, it } from 'vitest';
import { createAppQueryClient, isJsonSafe, purgeLegacyPersistedCache } from '../api/queryClient';

describe('isJsonSafe', () => {
  it('accepts plain JSON data', () => {
    expect(isJsonSafe(null)).toBe(true);
    expect(isJsonSafe('x')).toBe(true);
    expect(isJsonSafe(42)).toBe(true);
    expect(isJsonSafe([{ a: 1, b: ['x', null] }])).toBe(true);
    expect(isJsonSafe({ nested: { deep: { ok: true } } })).toBe(true);
  });

  it('refuses the liars: Map, Set, Date, class instances, typed arrays, cycles', () => {
    expect(isJsonSafe(new Map([['k', 'v']]))).toBe(false);
    expect(isJsonSafe(new Set([1]))).toBe(false);
    expect(isJsonSafe(new Date())).toBe(false);
    expect(isJsonSafe(new Uint8Array([1, 2]))).toBe(false);
    expect(isJsonSafe(() => {})).toBe(false);
    expect(isJsonSafe(NaN)).toBe(false);
    expect(isJsonSafe(undefined)).toBe(false);
    class Thing {}
    expect(isJsonSafe(new Thing())).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonSafe(cyclic)).toBe(false);

    // The killer case: safe-looking object with a Map buried inside
    expect(isJsonSafe({ rows: [], index: new Map() })).toBe(false);
  });
});

describe('no disk persistence', () => {
  it('keeps query data in memory only — nothing is written to localStorage', () => {
    const client = createAppQueryClient();
    client.setQueryData(['sites'], [{ id: 1, name: 'Site A' }]);

    const written = Object.keys(localStorage).filter((k) => k.startsWith('fv.queryCache'));
    expect(written).toEqual([]);
    // still cached for this session
    expect(client.getQueryData(['sites'])).toEqual([{ id: 1, name: 'Site A' }]);
  });

  it('purges anything an earlier persisting build left behind', () => {
    localStorage.setItem('fv.queryCache', '{"stale":"org-a-sites"}');
    localStorage.setItem('fv.cacheIdentity', '2838:1');

    purgeLegacyPersistedCache();

    expect(localStorage.getItem('fv.queryCache')).toBeNull();
    expect(localStorage.getItem('fv.cacheIdentity')).toBeNull();
  });
});
