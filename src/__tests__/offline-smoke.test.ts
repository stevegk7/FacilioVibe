// offline-smoke (WS-E): the write queue only swallows *network* failures.
//  - a fetch failure while offline parks the op and hands back a negative id
//  - 'online' replays it exactly once and the queue empties
//  - a validation error is the caller's problem and must never be queued
//  - a server-rejected op is dropped, not left blocking the ones behind it
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataProvider } from '../api/dataProvider';
import type { WorkOrderDraft } from '../api/types';
import { flushQueue, onQueueChange, pendingOps, withOfflineQueue } from '../api/offlineQueue';

const draft: WorkOrderDraft = { subject: 'Leaking AHU' } as WorkOrderDraft;

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/** Only the write methods matter here; the rest of the seam is never touched. */
function fakeProvider(over: Partial<DataProvider>): DataProvider {
  return {
    createWorkOrder: () => Promise.resolve(1),
    changeWorkOrderStatus: () => Promise.resolve(),
    setWorkOrderTaskStatus: () => Promise.resolve(),
    ...over,
  } as DataProvider;
}

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
});

afterEach(() => {
  setOnline(true);
  vi.restoreAllMocks();
});

describe('withOfflineQueue', () => {
  it('queues a network-failed createWorkOrder and replays it on "online"', async () => {
    setOnline(false);
    let fail = true;
    const provider = fakeProvider({
      createWorkOrder: () =>
        fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(4242),
    });
    const createSpy = vi.spyOn(provider, 'createWorkOrder');

    const counts: number[] = [];
    const unsubscribe = onQueueChange((n) => counts.push(n));

    const wrapped = withOfflineQueue(provider);
    const id = await wrapped.createWorkOrder(draft);

    expect(id).toBeLessThan(0);
    expect(pendingOps()).toEqual([{ k: 'createWorkOrder', a: [draft] }]);
    expect(counts.at(-1)).toBe(1);

    fail = false;
    setOnline(true);
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(pendingOps()).toHaveLength(0));
    // one failed attempt + exactly one replay
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(counts.at(-1)).toBe(0);
    unsubscribe();
  });

  it('lets a validation error through untouched', async () => {
    const provider = fakeProvider({
      createWorkOrder: () => Promise.reject(new Error('VALIDATION_ERROR: subject required')),
    });
    const wrapped = withOfflineQueue(provider);

    await expect(wrapped.createWorkOrder(draft)).rejects.toThrow('VALIDATION_ERROR');
    expect(pendingOps()).toHaveLength(0);
  });

  it('queues the void writes too, by message shape alone', async () => {
    const provider = fakeProvider({
      changeWorkOrderStatus: () => Promise.reject(new Error('503 Service Unavailable')),
      setWorkOrderTaskStatus: () => Promise.reject(new Error('BAD_REQUEST: no such task')),
    });
    const wrapped = withOfflineQueue(provider);

    await expect(wrapped.changeWorkOrderStatus(7, 'Closed')).resolves.toBeUndefined();
    await expect(wrapped.setWorkOrderTaskStatus(7, 9, true)).rejects.toThrow('BAD_REQUEST');
    expect(pendingOps()).toEqual([{ k: 'changeWorkOrderStatus', a: [7, 'Closed'] }]);
  });

  it('drops a server-rejected op during replay and keeps replaying the rest', async () => {
    localStorage.setItem(
      'fv.offlineQueue',
      JSON.stringify([
        { k: 'createWorkOrder', a: [{ subject: 'first' }] },
        { k: 'createWorkOrder', a: [{ subject: 'second' }] },
      ]),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: string[] = [];
    const provider = fakeProvider({
      createWorkOrder: (d: WorkOrderDraft) => {
        seen.push(d.subject);
        return d.subject === 'first'
          ? Promise.reject(new Error('FIELD_ERROR: site is mandatory'))
          : Promise.resolve(88);
      },
    });

    const done = await flushQueue(provider);

    expect(seen).toEqual(['first', 'second']);
    expect(done).toBe(2);
    expect(pendingOps()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('stops replaying when the network is still down', async () => {
    localStorage.setItem(
      'fv.offlineQueue',
      JSON.stringify([
        { k: 'createWorkOrder', a: [{ subject: 'first' }] },
        { k: 'createWorkOrder', a: [{ subject: 'second' }] },
      ]),
    );
    const provider = fakeProvider({
      createWorkOrder: () => Promise.reject(new TypeError('Load failed')),
    });

    expect(await flushQueue(provider)).toBe(0);
    expect(pendingOps()).toHaveLength(2);
  });
});
