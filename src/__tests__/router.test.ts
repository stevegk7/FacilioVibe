// The router replaces a greedy nearest-waypoint chain that would route through
// a wall. These lock the properties that made it worth replacing.
import { describe, expect, it } from 'vitest';
import {
  GPS_ANCHOR_MAX_ACCURACY_M,
  anchorFromFix,
  findRoute,
  gpsAnchorRadiusM,
  nearestNode,
  stepText,
} from '../wayfinding/router';
import type { WayEdge, WayGraph, WayNode } from '../wayfinding/graph';

const node = (id: string, extra: Partial<WayNode> = {}): WayNode => ({
  id,
  kind: 'standpoint',
  name: id,
  ...extra,
});

const edge = (from: string, to: string, extra: Partial<WayEdge> = {}): WayEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  kind: 'walk',
  ...extra,
});

function graph(nodes: WayNode[], edges: WayEdge[]): WayGraph {
  return { siteId: 1, nodes, edges, updatedAt: '2026-01-01' };
}

describe('findRoute', () => {
  it('takes the cheaper of two routes', () => {
    const g = graph(
      [node('entrance', { kind: 'entrance' }), node('viaA'), node('viaB'), node('goal')],
      [
        edge('entrance', 'viaA', { meters: 10 }),
        edge('viaA', 'goal', { meters: 10 }),
        edge('entrance', 'viaB', { meters: 100 }),
        edge('viaB', 'goal', { meters: 100 }),
      ],
    );
    const route = findRoute(g, 'entrance', 'goal');
    expect(route?.steps.map((s) => s.to.id)).toEqual(['viaA', 'goal']);
    expect(route?.totalMeters).toBe(20);
  });

  it('prefers walking to a needless lift ride, and phrases a real floor change', () => {
    const g = graph(
      [
        node('lobby', { floorLevel: 0 }),
        node('corridor', { floorLevel: 0 }),
        node('plant', { name: 'Plant Room', floorLevel: 9 }),
      ],
      [
        edge('lobby', 'corridor'), // default walk cost 25
        edge('lobby', 'plant', { kind: 'lift' }), // default lift cost 90
      ],
    );
    // walking is cheaper than the lift, so a same-floor target never rides
    expect(findRoute(g, 'lobby', 'corridor')?.steps).toHaveLength(1);

    // but when the lift is the only way up, it is phrased with the storey delta
    const up = findRoute(g, 'lobby', 'plant');
    expect(up?.steps[0].text).toBe('Take the lift to Plant Room — up 9 floors');
  });

  it('returns NULL for an unreachable node — never a partial route', () => {
    const g = graph([node('a'), node('island')], [edge('a', 'a')]);
    expect(findRoute(g, 'a', 'island')).toBeNull();
  });

  it('honours one-way edges', () => {
    const g = graph([node('a'), node('b')], [edge('a', 'b', { oneWay: true })]);
    expect(findRoute(g, 'a', 'b')?.steps).toHaveLength(1);
    expect(findRoute(g, 'b', 'a')).toBeNull();
  });

  it('an authored instruction wins over the generated phrasing', () => {
    const g = graph(
      [node('a'), node('b')],
      [edge('a', 'b', { instruction: 'Use the service corridor behind the lifts' })],
    );
    expect(findRoute(g, 'a', 'b')?.steps[0].text).toBe(
      'Use the service corridor behind the lifts',
    );
  });

  it('derives distance from geotags when the edge has no measured metres', () => {
    const g = graph(
      [
        node('a', { lat: 12.9721, lng: 77.5937 }),
        node('b', { lat: 12.9726, lng: 77.5937 }), // ~55m north
      ],
      [edge('a', 'b')],
    );
    const step = findRoute(g, 'a', 'b')?.steps[0];
    expect(step?.meters).toBeGreaterThan(40);
    expect(step?.meters).toBeLessThan(70);
    expect(step?.text).toMatch(/Head to b — \d+m north/);
  });

  it('routing to yourself is a no-op, not an error', () => {
    const g = graph([node('a')], []);
    expect(findRoute(g, 'a', 'a')).toEqual({ steps: [], totalMeters: 0, destination: node('a') });
  });
});

describe('stepText', () => {
  it('names the mode for vertical and door hops', () => {
    const a = node('a', { floorLevel: 3 });
    const b = node('b', { name: 'L1 Lobby', floorLevel: 1 });
    expect(stepText(a, b, edge('a', 'b', { kind: 'stairs' }))).toBe(
      'Take the stairs to L1 Lobby — down 2 floors',
    );
    expect(stepText(a, b, edge('a', 'b', { kind: 'door' }))).toBe('Go through to L1 Lobby');
  });

  it('falls back to a bare instruction when nothing is known', () => {
    expect(stepText(node('a'), node('b'), edge('a', 'b'))).toBe('Head to b');
  });
});

describe('nearestNode', () => {
  it('picks the closest node of the requested kind', () => {
    const g = graph(
      [
        node('north', { kind: 'entrance', lat: 12.98, lng: 77.5937 }),
        node('south', { kind: 'entrance', lat: 12.9721, lng: 77.5937 }),
        node('closer-but-wrong-kind', { kind: 'lift', lat: 12.9722, lng: 77.5937 }),
      ],
      [],
    );
    const found = nearestNode(g, { lat: 12.9721, lng: 77.5937 }, ['entrance']);
    expect(found?.id).toBe('south');
  });

  it('ignores nodes with no geotag', () => {
    const g = graph([node('untagged', { kind: 'entrance' })], []);
    expect(nearestNode(g, { lat: 0, lng: 0 }, ['entrance'])).toBeNull();
  });
});

/* ---------------- what a GPS fix may claim ----------------
   `nearestNode` answers "which is closest", never "is that believable". Before
   anchorFromFix existed the Wayfinder took its answer at any distance, with any
   accuracy, of any kind — so a technician at the depot started a route from a
   site entrance, and a site whose entrances carried no coordinates started from
   whichever plant room happened to be nearest. */

// The mock fixture and the shipped demo's own entrance. ~119m apart, accuracy 8m:
// a real "you are at this entrance", and the calibration point for the radius.
const MOCK_FIX = { lat: 12.97212, lng: 77.59369, accuracy: 8 };
const DEMO_ENTRANCE = { lat: 12.9717, lng: 77.5947 };

describe('anchorFromFix', () => {
  const site = (extra: Partial<WayNode> = {}) =>
    graph([node('door', { kind: 'entrance', ...DEMO_ENTRANCE, ...extra })], []);

  it("anchors at the demo's real geometry — the case that must keep working", () => {
    expect(anchorFromFix(site(), MOCK_FIX)?.id).toBe('door');
  });

  it('refuses a fix too coarse to name a place', () => {
    const coarse = { ...MOCK_FIX, accuracy: GPS_ANCHOR_MAX_ACCURACY_M + 1 };
    expect(anchorFromFix(site(), coarse)).toBeNull();
  });

  it('refuses when the nearest entrance is somewhere else entirely', () => {
    // Same site, technician still at the depot ~6km away.
    const atTheDepot = { lat: 13.0273, lng: 77.5947, accuracy: 8 };
    expect(anchorFromFix(site(), atTheDepot)).toBeNull();
  });

  it('never anchors to a standpoint inside a building, however close', () => {
    const g = graph(
      [node('plantRoomL9', { kind: 'standpoint', ...DEMO_ENTRANCE })],
      [],
    );
    expect(anchorFromFix(g, MOCK_FIX)).toBeNull();
  });

  it('refuses a graph whose entrances carry no coordinates', () => {
    const g = graph([node('door', { kind: 'entrance' })], []);
    expect(anchorFromFix(g, MOCK_FIX)).toBeNull();
  });

  it('refuses a non-finite accuracy rather than treating it as perfect', () => {
    expect(anchorFromFix(site(), { ...MOCK_FIX, accuracy: NaN })).toBeNull();
  });

  it('scales the radius with the fix error, with a building-scale floor', () => {
    expect(gpsAnchorRadiusM(8)).toBe(150);
    expect(gpsAnchorRadiusM(80)).toBe(240);
  });
});
