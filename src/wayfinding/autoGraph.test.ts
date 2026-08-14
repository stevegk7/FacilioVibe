/**
 * autoGraph is pure — estate in, graph out — so these tests run on a synthetic
 * estate small enough to verify by hand: 2 sites, 2 buildings, 3 floors, one
 * plan-bound floor whose rooms share (and pointedly do not share) walls, and 4
 * assets. The last test rebuilds the graph from the repo's real CMMS fixture
 * snapshot to prove the synthetic shape isn't the only shape that works.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEstate } from '../estate/buildEstate';
import type { EstateData, EstateFloor, RawRow } from '../estate/types';
import { buildAutoGraph, findNode, routeOnGraph } from './autoGraph';
import type { AutoLeg } from './autoGraph';

/* ---------- synthetic estate ---------- */

// Ground floor of Tower A is "plan-bound": rooms carry rects + measured centres.
// 401|402 face each other across x = -2 (shared wall, 8 m long -> doorway).
// 401|403 are 1 m apart in z (a real wall plus slab, no doorway).
// 402|403 touch at a corner only (no overlap long enough for a door).
const F1: EstateFloor = {
  recordId: 301,
  name: 'G',
  tenantName: 'Ground',
  floorlevel: 0,
  spaces: [
    {
      recordId: 401,
      name: 'Plant Room',
      fromPlan: true,
      rects: [[-10, -6, -2, 2]],
      centerX: -6,
      centerZ: -2,
      polygon: [
        [-10, -6],
        [-2, -6],
        [-2, 2],
        [-10, 2],
      ],
    },
    {
      recordId: 402,
      name: 'Corridor East',
      fromPlan: true,
      rects: [[-2, -6, 6, 2]],
      centerX: 2,
      centerZ: -2,
      polygon: [
        [-2, -6],
        [6, -6],
        [6, 2],
        [-2, 2],
      ],
    },
    {
      recordId: 403,
      name: 'Store',
      fromPlan: true,
      rects: [[-10, 3, -2, 8]],
      centerX: -6,
      centerZ: 5.5,
      polygon: [
        [-10, 3],
        [-2, 3],
        [-2, 8],
        [-10, 8],
      ],
    },
  ],
  markers: [
    { recordId: 9001, markerModuleName: 'asset', name: 'AHU 1', spaceId: 401, x: -6, z: -1 },
    { recordId: 9002, markerModuleName: 'asset', name: 'Pump 7', spaceId: 402, x: 2, z: 0 },
    // A work-order pin beside AHU 1 — must NOT become a graph node.
    { recordId: 9500, markerModuleName: 'workorder', name: 'WO-1', x: -5.1, z: -0.1 },
  ],
};

// Level 2 of Tower A is schematic — no plan, pad polygons only.
const F2: EstateFloor = {
  recordId: 302,
  name: 'L2',
  tenantName: 'Floor 2',
  floorlevel: 2,
  spaces: [
    {
      recordId: 404,
      name: 'Server Room',
      polygon: [
        [-8, -6],
        [0, -6],
        [0, -1],
        [-8, -1],
      ],
    },
  ],
  markers: [{ recordId: 9003, markerModuleName: 'asset', name: 'UPS 4', spaceId: 404, x: -4, z: -3 }],
};

const F3: EstateFloor = {
  recordId: 303,
  name: 'G',
  tenantName: 'Lobby Level',
  floorlevel: 0,
  spaces: [
    {
      recordId: 405,
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
    { recordId: 9004, markerModuleName: 'asset', name: 'Coffee Machine', spaceId: 405, x: 0, z: 0 },
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
        nF: 2,
        floors: [F1, F2],
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
        floors: [F3],
      },
    ],
    // Beta Depot has no buildings yet — it should still exist as a destination.
    siteNames: ['Alpha Campus', 'Beta Depot'],
    // Geo arrives from the CMMS `location` lookup now, not from typed settings.
    // Beta Depot deliberately has none, so the "site hop needs geo on both ends"
    // refusal stays exercised.
    sites: [
      { recordId: 11, name: 'Alpha Campus', lat: 12.9716, lng: 77.5946 },
      { recordId: 12, name: 'Beta Depot' },
    ],
    counts: {
      buildings: 2,
      floors: 3,
      spaces: 5,
      assets: 4,
      siteLevelAssets: 0,
      unresolvedAssets: 0,
      planFloors: 1,
      planRooms: 3,
    },
  };
}

const GEO = {
  '11': { lat: 12.97212, lng: 77.59369 },
  'Beta Depot': { lat: 12.9812, lng: 77.6041 },
};

/** Union bounding box of a floor's rooms, from the raw fixture geometry. */
function floorBBox(f: EstateFloor): { x0: number; z0: number; x1: number; z1: number } {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const sp of f.spaces) {
    for (const [x, z] of sp.polygon ?? []) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
  }
  return { x0, z0, x1, z1 };
}

function legsOf(result: ReturnType<typeof routeOnGraph>): AutoLeg[] {
  if (result.unroutable) throw new Error(`expected a route, got: ${result.reason}`);
  return result.legs;
}

describe('buildAutoGraph', () => {
  it('creates one node per record plus one stair core per multi-floor building', () => {
    const g = buildAutoGraph(fixtureEstate());
    const byKind = (k: string) => g.nodes.filter((n) => n.kind === k);
    expect(byKind('site').length).toBe(2);
    expect(byKind('building').length).toBe(2);
    expect(byKind('floor').length).toBe(3);
    expect(byKind('space').length).toBe(5);
    expect(byKind('asset').length).toBe(4); // the work-order pin is not a node
    expect(byKind('core').map((n) => n.id)).toEqual(['core:201']); // Annex B is single-floor
  });

  it('adds doorway edges only where plan rooms actually share a wall', () => {
    const g = buildAutoGraph(fixtureEstate());
    const doors = g.edges.filter((e) => e.kind === 'door');
    expect(doors.map((e) => [e.from, e.to].sort())).toEqual([['space:401', 'space:402']]);
    // 401|403: separated by a full wall run. 402|403: corner contact only.
  });
});

describe('routeOnGraph', () => {
  it('routes across floors via the stair core, at 4 m per level', () => {
    const g = buildAutoGraph(fixtureEstate());
    const legs = legsOf(routeOnGraph(g, 'asset:9001', 'asset:9003'));

    const vertical = legs.find((l) => l.kind === 'vertical');
    expect(vertical).toBeDefined();
    expect(vertical?.nodes).toContain('core:201');
    expect(vertical?.distanceM).toBe(8); // ground -> level 2
    expect(vertical?.instruction).toBe('Take stairs to Floor 2');

    const before = legs[legs.indexOf(vertical as AutoLeg) - 1];
    expect(before.instruction).toBe('Head to Stair core');
  });

  it('routes across buildings with an outdoor leg', () => {
    const g = buildAutoGraph(fixtureEstate());
    const legs = legsOf(routeOnGraph(g, 'asset:9001', 'asset:9004'));

    const outdoor = legs.find((l) => l.kind === 'outdoor');
    expect(outdoor).toBeDefined();
    expect(outdoor?.nodes).toContain('building:202');
    expect(outdoor?.instruction).toBe('Walk to Annex B');
    expect(legs[legs.length - 1].kind).toBe('indoor');
    expect(legs.every((l) => l.instruction.length > 0)).toBe(true);
  });

  it('refuses a cross-site route without geo, and prices it with geo', () => {
    const noGeo = buildAutoGraph(fixtureEstate());
    const refused = routeOnGraph(noGeo, 'asset:9001', 'site:Beta Depot');
    expect(refused.unroutable).toBe(true);
    if (refused.unroutable) expect(refused.reason).toMatch(/geo/i);

    const withGeo = buildAutoGraph(fixtureEstate(), { siteGeo: GEO });
    const routed = routeOnGraph(withGeo, 'asset:9001', 'site:Beta Depot');
    const legs = legsOf(routed);
    const outdoor = legs.find((l) => l.kind === 'outdoor');
    expect(outdoor).toBeDefined();
    expect(outdoor?.instruction).toBe('Walk to Beta Depot');
    // Haversine between the two fixture points is ~1.5 km — far more than any indoor hop.
    if (!routed.unroutable) expect(routed.distanceM).toBeGreaterThan(1000);
  });

  it('handles the trivial and the broken cases explicitly', () => {
    const g = buildAutoGraph(fixtureEstate());
    const same = routeOnGraph(g, 'asset:9001', 'asset:9001');
    expect(same).toEqual({ legs: [], distanceM: 0 });

    const missing = routeOnGraph(g, 'asset:9001', 'asset:404404');
    expect(missing.unroutable).toBe(true);
    if (missing.unroutable) expect(missing.reason).toContain('asset:404404');
  });

  it('keeps every indoor point inside its floor rooms bounding box', () => {
    const g = buildAutoGraph(fixtureEstate());
    const legs = legsOf(routeOnGraph(g, 'asset:9001', 'asset:9003'));
    const boxes = new Map([
      [301, floorBBox(F1)],
      [302, floorBBox(F2)],
    ]);
    const indoor = legs.filter((l) => l.kind === 'indoor');
    expect(indoor.length).toBeGreaterThan(0);
    for (const leg of indoor) {
      const box = boxes.get(leg.floorId as number);
      expect(box).toBeDefined();
      for (const p of leg.points) {
        expect(p.x).toBeGreaterThanOrEqual((box as { x0: number }).x0);
        expect(p.x).toBeLessThanOrEqual((box as { x1: number }).x1);
        expect(p.z).toBeGreaterThanOrEqual((box as { z0: number }).z0);
        expect(p.z).toBeLessThanOrEqual((box as { z1: number }).z1);
      }
    }
  });
});

describe('findNode', () => {
  it('ranks exact over prefix over substring, shorter label first on ties', () => {
    const g = buildAutoGraph(fixtureEstate());
    expect(findNode(g, 'Plant Room')[0].id).toBe('space:401');
    expect(findNode(g, 'plant')[0].id).toBe('space:401');
    expect(findNode(g, 'floor 2')[0].id).toBe('floor:302');
    expect(findNode(g, 'asset:9002')[0].id).toBe('asset:9002');

    const rooms = findNode(g, 'room');
    expect(rooms.length).toBeGreaterThanOrEqual(2);
    expect(rooms[0].label).toBe('Plant Room'); // shorter than "Server Room"

    expect(findNode(g, 'zzz-nothing')).toEqual([]);
    expect(findNode(g, '  ')).toEqual([]);
  });
});

/* ---------- real fixture snapshot ---------- */

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const hasSnapshot = existsSync(join(FIXTURES, 'list-sites.json'));

describe('real estate fixture', () => {
  it.skipIf(!hasSnapshot)('builds a graph from the CMMS snapshot and routes between two real spaces', () => {
    const load = (name: string): RawRow[] =>
      JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as RawRow[];
    const estate = buildEstate({
      sites: load('list-sites.json'),
      buildings: load('list-buildings.json'),
      floors: load('list-floors.json'),
      spaces: load('list-spaces.json'),
      assets: load('list-assets.json'),
      workOrders: [],
      inspections: [],
      plans: {},
    });

    const g = buildAutoGraph(estate);
    expect(g.nodes.filter((n) => n.kind === 'space').length).toBeGreaterThan(10);

    // Two real spaces in the same building — routable without site geo.
    const byBuilding = new Map<number, string[]>();
    for (const n of g.nodes) {
      if (n.kind !== 'space' || n.buildingId == null) continue;
      byBuilding.set(n.buildingId, [...(byBuilding.get(n.buildingId) ?? []), n.id]);
    }
    const pair = [...byBuilding.values()].find((ids) => ids.length >= 2);
    expect(pair).toBeDefined();
    const ids = pair as string[];

    const legs = legsOf(routeOnGraph(g, ids[0], ids[ids.length - 1]));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.instruction.length > 0)).toBe(true);
    expect(legs.every((l) => Number.isFinite(l.distanceM))).toBe(true);
  });
});
