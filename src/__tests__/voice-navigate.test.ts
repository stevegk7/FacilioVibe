// Plan 2 phases 1-2: the agent RESOLVES a destination, the router computes the
// path. The agent must never be able to navigate to an id it invented.
import { describe, expect, it, vi } from 'vitest';
import { runToolLoop } from '../voice/toolLoop';
import { fakeDeps } from './wsC-fakes';

const ctx = { siteId: 1 };

/** Replies in order, so a test can script a tool call then a final answer. */
function scriptedTurns(...replies: string[]) {
  let i = 0;
  return vi.fn(async () => replies[Math.min(i++, replies.length - 1)]);
}

describe('navigate_to', () => {
  it('resolves a vague request through find_work_order, then routes', async () => {
    const deps = fakeDeps({
      listOpenWorkOrders: vi.fn(async () => [
        {
          id: 900,
          subject: 'Replace HVAC filter',
          status: 'Open',
          resourceId: 3001,
          resourceName: 'AHU-03',
        },
      ]),
      routeToAsset: vi.fn(async () => ({
        destination: 'Plant Room',
        steps: ['Head to Lift 2 — 40m north', 'Take the lift to Plant Room — up 9 floors'],
      })),
      voiceTurn: scriptedTurns(
        '{"tool":"find_work_order","args":{"text":"filter"}}',
        '{"tool":"navigate_to","args":{"assetId":3001}}',
        'Head to Lift 2, then take it up to the Plant Room.',
      ),
    });

    const { answer } = await runToolLoop(
      'take me to the HVAC that needs a filter change',
      ctx,
      deps,
    );

    expect(deps.routeToAsset).toHaveBeenCalledWith(3001);
    expect(answer).toMatch(/Plant Room/i);
  });

  it('refuses an assetId the agent never saw — no invented destinations', async () => {
    const deps = fakeDeps({
      voiceTurn: scriptedTurns(
        '{"tool":"navigate_to","args":{"assetId":999999}}',
        'Sorry, I could not find that asset.',
      ),
    });

    await runToolLoop('take me to asset 999999', ctx, deps);
    expect(deps.routeToAsset).not.toHaveBeenCalled();
  });

  it('says so plainly when the asset is not pinned in any survey', async () => {
    const deps = fakeDeps({
      routeToAsset: vi.fn(async () => null),
      voiceTurn: scriptedTurns(
        '{"tool":"navigate_to","args":{"assetId":42}}',
        'That asset has not been mapped yet.',
      ),
    });

    const { answer } = await runToolLoop('navigate to it', { ...ctx, assetInView: 42 }, deps);
    expect(deps.routeToAsset).toHaveBeenCalledWith(42);
    expect(answer).toMatch(/not been mapped|could not|sorry/i);
  });

  it('distinguishes "no path yet" from "no such destination"', async () => {
    const deps = fakeDeps({
      routeToAsset: vi.fn(async () => ({ destination: 'Plant Room', steps: [] })),
      voiceTurn: scriptedTurns(
        '{"tool":"navigate_to","args":{"assetId":7}}',
        'The Plant Room is not connected on the map yet.',
      ),
    });

    const { answer } = await runToolLoop('take me there', { ...ctx, assetInView: 7 }, deps);
    expect(answer).toMatch(/not connected|map/i);
  });
});

describe('location directions (find_location → direction_to)', () => {
  it('routes to a floor surfaced by find_location', async () => {
    const deps = fakeDeps({
      findLocations: vi.fn(async () => [
        { kind: 'floor' as const, id: 88, name: 'Floor 4', parent: 'Tower A' },
      ]),
      routeToPlace: vi.fn(async () => ({
        destination: 'F4 Lobby',
        steps: ['Head to Lift 2 — 40m north', 'Take the lift to F4 Lobby — up 3 floors'],
      })),
      voiceTurn: scriptedTurns(
        '{"tool":"find_location","args":{"text":"floor 4"}}',
        '{"tool":"direction_to","args":{"kind":"floor","id":88}}',
        'Head to Lift 2, then take it up to the F4 lobby.',
      ),
    });
    const { answer } = await runToolLoop('take me to the fourth floor', ctx, deps);
    expect(deps.routeToPlace).toHaveBeenCalledWith({ kind: 'floor', id: 88 });
    expect(answer).toMatch(/F4/i);
  });

  it('refuses direction_to for a place the loop never surfaced', async () => {
    const deps = fakeDeps({
      voiceTurn: scriptedTurns(
        '{"tool":"direction_to","args":{"kind":"building","id":777}}',
        'Let me look that up first.',
      ),
    });
    await runToolLoop('directions to building 777', ctx, deps);
    expect(deps.routeToPlace).not.toHaveBeenCalled();
  });
});

describe('work orders by id + task adds', () => {
  it('a numeric find_work_order resolves the id directly, any status', async () => {
    const deps = fakeDeps({
      getWorkOrder: vi.fn(async () => ({
        id: 14275287,
        subject: 'AC service',
        status: 'Submitted',
        resourceId: 2282232,
        resourceName: 'Warehouse Panel',
      })),
      voiceTurn: scriptedTurns(
        '{"tool":"find_work_order","args":{"text":"14275287"}}',
        'Work order 14275287 is Submitted.',
      ),
    });
    const { answer } = await runToolLoop('status of work order 14275287', ctx, deps);
    expect(deps.getWorkOrder).toHaveBeenCalledWith(14275287);
    expect(answer).toMatch(/Submitted/);
  });

  it('add_tasks writes only to a work order the loop has seen (or in view)', async () => {
    const deps = fakeDeps({
      voiceTurn: scriptedTurns(
        '{"tool":"add_tasks","args":{"workOrderId":555,"tasks":["Check belts"]}}',
        'I need to look that work order up first.',
      ),
    });
    await runToolLoop('add a belt check to 555', ctx, deps);
    expect(deps.addWorkOrderTask).not.toHaveBeenCalled();
  });

  it('add_tasks on the work order IN VIEW appends every subject', async () => {
    const deps = fakeDeps({
      voiceTurn: scriptedTurns(
        '{"tool":"add_tasks","args":{"tasks":["Check belt tension","Grease bearings"]}}',
        'Added both tasks.',
      ),
    });
    await runToolLoop('add belt and grease checks', { ...ctx, workOrderInView: 77 }, deps);
    expect(deps.addWorkOrderTask).toHaveBeenCalledWith(77, 'Check belt tension');
    expect(deps.addWorkOrderTask).toHaveBeenCalledWith(77, 'Grease bearings');
  });
});
