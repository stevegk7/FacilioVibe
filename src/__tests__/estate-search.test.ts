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
            { recordId: 31, name: 'AHU-03', code: 'AHU-03', markerModuleName: 'asset' },
            { recordId: 32, name: 'Chiller CH-01', markerModuleName: 'asset' },
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
});
