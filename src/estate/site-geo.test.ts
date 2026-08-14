// Site coordinates, end to end through the REAL builder.
//
// This exists because the previous tests could not catch the bug it guards. They
// hand-built an EstateData and set `siteId` on each building themselves — but
// buildEstate never emitted that field, so in the shipped app every site fell
// back to a NAME key while Settings wrote `sitegeo.<numeric id>`. The keys could
// never meet, so every site-to-site route was permanently unroutable and the
// screen's own advice ("add site coordinates in Settings") could not fix it.
//
// The lesson generalises: when a derived field is only ever supplied by the
// fixture, the fixture is testing itself. These tests start from RAW rows.
import { describe, expect, it } from 'vitest';
import { buildEstate } from './buildEstate';
import { buildAutoGraph, routeOnGraph } from '../wayfinding/autoGraph';
import type { EstateRaw } from './types';

/** Two sites, one building/floor/space/asset each. Site 2 has no location. */
function records(withGeoOnBoth: boolean): EstateRaw {
  return {
    sites: [
      {
        id: 1,
        name: 'Greenfield Business Park',
        // The shape the CMMS returns once `location` is expanded.
        location: {
          id: 900,
          street: 'Bagillt Road',
          city: 'Greenfield',
          state: 'Wales',
          country: 'GB',
          zip: 'CH8 7HJ',
          lat: 53.2876619,
          lng: -3.2027173,
        },
      },
      {
        id: 2,
        name: 'Lakeside Manufacturing Plant',
        ...(withGeoOnBoth
          ? {
              location: {
                id: 901,
                street: 'West Electric Avenue',
                city: 'West Milwaukee',
                state: 'Wisconsin',
                country: 'US',
                zip: '53219',
                lat: 43.0068251,
                lng: -87.9759057,
              },
            }
          : {}),
      },
    ],
    buildings: [
      { id: 10, name: 'Tower A', site: { id: 1 } },
      { id: 20, name: 'Production Wing', site: { id: 2 } },
    ],
    floors: [
      { id: 100, name: 'Floor 1', building: { id: 10 }, site: { id: 1 }, floorlevel: 1 },
      { id: 200, name: 'Line Deck', building: { id: 20 }, site: { id: 2 }, floorlevel: 1 },
    ],
    spaces: [
      { id: 1000, name: 'Plant Room', building: { id: 10 }, floor: { id: 100 }, site: { id: 1 } },
      { id: 2000, name: 'Line 1', building: { id: 20 }, floor: { id: 200 }, site: { id: 2 } },
    ],
    assets: [
      { id: 5000, name: 'Chiller CH-02', space: { id: 1000 } },
      { id: 6000, name: 'Conveyor M-114', space: { id: 2000 } },
    ],
    workOrders: [],
    inspections: [],
    plans: {},
  } as unknown as EstateRaw;
}

/** What WayfinderScreen does: CMMS geo as the base, typed KV as an override. */
function siteGeoFrom(estate: ReturnType<typeof buildEstate>) {
  const map: Record<string, { lat: number; lng: number }> = {};
  for (const s of estate.sites) {
    if (typeof s.lat === 'number' && typeof s.lng === 'number') {
      map[String(s.recordId)] = { lat: s.lat, lng: s.lng };
    }
  }
  return map;
}

describe('site coordinates from the CMMS location lookup', () => {
  it('emits siteId on every building, so site nodes key on the record id', () => {
    const estate = buildEstate(records(true));
    expect(estate.buildings.map((b) => b.siteId)).toEqual([1, 2]);
  });

  it('carries lat/lng and a joined address for a site that has a location', () => {
    const estate = buildEstate(records(true));
    const greenfield = estate.sites.find((s) => s.recordId === 1);
    expect(greenfield?.lat).toBeCloseTo(53.2876619, 6);
    expect(greenfield?.lng).toBeCloseTo(-3.2027173, 6);
    expect(greenfield?.address).toBe('Bagillt Road, Greenfield, Wales, CH8 7HJ, GB');
  });

  it('omits lat/lng entirely when a site has no location — never 0,0', () => {
    const estate = buildEstate(records(false));
    const lakeside = estate.sites.find((s) => s.recordId === 2);
    expect(lakeside).toBeDefined();
    expect(lakeside).not.toHaveProperty('lat');
    expect(lakeside).not.toHaveProperty('lng');
    // A 0,0 default would price this hop through the Gulf of Guinea instead of
    // refusing, which is the failure mode the omission exists to prevent.
    expect(siteGeoFrom(estate)['2']).toBeUndefined();
  });

  it('prices a cross-site route once both sites carry coordinates', () => {
    const estate = buildEstate(records(true));
    const graph = buildAutoGraph(estate, { siteGeo: siteGeoFrom(estate) });

    const site1 = graph.nodes.find((n) => n.kind === 'site' && n.recordId === 1);
    expect(site1?.geo).toEqual({ lat: 53.2876619, lng: -3.2027173 });

    const route = routeOnGraph(graph, 'asset:5000', 'asset:6000');
    // AutoRoute is a discriminated union — narrow rather than assert, so a
    // regression reports the refusal reason instead of a property-access error.
    if (route.unroutable) throw new Error(`expected a route, got refusal: ${route.reason}`);
    // Greenfield (Wales) to West Milwaukee is a real intercontinental distance;
    // the point is that it is priced from real coordinates rather than invented.
    expect(route.distanceM).toBeGreaterThan(1_000_000);
    expect(route.legs.some((l) => l.kind === 'outdoor')).toBe(true);
  });

  it('still refuses, with the actionable reason, when one site has no coordinates', () => {
    const estate = buildEstate(records(false));
    const graph = buildAutoGraph(estate, { siteGeo: siteGeoFrom(estate) });

    const route = routeOnGraph(graph, 'asset:5000', 'asset:6000');
    if (!route.unroutable) throw new Error('expected a refusal, got a priced route');
    expect(route.reason).toMatch(/geo \(lat\/lng\) on both sites/);
  });
});
