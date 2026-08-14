import type { DataProvider } from './dataProvider';
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

/**
 * The fixture provider, INSTALLED rather than imported.
 *
 * It used to be a static import, which put the whole demo lane — fixture
 * records, the seeded wayfinding dataset, every landmark instruction — in the
 * entry chunk that every real technician downloads on a phone, to serve a URL
 * parameter almost none of them will ever use. The budget guard measures that
 * chunk, so the demo data was also crowding out real features.
 *
 * The Proxy below must stay SYNCHRONOUS (every screen calls `provider.x()`
 * directly), so the import cannot happen on demand at the call site. Instead the
 * bootstrap resolves it before the first render — see `ensureMockProvider`.
 */
let mockImpl: DataProvider | null = null;

/** Install a fixture provider synchronously. Tests use this; they bundle the
    fixtures anyway and set the URL per case, long after this module evaluated. */
export function installMockProvider(impl: DataProvider): void {
  mockImpl = impl;
}

/**
 * Load the fixture provider if — and only if — this page is in mock mode.
 * A no-op otherwise, so a production session never fetches the demo chunk.
 * Must be awaited before the first render; `provider` throws rather than
 * silently falling through to the real org if it is not.
 */
export async function ensureMockProvider(): Promise<void> {
  if (!isMockMode() || mockImpl) return;
  const { mockProvider } = await import('./mockProvider');
  mockImpl = mockProvider;
}

// Resolved per property access, not at module eval: modules load before the
// app (or a test) has a URL worth inspecting, and binding the choice at import
// time silently pins the real provider.
export const provider: DataProvider = new Proxy({} as DataProvider, {
  get(_target, prop: keyof DataProvider) {
    if (isMockMode()) {
      if (!mockImpl) {
        // Loudly, because the alternative is a demo session quietly reading and
        // WRITING the live org.
        throw new Error(
          'Mock mode is on but the fixture provider has not loaded — await ensureMockProvider() before rendering.',
        );
      }
      return mockImpl[prop];
    }
    queuedReal ??= withOfflineQueue(realProvider);
    return queuedReal[prop];
  },
});
