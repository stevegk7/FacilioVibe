// The single filtering policy (src/api/recordPolicy.js).
//
// The two merged apps disagreed here: Estate Navigator dropped test artifacts
// before laying out geometry, Facilio Vision listed everything. Against org
// #2915 that is 16 of 55 assets — so the 3D estate would have shown 39 while
// Portfolio showed 55, with nothing to say which was right. These tests pin the
// predicate and, more importantly, pin that every provider path applies it.
import { describe, expect, it } from 'vitest';
import { isRetired, visibleRows } from '../api/recordPolicy';
import { mockProvider } from '../api/mockProvider';

describe('record policy', () => {
  it('recognises the naming conventions this org actually uses', () => {
    expect(isRetired({ name: 'OBSOLETE (CLI test artifact - safe to delete)' })).toBe(true);
    expect(isRetired({ name: 'OBSOLETE - Tower A' })).toBe(true);
    expect(isRetired({ name: 'Chiller [fv-verify] scratch' })).toBe(true);
    expect(isRetired({ name: 'safe to delete' })).toBe(true);

    expect(isRetired({ name: 'Tower A' })).toBe(false);
    expect(isRetired({ name: 'Standby Generator UW-GEN-01' })).toBe(false);
  });

  it('does not throw on the shapes a CMMS row can actually arrive in', () => {
    expect(isRetired(null)).toBe(false);
    expect(isRetired(undefined)).toBe(false);
    expect(isRetired({})).toBe(false);
    expect(isRetired({ name: undefined })).toBe(false);
  });

  it('is idempotent — filtering a filtered list changes nothing', () => {
    const rows = [{ name: 'Tower A' }, { name: 'OBSOLETE - old riser' }, { name: 'Tower B' }];
    const once = visibleRows(rows);
    expect(visibleRows(once)).toEqual(once);
    expect(once).toHaveLength(2);
  });

  it('showRetired is a real escape hatch, not a no-op', () => {
    const rows = [{ name: 'Tower A' }, { name: 'OBSOLETE - old riser' }];
    expect(visibleRows(rows, true)).toHaveLength(2);
    expect(visibleRows(rows, false)).toHaveLength(1);
  });

  it('tolerates a missing list rather than throwing at a call site', () => {
    expect(visibleRows(undefined)).toEqual([]);
    expect(visibleRows(null)).toEqual([]);
  });
});

describe('every provider read applies the policy', () => {
  // The fixtures deliberately carry one retired space and one retired asset.
  // If a provider method forgets the filter, exactly one of these fails — which
  // is the whole point of putting the policy in the data layer.
  it('hides retired records from spaces, assets and the 3D estate alike', async () => {
    const spaces = await mockProvider.listAllSpaces();
    expect(spaces.some((s) => isRetired(s))).toBe(false);

    const assets = await mockProvider.searchAssets({});
    expect(assets.some((a) => isRetired(a))).toBe(false);

    const estate = await mockProvider.loadEstate();
    expect(estate.spaces.some(isRetired)).toBe(false);
    expect(estate.assets.some(isRetired)).toBe(false);

    // …and the asset list and the estate agree on the count, which is the
    // user-visible symptom the whole policy exists to prevent.
    expect(estate.assets).toHaveLength(assets.length);
  });

  it('showRetired reaches all the way through the estate loader', async () => {
    const hidden = await mockProvider.loadEstate(false);
    const shown = await mockProvider.loadEstate(true);
    expect(shown.assets.length).toBeGreaterThan(hidden.assets.length);
    expect(shown.assets.some(isRetired)).toBe(true);
  });
});
