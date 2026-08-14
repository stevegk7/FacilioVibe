/**
 * Offline write queue.
 *
 * Lifted from /Users/rajkumars/Documents/Fun projects/asset-lens/src/api/offlineQueue.ts
 * (semantics preserved), retyped to this app's DataProvider.
 *
 * Plant rooms and basements have the most equipment and the least signal.
 * Writes made there are parked in localStorage and replayed when the network
 * returns, so a technician never loses a completed task or a raised fault.
 * Reads stay served by the react-query cache.
 */
import type { DataProvider } from './dataProvider';
import type { WorkOrderDraft } from './types';

export type QueuedOp =
  | { k: 'createWorkOrder'; a: [WorkOrderDraft] }
  | { k: 'changeWorkOrderStatus'; a: [number, string] }
  | { k: 'setWorkOrderTaskStatus'; a: [number, number, boolean] };

const KEY = 'fv.offlineQueue';
const listeners = new Set<(n: number) => void>();

function read(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as QueuedOp[]) : [];
  } catch {
    return [];
  }
}

function write(q: QueuedOp[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* storage full — the op is lost either way, nothing better to do */
  }
  for (const l of listeners) l(q.length);
}

/** The parked ops, oldest first. */
export function pendingOps(): QueuedOp[] {
  return read();
}

/** Subscribe to the pending count (fires immediately). Returns an unsubscribe. */
export function onQueueChange(listener: (n: number) => void): () => void {
  listeners.add(listener);
  listener(read().length);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Network-ish failures are queued; validation and API errors must still
 * surface to the caller — a rejected write is not a lost write.
 */
function isOffline(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const m = err instanceof Error ? err.message : String(err ?? '');
  return /failed to fetch|networkerror|load failed|timeout|502|503|504/i.test(m);
}

// The provider the queue replays against — set by withOfflineQueue so callers
// (and the connectivity banner) can flush without threading it through.
let target: DataProvider | null = null;
let flushing = false;
let onlineHooked = false;

function runOp(provider: DataProvider, op: QueuedOp): Promise<unknown> {
  switch (op.k) {
    case 'createWorkOrder':
      return provider.createWorkOrder(...op.a);
    case 'changeWorkOrderStatus':
      return provider.changeWorkOrderStatus(...op.a);
    case 'setWorkOrderTaskStatus':
      return provider.setWorkOrderTaskStatus(...op.a);
  }
}

/**
 * Replay parked ops one at a time, in order. A server-rejected op is dropped
 * with a warning (it would otherwise block the queue forever); a network
 * failure stops the run and leaves the rest for the next 'online'.
 * Returns how many ops left the queue.
 */
export async function flushQueue(provider: DataProvider | null = target): Promise<number> {
  if (!provider || flushing) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  flushing = true;
  let done = 0;
  try {
    let q = read();
    while (q.length) {
      const op = q[0];
      try {
        await runOp(provider, op);
      } catch (err) {
        if (isOffline(err)) break; // still offline: keep the rest for later
        // a permanently rejected op must not block the queue forever
        console.warn(`[offlineQueue] dropping rejected op ${op.k}:`, err);
      }
      q = read().slice(1);
      write(q);
      done += 1;
    }
  } finally {
    flushing = false;
  }
  return done;
}

/**
 * Wrap a provider so field writes survive a dead signal. Reads and everything
 * else pass through untouched.
 */
export function withOfflineQueue(provider: DataProvider): DataProvider {
  const enqueue = (op: QueuedOp) => {
    write([...read(), op]);
  };

  const guard =
    <A extends unknown[]>(k: QueuedOp['k'], fn: (...a: A) => Promise<unknown>) =>
    async (...a: A): Promise<undefined> => {
      try {
        await fn(...a);
        return undefined;
      } catch (err) {
        if (!isOffline(err)) throw err;
        enqueue({ k, a } as unknown as QueuedOp);
        return undefined;
      }
    };

  const wrapped: DataProvider = {
    ...provider,
    changeWorkOrderStatus: guard(
      'changeWorkOrderStatus',
      provider.changeWorkOrderStatus.bind(provider),
    ) as DataProvider['changeWorkOrderStatus'],
    setWorkOrderTaskStatus: guard(
      'setWorkOrderTaskStatus',
      provider.setWorkOrderTaskStatus.bind(provider),
    ) as DataProvider['setWorkOrderTaskStatus'],
    async createWorkOrder(draft) {
      try {
        return await provider.createWorkOrder(draft);
      } catch (err) {
        if (!isOffline(err)) throw err;
        enqueue({ k: 'createWorkOrder', a: [draft] });
        // a negative id marks "raised offline, real id assigned on sync"
        return -Date.now();
      }
    },
  };

  // Replay against the *raw* provider: a re-queue on replay would loop.
  target = provider;
  if (!onlineHooked && typeof window !== 'undefined') {
    onlineHooked = true;
    window.addEventListener('online', () => void flushQueue());
  }
  void flushQueue();

  return wrapped;
}
