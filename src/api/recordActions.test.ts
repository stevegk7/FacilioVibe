// The AR panel's action strip is only as honest as what the flow reports, so
// these pin the contract the panel relies on: the buttons CHANGE with the
// state, a terminal state offers nothing, and a form-bearing transition
// actually carries its input through.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { mockProvider as MockProvider } from './mockProvider';

const names = (a: { name: string }[]) => a.map((x) => x.name);

/**
 * The fixtures are module-level mutable arrays on purpose — a status change has
 * to stick within a session for the mock to behave like a live org. That makes
 * them shared state between tests, and these tests all transition the SAME work
 * order, so the registry is reset per case rather than having each test guess
 * which state the previous one left behind.
 */
let mockProvider: typeof MockProvider;
let setSessionScope: typeof import('./scope').setSessionScope;

async function actionsFor(id: number) {
  return (await mockProvider.getWorkOrderActions(id)).stateTransitions;
}

describe('work order actions come from the flow, not a catalogue', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Same fresh registry for both, or the provider would be reading a
    // different scope module than the one this test sets.
    ({ mockProvider } = await import('./mockProvider'));
    ({ setSessionScope } = await import('./scope'));
    setSessionScope({ role: 'admin' });
  });

  it('offers only what the current state allows', async () => {
    // 4001 is Open: it can be assigned, started or cancelled — NOT closed.
    const open = await actionsFor(4001);
    expect(names(open)).toEqual(['Assign Worker', 'Start Work', 'Cancel']);
    expect(names(open)).not.toContain('Close');
    expect(names(open)).not.toContain('Resolve');
  });

  it('offers a different set once the state moves — the panel must re-read', async () => {
    const [start] = (await actionsFor(4001)).filter((a) => a.name === 'Start Work');
    await mockProvider.executeWorkOrderAction(4001, start);

    expect(names(await actionsFor(4001))).toEqual(['Resolve', 'Pause']);
    expect((await mockProvider.getWorkOrder(4001))?.status).toBe('In Progress');
  });

  it('walks the whole lifecycle without ever offering an illegal move', async () => {
    const step = async (name: string) => {
      const action = (await actionsFor(4001)).find((a) => a.name === name);
      expect(action, `${name} should be offered here`).toBeTruthy();
      await mockProvider.executeWorkOrderAction(4001, action!);
      return (await mockProvider.getWorkOrder(4001))?.status;
    };

    expect(await step('Start Work')).toBe('In Progress');
    expect(await step('Resolve')).toBe('Resolved');
    expect(await step('Close')).toBe('Closed');
    // Closed is not terminal in this flow — it can be re-opened, and only that.
    expect(names(await actionsFor(4001))).toEqual(['Re-Open']);
  });

  it('offers nothing at all in a terminal state, rather than a dead button', async () => {
    const cancel = (await actionsFor(4001)).find((a) => a.name === 'Cancel')!;
    await mockProvider.executeWorkOrderAction(4001, cancel);

    expect(await actionsFor(4001)).toEqual([]);
  });

  it('carries a form-bearing transition’s input through to the record', async () => {
    const assign = (await actionsFor(4001)).find((a) => a.name === 'Assign Worker')!;
    // The flow declares the field; the panel renders it because of this, not
    // because anything in the app knows what "Assign Worker" means.
    expect(assign.form?.fields?.[0]?.name).toBe('assignment');

    await mockProvider.executeWorkOrderAction(4001, assign, { assignment: 'Priya' });
    expect((await mockProvider.getWorkOrder(4001))?.assignedTo).toBe('Priya');
  });

  it('refuses to act on a work order this technician cannot even read', async () => {
    // 4002 is Arun's. The flow gate and the scoping gate must agree.
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });

    expect(await actionsFor(4002)).toEqual([]);
    await expect(
      mockProvider.executeWorkOrderAction(4002, { buttonId: 9102, buttonType: 'stateTransition' }),
    ).rejects.toThrow();
  });
});
