/**
 * legsToRouteSpec sits between routeOnGraph and the engine, so the main test
 * feeds it REAL route output (a cross-floor, cross-building journey), not
 * hand-built legs — the synthetic cases only cover what a real route cannot
 * produce: malformed and degenerate legs.
 */
import { describe, expect, it } from 'vitest';
import type { EstateData, EstateFloor } from '../estate/types';
import { buildAutoGraph, routeOnGraph } from './autoGraph';
import type { AutoLeg } from './autoGraph';
import { legsToRouteSpec } from './routeDraw';

const FLOOR_G: EstateFloor = {
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

const FLOOR_2: EstateFloor = {
  recordId: 302,
  name: 'L2',
  floorlevel: 2,
  spaces: [
    {
      recordId: 402,
      name: 'Server Room',
      polygon: [
        [-8, -6],
        [0, -6],
        [0, -1],
        [-8, -1],
      ],
    },
  ],
  markers: [{ recordId: 9002, markerModuleName: 'asset', name: 'UPS 4', spaceId: 402, x: -4, z: -3 }],
};

const FLOOR_B: EstateFloor = {
  recordId: 303,
  name: 'G',
  floorlevel: 0,
  spaces: [
    {
      recordId: 403,
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
    { recordId: 9003, markerModuleName: 'asset', name: 'Coffee Machine', spaceId: 403, x: 0, z: 0 },
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
        floors: [FLOOR_G, FLOOR_2],
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
    siteNames: ['Alpha Campus'],
    counts: {
      buildings: 2,
      floors: 3,
      spaces: 3,
      assets: 3,
      siteLevelAssets: 0,
      unresolvedAssets: 0,
      planFloors: 0,
      planRooms: 0,
    },
  };
}

function legsFor(fromId: string, toId: string): AutoLeg[] {
  const route = routeOnGraph(buildAutoGraph(fixtureEstate()), fromId, toId);
  if (route.unroutable) throw new Error(`expected a route, got: ${route.reason}`);
  return route.legs;
}

describe('legsToRouteSpec', () => {
  it('drops vertical legs and keeps indoor legs on their own floors', () => {
    const legs = legsFor('asset:9001', 'asset:9002'); // ground -> L2, via the stair core
    expect(legs.some((l) => l.kind === 'vertical')).toBe(true);

    const spec = legsToRouteSpec(legs);
    expect(spec.every((l) => l.kind === 'indoor' || l.kind === 'outdoor')).toBe(true);
    // Each drawable indoor leg keeps its frame: floor id, engine building key.
    const floors = spec.filter((l) => l.kind === 'indoor').map((l) => l.floorId);
    expect(floors).toEqual([301, 302]);
    expect(spec.every((l) => l.kind !== 'indoor' || l.buildingId === '201')).toBe(true);
  });

  it('keeps outdoor legs in the world frame, without a floor', () => {
    const legs = legsFor('asset:9001', 'asset:9003'); // Tower A -> Annex B
    const spec = legsToRouteSpec(legs);

    const outdoor = spec.filter((l) => l.kind === 'outdoor');
    expect(outdoor.length).toBe(1);
    expect(outdoor[0].floorId).toBeUndefined();
    expect(outdoor[0].buildingId).toBeUndefined();
    // World metres: the leg spans the two building positions (x -20 and 20).
    const xs = outdoor[0].points.map((p) => p.x);
    expect(Math.min(...xs)).toBe(-20);
    expect(Math.max(...xs)).toBe(20);

    // Points survive verbatim on the indoor legs too.
    const first = spec[0];
    expect(first.kind).toBe('indoor');
    expect(first.points[0]).toEqual({ x: -2, z: 0 }); // AHU 1's marker position
  });

  it('skips degenerate and malformed legs instead of throwing', () => {
    const good: AutoLeg = {
      kind: 'indoor',
      floorId: 301,
      buildingId: 201,
      points: [
        { x: 0, z: 0 },
        { x: 1, z: 1 },
      ],
      nodes: ['a', 'b'],
      distanceM: 1.4,
      instruction: 'Walk',
    };
    const onePoint: AutoLeg = { ...good, points: [{ x: 0, z: 0 }] };
    const badPoints = {
      ...good,
      points: [{ x: 0, z: 0 }, { x: NaN, z: 1 }, null],
    } as unknown as AutoLeg;
    const junk = [null, 42, { kind: 'teleport' }, { kind: 'indoor' }] as unknown as AutoLeg[];

    expect(legsToRouteSpec([good, onePoint, badPoints, ...junk])).toEqual([
      {
        kind: 'indoor',
        floorId: 301,
        buildingId: '201',
        points: [
          { x: 0, z: 0 },
          { x: 1, z: 1 },
        ],
      },
    ]);
    expect(legsToRouteSpec(null as unknown as AutoLeg[])).toEqual([]);
  });
});
