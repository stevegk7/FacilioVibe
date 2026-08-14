// The pure half of "Find an asset". The engine's setSearch only dims pins on
// an open floor, which is why the box read as broken — this module is what
// actually answers the query. Ranking rules matter: they decide what Enter
// picks.
import { describe, expect, it } from 'vitest';
import { searchEstate, type SearchableEstate } from '../estate/searchEstate';

const ESTATE: SearchableEstate = {
  buildings: [
    {
      id: 'b1',
      name: 'Tower A',
      floors: [
        {
          recordId: 11,
          name: 'Floor 1',
          spaces: [
            { recordId: 21, name: 'Plant Room' },
            { recordId: 22, name: 'AH Plant Annex' },
          ],
          markers: [
            // name and code DIFFER on purpose. They used to be identical here,
            // which hid a real bug for as long as the fixture existed: the
            // panel displays `code`, search matched `name`, and typing the code
            // off the screen returned nothing.
            {
              recordId: 31,
              name: 'Air Handling Unit',
              code: 'AHU-03',
              qrVal: 'facilio_31',
              spaceName: 'Plant Room',
              markerModuleName: 'asset',
            },
            { recordId: 32, name: 'Chiller CH-01', code: 'CH-01', markerModuleName: 'asset' },
            // Work orders tint assets; they are not destinations.
            { recordId: 33, name: 'AHU belt replacement', markerModuleName: 'workorder' },
          ],
        },
      ],
    },
    {
      id: 'b2',
      name: 'AHU Test Wing',
      floors: [{ recordId: 12, name: 'G', spaces: [], markers: [] }],
    },
  ],
};

describe('searchEstate', () => {
  it('needs two characters — a single letter matches half the estate', () => {
    expect(searchEstate(ESTATE, 'a')).toEqual([]);
    expect(searchEstate(ESTATE, ' ')).toEqual([]);
    expect(searchEstate(null, 'ahu')).toEqual([]);
  });

  it('ranks assets above spaces above buildings for the same query', () => {
    const hits = searchEstate(ESTATE, 'ah');
    const kinds = hits.map((h) => h.kind);
    // AHU-03 (asset, prefix) first; the annex space and the building follow.
    expect(hits[0]).toMatchObject({ kind: 'asset', recordId: 31, label: 'AHU-03' });
    expect(kinds.indexOf('space')).toBeGreaterThan(kinds.indexOf('asset'));
    expect(kinds.indexOf('building')).toBeGreaterThan(kinds.indexOf('space'));
  });

  it('prefix beats substring within a kind', () => {
    const hits = searchEstate(ESTATE, 'ch');
    // "Chiller CH-01" starts with the query; nothing that merely contains
    // "ch" may outrank it.
    expect(hits[0]).toMatchObject({ kind: 'asset', recordId: 32 });
  });

  it('never returns work-order markers', () => {
    const hits = searchEstate(ESTATE, 'belt');
    expect(hits).toEqual([]);
  });

  it('carries the flight coordinates: building and floor of each hit', () => {
    const [hit] = searchEstate(ESTATE, 'plant room');
    expect(hit).toMatchObject({ kind: 'space', recordId: 21, buildingId: 'b1', floorId: 11 });
    expect(hit.sub).toContain('Tower A');
  });

  it('caps the list', () => {
    expect(searchEstate(ESTATE, 'ah', 2)).toHaveLength(2);
  });

  // The four things a technician actually types: what the panel shows them,
  // what is printed on the equipment, what the scanner reads, and where it is.
  it('matches the asset CODE — the identifier every panel displays', () => {
    const [hit] = searchEstate(ESTATE, 'ahu-03');
    expect(hit).toMatchObject({ kind: 'asset', recordId: 31 });
  });

  it('labels the hit with the code, so the dropdown reads like the panel', () => {
    expect(searchEstate(ESTATE, 'ahu-03')[0].label).toBe('AHU-03');
  });

  it('still matches the asset name when that is what they remember', () => {
    const hits = searchEstate(ESTATE, 'air handling');
    expect(hits[0]).toMatchObject({ kind: 'asset', recordId: 31 });
  });

  it('matches a scanned QR value', () => {
    const hits = searchEstate(ESTATE, 'facilio_31');
    expect(hits[0]).toMatchObject({ kind: 'asset', recordId: 31 });
  });

  it('matches the record id', () => {
    const hits = searchEstate(ESTATE, '31');
    expect(hits.some((h) => h.kind === 'asset' && h.recordId === 31)).toBe(true);
  });

  it('finds the ASSET when a room name is typed, not just the room', () => {
    const hits = searchEstate(ESTATE, 'plant room');
    expect(hits.some((h) => h.kind === 'asset' && h.recordId === 31)).toBe(true);
    // …and the room itself still ranks above the asset it merely contains.
    expect(hits[0]).toMatchObject({ kind: 'space', recordId: 21 });
  });

  it('keeps a location match below a real identity match', () => {
    // 'ch' hits Chiller CH-01 by name/code; nothing matched by location may win.
    expect(searchEstate(ESTATE, 'ch')[0]).toMatchObject({ recordId: 32 });
  });
});
