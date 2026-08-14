/**
 * The overlay's whole reason to exist is surviving a rebuild: the auto-graph
 * is derived and disposable, the overlay is authored and durable. So the tests
 * apply overlays to FRESH buildAutoGraph outputs, and prove the added edges
 * actually route — not just that they appear in the edge list.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EstateData, EstateFloor } from '../estate/types';
import { buildAutoGraph, routeOnGraph } from './autoGraph';
import type { AutoEdge } from './autoGraph';
import { applyOverlay, loadOverlay, overlayKey, saveOverlay, validateOverlay } from './autoGraphStore';
import type { AutoGraphOverlay } from './autoGraphStore';

// Map-backed appStore fake — loadOverlay/saveOverlay never touch the SDK here.
const kv = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../api/appStore', () => ({
  appStore: {
    kvGet: async (_c: string, key: string) => kv.get(key) ?? null,
    kvPut: async (_c: string, key: string, value: unknown) => {
      kv.set(key, value);
    },
  },
}));

/* ---------- fixture: one site, two buildings, no site geo ---------- */

const FLOOR_A: EstateFloor = {
  recordId: 301,
  name: 'G',
  floorlevel: 0,
  spaces: [
    {
      recordId: 401,
      name: 'Plant Room',
      polygon: [
        [-6, -4],
        [2, -4],
        [2, 4],
        [-6, 4],
      ],
    },
  ],
  markers: [{ recordId: 9001, markerModuleName: 'asset', name: 'AHU 1', spaceId: 401, x: -2, z: 0 }],
};

const FLOOR_B: EstateFloor = {
  recordId: 302,
  name: 'G',
  floorlevel: 0,
  spaces: [
    {
      recordId: 402,
      name: 'Cafe',
      polygon: [
        [-5, -4],
        [5, -4],
        [5, 4],
        [-5, 4],
      ],
    },
  ],
  markers: [
    { recordId: 9002, markerModuleName: 'asset', name: 'Coffee Machine', spaceId: 402, x: 0, z: 0 },
  ],
};

function fixtureEstate(): EstateData {
  return {
    name: 'Alpha Campus',
    buildings: [
      {
        id: '201',
        recordId: 201,
        name: 'Tower A',
        siteName: 'Alpha Campus',
        siteId: 11,
        w: 20,
        d: 16,
        x: -20,
        z: 0,
        nF: 1,
        floors: [FLOOR_A],
      },
      {
        id: '202',
        recordId: 202,
        name: 'Annex B',
        siteName: 'Alpha Campus',
        siteId: 11,
        w: 12,
        d: 10,
        x: 20,
        z: 0,
        nF: 1,
        floors: [FLOOR_B],
      },
    ],
    // Beta Depot has no buildings and no geo — unreachable until an overlay bridges it.
    siteNames: ['Alpha Campus', 'Beta Depot'],
    sites: [{ recordId: 11, name: 'Alpha Campus' }, { recordId: 12, name: 'Beta Depot' }],
    counts: {
      buildings: 2,
      floors: 2,
      spaces: 2,
      assets: 2,
      siteLevelAssets: 0,
      unresolvedAssets: 0,
      planFloors: 0,
      planRooms: 0,
    },
  };
}

const bridge: AutoEdge = {
  id: 'ov:bridge-depot',
  from: 'site:11',
  to: 'site:Beta Depot',
  kind: 'outdoor',
  meters: 120,
  outdoor: true,
};

const overlayWith = (edges: AutoEdge[], removeEdgeIds: string[] = []): AutoGraphOverlay => ({
  addEdges: edges,
  removeEdgeIds,
  version: 1,
});

describe('applyOverlay', () => {
  it('makes an added edge routable, and leaves the input graph untouched', () => {
    const base = buildAutoGraph(fixtureEstate());
    const refused = routeOnGraph(base, 'asset:9001', 'site:Beta Depot');
    expect(refused.unroutable).toBe(true);

    const patched = applyOverlay(base, overlayWith([bridge]));
    const routed = routeOnGraph(patched, 'asset:9001', 'site:Beta Depot');
    expect(routed.unroutable).toBeFalsy();
    if (!routed.unroutable) {
      expect(routed.legs.some((l) => l.nodes.includes('site:Beta Depot'))).toBe(true);
    }

    // Pure: base still has no route and no borrowed edge.
    expect(base.edges.some((e) => e.id === bridge.id)).toBe(false);
    expect(routeOnGraph(base, 'asset:9001', 'site:Beta Depot').unroutable).toBe(true);
  });

  it('drops an added edge whose endpoint is not in the graph, and counts it', () => {
    const base = buildAutoGraph(fixtureEstate());
    const dangling: AutoEdge = { ...bridge, id: 'ov:gone', to: 'space:404404' };
    const overlay = overlayWith([bridge, dangling]);

    const { ok, dropped } = validateOverlay(base, overlay);
    expect(ok.map((e) => e.id)).toEqual([bridge.id]);
    expect(dropped).toBe(1);

    const patched = applyOverlay(base, overlay);
    expect(patched.edges.some((e) => e.id === 'ov:gone')).toBe(false);
    expect(patched.edges.some((e) => e.id === bridge.id)).toBe(true);
  });

  it('removes edges by id', () => {
    const base = buildAutoGraph(fixtureEstate());
    const doorway = 'building:202--site:11';
    expect(base.edges.some((e) => e.id === doorway)).toBe(true);

    const patched = applyOverlay(base, overlayWith([], [doorway]));
    expect(patched.edges.some((e) => e.id === doorway)).toBe(false);
    // Annex B lost its site link; Tower A can no longer reach the coffee machine.
    expect(routeOnGraph(patched, 'asset:9001', 'asset:9002').unroutable).toBe(true);
  });

  it('survives a base rebuild — the same overlay applies to a fresh graph', () => {
    const overlay = overlayWith([bridge]);
    const first = applyOverlay(buildAutoGraph(fixtureEstate()), overlay);
    expect(routeOnGraph(first, 'asset:9001', 'site:Beta Depot').unroutable).toBeFalsy();

    const rebuilt = applyOverlay(buildAutoGraph(fixtureEstate()), overlay);
    expect(routeOnGraph(rebuilt, 'asset:9001', 'site:Beta Depot').unroutable).toBeFalsy();
  });

  it('null overlay is a copy, not a reference', () => {
    const base = buildAutoGraph(fixtureEstate());
    const copy = applyOverlay(base, null);
    expect(copy.edges).toEqual(base.edges);
    expect(copy.edges).not.toBe(base.edges);
  });
});

describe('loadOverlay / saveOverlay', () => {
  it('round-trips through the settings collection under wf.autograph.<siteId>', async () => {
    const overlay = overlayWith([bridge], ['building:202--site:11']);
    await saveOverlay(11, overlay);
    expect(kv.has(overlayKey(11))).toBe(true);

    const loaded = await loadOverlay(11);
    expect(loaded).toEqual(overlay);
  });

  it('returns null for a missing key', async () => {
    expect(await loadOverlay(999)).toBe(null);
  });

  it('tolerates a stored document of the wrong shape', async () => {
    kv.set(overlayKey(12), 'not an overlay');
    expect(await loadOverlay(12)).toBe(null);

    // Partial garbage degrades field by field instead of all-or-nothing.
    kv.set(overlayKey(13), { addEdges: 'nope', removeEdgeIds: [1, 'keep'], version: 'x' });
    expect(await loadOverlay(13)).toEqual({ addEdges: [], removeEdgeIds: ['keep'], version: 0 });
  });
});
