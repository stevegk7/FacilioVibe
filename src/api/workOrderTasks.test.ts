// Adding a checklist task to a work order.
//
// This shipped calling the generic script lane — `createRecord('task', {...})`
// — on a note that the plain action shared create-work-order's broken schema
// family. It did not: the script's `v3Add` writes the new id back into the map
// for workorder but NOT for task, so the handler threw "Task create returned no
// id" every time. A technician tapping "AI: suggest tasks" saw that in red.
//
// Verified against the live org (2026-08-15): create-work-order-task returns
// {id, subject, status, createdTime} and the task then appears in
// list-work-order-tasks. This test pins the action and its payload so the
// script lane cannot creep back.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cmms = vi.hoisted(() => vi.fn());
const callFn = vi.hoisted(() => vi.fn());

/* The whole helper surface is stubbed explicitly rather than spread over
   importActual: the real module reaches the SDK, and a partial mock still let
   `Vibe.fetch` run. `rowsOf` is the one piece of real behaviour this test
   depends on, so it is reproduced faithfully — an object collapses to a
   one-row list, which is how a single-match response actually arrives. */
vi.mock('./facilioHelpers', () => ({
  cmms,
  execute: vi.fn(),
  fetchAllPages: vi.fn(async () => []),
  chunk: (xs: unknown[], n: number) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n)),
  inFilter: (field: string, ids: number[]) => ({ [field]: ids }),
  rowsOf: (data: unknown) => (Array.isArray(data) ? data : data ? [data] : []),
}));
vi.mock('./scriptFns', () => ({ callFn, FN_NAMESPACE: 'facilio_vision' }));

/* Imported per test after resetModules, the way recordActions.test.ts does it.
   The shared setup file pulls in api/provider, which statically imports
   realProvider — so without a reset the module under test is already bound to
   the REAL helpers and every call reaches the SDK. */
let realProvider: typeof import('./realProvider').realProvider;

beforeEach(async () => {
  cmms.mockReset();
  callFn.mockReset();
  vi.resetModules();
  ({ realProvider } = await import('./realProvider'));
});

describe('addWorkOrderTask', () => {
  it('calls create-work-order-task with the work order id and subject', async () => {
    cmms.mockResolvedValue({ data: { id: 152623992, subject: 'Check the belt' }, success: true });

    const id = await realProvider.addWorkOrderTask(14275295, 'Check the belt');

    expect(id).toBe(152623992);
    expect(cmms).toHaveBeenCalledWith('create-work-order-task', {
      id: 14275295,
      subject: 'Check the belt',
    });
    // The script lane is the bug being guarded against, not an alternative.
    expect(callFn).not.toHaveBeenCalled();
  });

  it('reads the id when the row arrives wrapped in a list', async () => {
    // A bare filter that matches one row collapses to an object; other shapes
    // arrive as a list. rowsOf normalises both — assert we went through it.
    cmms.mockResolvedValue({ data: [{ id: 42, subject: 'x' }], success: true });
    await expect(realProvider.addWorkOrderTask(1, 'x')).resolves.toBe(42);
  });

  it('throws rather than reporting success when no id comes back', async () => {
    cmms.mockResolvedValue({ data: {}, success: true });
    await expect(realProvider.addWorkOrderTask(1, 'x')).rejects.toThrow(/no id/);
  });
});
