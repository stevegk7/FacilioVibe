import type { DataProvider } from './dataProvider';
import { mockProvider } from './mockProvider';
import { realProvider } from './realProvider';
import { withOfflineQueue } from './offlineQueue';

/**
 * `?mock=1` selects the fixture provider — the whole app is developable with
 * zero org access. Anything else (including no param) hits the real org.
 *
 * Screens must import { provider } from here and never reach for the SDK —
 * see the seam rule in dataProvider.ts.
 */
export function isMockMode(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('mock') === '1';
}

// The real provider's writes ride the offline queue (7.1): network-shaped
// failures queue and replay on reconnect; everything else surfaces untouched.
// Mock mode stays raw — its writes are local and cannot "go offline".
let queuedReal: DataProvider | null = null;

// Resolved per property access, not at module eval: modules load before the
// app (or a test) has a URL worth inspecting, and binding the choice at import
// time silently pins the real provider.
export const provider: DataProvider = new Proxy({} as DataProvider, {
  get(_target, prop: keyof DataProvider) {
    if (isMockMode()) return mockProvider[prop];
    queuedReal ??= withOfflineQueue(realProvider);
    return queuedReal[prop];
  },
});
