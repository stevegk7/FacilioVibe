// The authoring debt, counted. These run against the REAL builder from raw rows
// rather than a hand-built estate, because the whole point of the readout is to
// agree with what the router actually sees — a count that disagreed with the
// graph would be worse than no count.
import { describe, expect, it } from 'vitest';
import { buildEstate } from '../estate/buildEstate';
import { buildAutoGraph } from './autoGraph';
import { siteCoverage, unroutableAssets } from './coverage';
import type { EstateRaw } from '../estate/types';

/**
 * Two sites. Greenfield has coordinates and one floor; Lakeside has neither
 * coordinates nor a plan, and holds the asset that cannot be routed to — its
 * space carries no floor, which is the exact shape of the two real dropouts in
 * the reference org.
 */
function records(): EstateRaw {
  return {
    sites: [
      {
        id: 1,
        name: 'Greenfield Business Park',
        location: { id: 90, city: 'Greenfield', country: 'GB', lat: 53.2876619, lng: -3.2027173 },
      },
      { id: 2, name: 'Lakeside Manufacturing Plant' },
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
      // No floor — the dropout case.
      { id: 2001, name: 'Pump House', building: { id: 20 }, site: { id: 2 } },
    ],
    assets: [
      { id: 5000, name: 'Chiller CH-02', space: { id: 1000 } },
      { id: 6000, name: 'Conveyor M-114', space: { id: 2000 } },
      { id: 7000, name: 'Feed Pump P-07', space: { id: 2001 } },
      { id: 7777, name: 'OBSOLETE - old riser (safe to delete)', space: { id: 2000 } },
    ],
    workOrders: [],
    inspections: [],
    plans: {},
  } as unknown as EstateRaw;
}

describe('siteCoverage', () => {
  it('reports coordinates per site, which is what gates every outdoor leg', () => {
    const rows = siteCoverage(buildEstate(records()));
    const greenfield = rows.find((r) => r.name.startsWith('Greenfield'));
    const lakeside = rows.find((r) => r.name.startsWith('Lakeside'));

    expect(greenfield?.hasGeo).toBe(true);
    expect(lakeside?.hasGeo).toBe(false);
  });

  it('counts floors, and how many render real geometry rather than a schematic', () => {
    const estate = buildEstate(records());
    const rows = siteCoverage(estate);
    expect(rows.find((r) => r.name.startsWith('Greenfield'))?.floors).toBe(1);
    // No plans are bound in this fixture, so nothing claims measured geometry.
    expect(rows.every((r) => r.floorsWithPlan === 0)).toBe(true);
  });

  it('credits a floor whose plan is bound in the KV but not yet built', () => {
    const rows = siteCoverage(buildEstate(records()), { boundFloorIds: [100] });
    expect(rows.find((r) => r.name.startsWith('Greenfield'))?.floorsWithPlan).toBe(1);
  });

  it('carries standpoint and landmark counts through, keyed the way the graph keys sites', () => {
    const rows = siteCoverage(buildEstate(records()), {
      standpointsBySite: { '1': 4 },
      landmarksBySite: { '1': 2 },
    });
    const greenfield = rows.find((r) => r.name.startsWith('Greenfield'));
    expect(greenfield?.standpoints).toBe(4);
    expect(greenfield?.landmarks).toBe(2);
    // A site nobody has surveyed reads zero rather than undefined.
    expect(rows.find((r) => r.name.startsWith('Lakeside'))?.standpoints).toBe(0);
  });

  it('lists a site even when it has no buildings — it is still a destination', () => {
    const raw = records();
    (raw.sites as unknown[]).push({ id: 3, name: 'Beta Depot' });
    const rows = siteCoverage(buildEstate(raw));
    const depot = rows.find((r) => r.name === 'Beta Depot');
    expect(depot).toBeDefined();
    expect(depot?.floors).toBe(0);
  });
});

describe('unroutableAssets', () => {
  it('names the asset the graph cannot reach, and why', () => {
    const raw = records();
    const estate = buildEstate(raw);
    const graph = buildAutoGraph(estate, {});

    const missing = unroutableAssets(raw, graph);
    expect(missing.map((m) => m.name)).toEqual(['Feed Pump P-07']);
    expect(missing[0].reason).toMatch(/Pump House/);
    expect(missing[0].reason).toMatch(/no floor/);
  });

  it('says nothing about assets the graph CAN reach', () => {
    const raw = records();
    const graph = buildAutoGraph(buildEstate(raw), {});
    const names = unroutableAssets(raw, graph).map((m) => m.name);
    expect(names).not.toContain('Chiller CH-02');
    expect(names).not.toContain('Conveyor M-114');
  });

  it('ignores retired records — they are absent everywhere by policy, not by fault', () => {
    const raw = records();
    const graph = buildAutoGraph(buildEstate(raw), {});
    expect(unroutableAssets(raw, graph).some((m) => /OBSOLETE/i.test(m.name))).toBe(false);
  });

  it('is total: junk rows produce no entry rather than throwing into an admin page', () => {
    const raw = records();
    (raw.assets as unknown[]).push({ name: 'no id at all' }, null, { id: 'not a number' });
    const graph = buildAutoGraph(buildEstate(raw), {});
    expect(() => unroutableAssets(raw, graph)).not.toThrow();
    expect(unroutableAssets(raw, graph).map((m) => m.name)).toEqual(['Feed Pump P-07']);
  });
});
