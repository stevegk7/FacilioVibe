// Importing a floor plan in the browser.
//
// The extractor used to be a Node CLI, so binding a plan to a floor needed a
// developer with a terminal. It is now one pure module that the CLI and the app
// both call — these tests drive the app's path end to end on a synthetic plan,
// which is also the only way to exercise it: the CAD exports the two shipped
// plans came from are not in the repo.
import { describe, expect, it } from 'vitest';
import { extractPlan, PlanExtractError } from '../estate/planExtract';
import { importPlanFile, validatePlanDocument } from '../estate/planImport';

/**
 * A 10 m x 8 m plate split by one internal wall into two rooms, in the export
 * shape the extractor expects: a plan-plate metadata block giving px-per-unit
 * (world units are mm), and <g data-layer> groups of pure M/L/Z polylines.
 *
 * 100 px per metre => px_per_unit 0.1 per mm.
 */
function syntheticPlanSvg({ divider = true } = {}): string {
  const P = 100; // px per metre
  const w = 10 * P;
  const h = 8 * P;
  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    `M ${x0} ${z0} L ${x1} ${z0} L ${x1} ${z1} L ${x0} ${z1} Z`;

  const walls = [
    rect(0, 0, w, h), // outer shell
    ...(divider ? [`M ${w / 2} 0 L ${w / 2} ${h}`] : []), // one internal wall
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata id="plan-plate">${JSON.stringify({ transform: { px_per_unit_x: 0.1, px_per_unit_y: 0.1 } })}</metadata>
  <g data-layer="A-WALL">
    ${walls.map((d) => `<path d="${d}" />`).join('\n    ')}
  </g>
  <g data-layer="A-DOOR">
    <path d="M ${w / 2} 300 L ${w / 2} 400" />
  </g>
  <g data-layer="A-ANNO-TEXT">
    <path d="M 5 5 L 20 20" />
  </g>
</svg>`;
}

function fileOf(name: string, body: string): File {
  return new File([body], name, { type: name.endsWith('.json') ? 'application/json' : 'image/svg+xml' });
}

describe('extractPlan', () => {
  it('recovers the plate size in real metres from the plate metadata', () => {
    const { plan } = extractPlan(syntheticPlanSvg(), { id: 'synthetic', name: 'Level 1' });
    expect(plan.widthM).toBeCloseTo(10, 1);
    expect(plan.depthM).toBeCloseTo(8, 1);
  });

  it('recovers the enclosed rooms the internal wall creates', () => {
    const { plan } = extractPlan(syntheticPlanSvg(), { id: 'synthetic' });
    // One wall down the middle of a 10x8 plate = two ~40 m² rooms.
    expect(plan.rooms.length).toBe(2);
    for (const room of plan.rooms) {
      expect(room.area).toBeGreaterThan(30);
      expect(room.area).toBeLessThan(45);
      // Rectangle decomposition is what the engine picks and tints against.
      expect(room.rects.length).toBeGreaterThan(0);
    }
  });

  it('without the divider it is one room, not two', () => {
    const { plan } = extractPlan(syntheticPlanSvg({ divider: false }), { id: 'synthetic' });
    expect(plan.rooms.length).toBe(1);
    expect(plan.rooms[0].area).toBeGreaterThan(70);
  });

  it('sorts layers by CAD role and drops annotation', () => {
    const { plan, report } = extractPlan(syntheticPlanSvg(), { id: 'synthetic' });
    expect(plan.layers.walls.length).toBeGreaterThan(0);
    expect(plan.layers.doors.length).toBeGreaterThan(0);
    // The text layer contributes no geometry, and says so rather than vanishing.
    expect(report.dropped.some(([layer]) => /ANNO/i.test(layer))).toBe(true);
  });

  it('centres geometry on the plate, so a floor can sit at any world position', () => {
    const { plan } = extractPlan(syntheticPlanSvg(), { id: 'synthetic' });
    const xs = plan.layers.walls.flat().map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(-5, 0);
    expect(Math.max(...xs)).toBeCloseTo(5, 0);
  });

  it('names the reason when the export has no plate metadata', () => {
    expect(() => extractPlan('<svg><g data-layer="A-WALL"><path d="M 0 0 L 1 1"/></g></svg>')).toThrow(
      /plan-plate/,
    );
  });

  it('names the reason when no recognised CAD layer carries geometry', () => {
    const svg = syntheticPlanSvg().replace(/data-layer="A-WALL"/, 'data-layer="Q-SPCQ-DIMENSION"');
    expect(() => extractPlan(svg)).toThrow(PlanExtractError);
  });
});

describe('importPlanFile', () => {
  it('imports an SVG export', async () => {
    const { plan, report } = await importPlanFile(fileOf('Tower C Level 2.svg', syntheticPlanSvg()));
    expect(plan.id).toBe('tower-c-level-2');
    expect(plan.name).toBe('Tower C Level 2');
    expect(plan.source).toBe('Tower C Level 2.svg');
    expect(plan.rooms.length).toBe(2);
    expect(report?.kept.length).toBeGreaterThan(0);
  });

  it('imports an already-extracted plan JSON', async () => {
    const { plan } = extractPlan(syntheticPlanSvg(), { id: 'offline', name: 'Offline' });
    const { plan: reimported } = await importPlanFile(fileOf('offline.json', JSON.stringify(plan)));
    expect(reimported.id).toBe('offline');
    expect(reimported.rooms.length).toBe(plan.rooms.length);
    expect(reimported.widthM).toBe(plan.widthM);
  });

  it('refuses a plan JSON with no walls instead of rendering an empty floor', async () => {
    const bad = { widthM: 10, depthM: 8, rooms: [], layers: { walls: [] } };
    await expect(importPlanFile(fileOf('bad.json', JSON.stringify(bad)))).rejects.toThrow(/no wall geometry/i);
  });

  it('refuses a plan JSON with no scale', async () => {
    const bad = { rooms: [], layers: { walls: [[[0, 0], [1, 1]]] } };
    await expect(importPlanFile(fileOf('bad.json', JSON.stringify(bad)))).rejects.toThrow(/widthM/);
  });

  it('refuses a room with no rectangles — spaces could not bind to it', () => {
    const bad = {
      widthM: 10,
      depthM: 8,
      rooms: [{ id: 1, area: 5, cx: 0, cz: 0, x0: 0, z0: 0, x1: 1, z1: 1, rects: [] }],
      layers: { walls: [[[0, 0], [1, 1]]] },
    };
    expect(() => validatePlanDocument(bad, 'x')).toThrow(/rectangles/i);
  });

  it('tells the user what a non-plan file is, rather than failing obscurely', async () => {
    await expect(importPlanFile(fileOf('notes.txt', 'just some text'))).rejects.toThrow(
      /neither an SVG plan nor an extracted plan JSON/,
    );
  });

  it('rejects a huge file before spending a parse on it', async () => {
    const big = new File(['x'], 'huge.svg', { type: 'image/svg+xml' });
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 });
    await expect(importPlanFile(big)).rejects.toThrow(/geometry only/);
  });
});
