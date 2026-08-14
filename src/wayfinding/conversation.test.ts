// The conversational resolver. The no-fabrication rule is structural — only
// graph nodes can be offered — so these tests concentrate on the judgment
// calls: floor references, twin disambiguation, and what gets SAID when no
// route can be drawn.
import { describe, expect, it } from 'vitest';
import { buildAutoGraph } from './autoGraph';
import type { EstateData } from '../estate/types';
import {
  fallbackGuidance,
  handoffPayload,
  nodeWhere,
  parseFloorRef,
  resolvePortfolio,
} from './conversation';

/** Two buildings; the same "AHU" name on two floors of Tower A. */
const ESTATE = {
  name: 'Estate',
  siteNames: ['Site A'],
  counts: {},
  buildings: [
    {
      id: '1', recordId: 1, name: 'Tower A', siteId: 100, siteName: 'Site A',
      w: 30, d: 25, x: 0, z: 0, nF: 2,
      floors: [
        {
          recordId: 11, name: 'Floor 9', floorlevel: 9,
          spaces: [{ recordId: 21, name: 'Electrical Room', polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }],
          markers: [{ recordId: 31, markerModuleName: 'asset', name: 'AHU', code: 'AHU-9', status: 'healthy', spaceId: 21, x: 0, z: 0 }],
        },
        {
          recordId: 12, name: 'Floor 10', floorlevel: 10,
          spaces: [{ recordId: 22, name: 'Electrical Room', polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }],
          markers: [{ recordId: 32, markerModuleName: 'asset', name: 'AHU', code: 'AHU-10', status: 'healthy', spaceId: 22, x: 1, z: 1 }],
        },
      ],
    },
  ],
} as unknown as EstateData;

const graph = buildAutoGraph(ESTATE, {});

describe('parseFloorRef', () => {
  it('reads the shapes people actually say', () => {
    expect(parseFloorRef('AHU on the 9th floor')).toMatchObject({ level: 9, rest: 'AHU' });
    expect(parseFloorRef('take me to the ahu floor 10')).toMatchObject({ level: 10, rest: 'ahu' });
    expect(parseFloorRef('electrical room level 9')).toMatchObject({ level: 9, rest: 'electrical room' });
    expect(parseFloorRef('pump on the ninth floor')).toMatchObject({ level: 9, rest: 'pump' });
    expect(parseFloorRef('the ground floor plant')).toMatchObject({ ground: true });
  });

  it('strips the conversational shell without eating the name', () => {
    expect(parseFloorRef('where is the AHU?').rest).toBe('AHU');
    expect(parseFloorRef('I need to go to the electrical room').rest.toLowerCase()).toBe(
      'electrical room',
    );
  });
});

describe('resolvePortfolio', () => {
  it('a floor reference turns twins into one answer', () => {
    const r = resolvePortfolio(graph, 'AHU on the 9th floor');
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.node.recordId).toBe(31);
  });

  it('without the floor, twins become a question with the real options', () => {
    const r = resolvePortfolio(graph, 'take me to the AHU');
    expect(r.kind).toBe('many');
    if (r.kind === 'many') {
      expect(r.candidates.length).toBe(2);
      expect(r.question).toMatch(/which one/i);
      // The chips must be tellable-apart: same label, different floor.
      const wheres = r.candidates.map((c) => nodeWhere(graph, c));
      expect(new Set(wheres).size).toBe(2);
    }
  });

  it('an unknown place is an honest none, never a guess', () => {
    expect(resolvePortfolio(graph, 'take me to the helipad').kind).toBe('none');
    expect(resolvePortfolio(null, 'AHU').kind).toBe('none');
  });
});

describe('fallbackGuidance', () => {
  it('composes real hierarchy into steps and admits the limit', () => {
    const dest = graph.nodes.find((n) => n.id === 'asset:32')!;
    const text = fallbackGuidance(graph, dest);
    expect(text).toMatch(/couldn't draw an automatic route/i);
    expect(text).toContain('Tower A');
    expect(text).toContain('Floor 10');
    // Multi-floor building has a stair core, so the guidance may say stairs.
    expect(text).toMatch(/stairs|lift|go to/i);
  });
});

describe('handoffPayload', () => {
  it('carries the destination by stable id, and only for real kinds', () => {
    const asset = graph.nodes.find((n) => n.id === 'asset:31')!;
    expect(handoffPayload([], asset).dest).toEqual({ kind: 'asset', recordId: 31 });
    const floor = graph.nodes.find((n) => n.id === 'floor:11')!;
    expect(handoffPayload([], floor).dest).toBeUndefined();
    expect(handoffPayload([], null).dest).toBeUndefined();
  });
});
