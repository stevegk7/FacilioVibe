// Binding an imported plan to a floor.
//
// The two plans that ship with the app are matched by building and floor NAME
// (PLAN_ASSIGNMENTS). That is fine as a default for known data and wrong for an
// import: a plan the user attached to a specific floor must not detach because
// somebody renamed the floor, and must not be claimed by a different floor that
// happens to match a regex.
import { describe, expect, it } from 'vitest';
import { buildEstate } from '../estate/buildEstate';
import { extractPlan } from '../estate/planExtract';
import type { EstateRaw } from '../estate/types';

function tinyPlan(id: string) {
  const P = 100;
  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    `M ${x0} ${z0} L ${x1} ${z0} L ${x1} ${z1} L ${x0} ${z1} Z`;
  const svg = `<svg>
    <metadata id="plan-plate">${JSON.stringify({ transform: { px_per_unit_x: 0.1, px_per_unit_y: 0.1 } })}</metadata>
    <g data-layer="A-WALL">
      <path d="${rect(0, 0, 12 * P, 9 * P)}" />
      <path d="M ${6 * P} 0 L ${6 * P} ${9 * P}" />
    </g>
  </svg>`;
  return extractPlan(svg, { id, name: id }).plan;
}

/** Two buildings, one floor each, one space and one asset on each floor. */
function records(): EstateRaw {
  return {
    sites: [{ id: 1, name: 'Site' }],
    buildings: [
      { id: 10, name: 'Tower A', site: { id: 1 } },
      { id: 20, name: 'Annexe', site: { id: 1 } },
    ],
    floors: [
      { id: 100, name: 'Floor 1', building: { id: 10 }, site: { id: 1 }, floorlevel: 1 },
      { id: 200, name: 'Level 5', building: { id: 20 }, site: { id: 1 }, floorlevel: 5 },
    ],
    spaces: [
      { id: 1000, name: 'Room A', building: { id: 10 }, floor: { id: 100 }, site: { id: 1 } },
      { id: 2000, name: 'Room B', building: { id: 20 }, floor: { id: 200 }, site: { id: 1 } },
    ],
    assets: [
      { id: 5000, name: 'AHU-1', tagNumber: 'AHU-1', space: { id: 1000 } },
      { id: 6000, name: 'AHU-2', tagNumber: 'AHU-2', space: { id: 2000 } },
    ],
    workOrders: [],
    inspections: [],
    plans: {},
  } as unknown as EstateRaw;
}

const floorOf = (estate: ReturnType<typeof buildEstate>, recordId: number) =>
  estate.buildings.flatMap((b) => b.floors).find((f) => f.recordId === recordId);

describe('plan bindings', () => {
  it('puts an imported plan on the floor it was bound to', () => {
    const raw = records();
    raw.plans = { imported: tinyPlan('imported') };
    raw.planBindings = { 200: 'imported' };

    const estate = buildEstate(raw);
    expect(floorOf(estate, 200)?.plan).toBeTruthy();
    // …and nowhere else.
    expect(floorOf(estate, 100)?.plan).toBeFalsy();
  });

  it('a bound plan beats the name-regex default on the same floor', () => {
    // "Tower A" / "Floor 1" is exactly what PLAN_ASSIGNMENTS matches, so this is
    // the case where the two rules disagree.
    const raw = records();
    raw.plans = { 'ats-level1': tinyPlan('ats-level1'), mine: tinyPlan('mine') };
    raw.planBindings = { 100: 'mine' };

    const estate = buildEstate(raw);
    expect((floorOf(estate, 100)?.plan as { id: string }).id).toBe('mine');
  });

  it('falls back to the shipped default when nothing is bound', () => {
    const raw = records();
    raw.plans = { 'ats-level1': tinyPlan('ats-level1') };

    const estate = buildEstate(raw);
    expect((floorOf(estate, 100)?.plan as { id: string }).id).toBe('ats-level1');
  });

  it('a binding whose plan failed to load degrades to the schematic layout', () => {
    // loadBoundPlans skips a plan it cannot fetch rather than failing the estate.
    const raw = records();
    raw.plans = {};
    raw.planBindings = { 200: 'missing' };

    const estate = buildEstate(raw);
    const floor = floorOf(estate, 200);
    expect(floor?.plan).toBeFalsy();
    // The floor is still there, with its space laid out schematically.
    expect(floor?.spaces.length).toBeGreaterThan(0);
  });

  it('sizes the building plate to the bound drawing', () => {
    const raw = records();
    const plan = tinyPlan('imported');
    raw.plans = { imported: plan };
    raw.planBindings = { 200: 'imported' };

    const estate = buildEstate(raw);
    const annexe = estate.buildings.find((b) => b.recordId === 20)!;
    // Sized FROM the drawing (plan + 0.8 m margin), not from the schematic
    // fallback — which clamps to a 26 m minimum and would swallow this assertion
    // if the binding were quietly ignored.
    expect(annexe.w).toBeCloseTo(plan.widthM + 0.8, 1);
    expect(annexe.d).toBeCloseTo(plan.depthM + 0.8, 1);
  });

  it('binds the floor’s real spaces onto the drawing’s rooms', () => {
    const raw = records();
    raw.plans = { imported: tinyPlan('imported') };
    raw.planBindings = { 200: 'imported' };

    const estate = buildEstate(raw);
    const floor = floorOf(estate, 200)!;
    // Room B is a real Facilio space; on a plan floor it must pick up the
    // drawing's geometry rather than a schematic box.
    const room = floor.spaces.find((s) => s.name === 'Room B');
    expect(room?.fromPlan).toBe(true);
    expect((room?.rects ?? []).length).toBeGreaterThan(0);
  });
});
