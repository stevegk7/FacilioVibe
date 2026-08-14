/**
 * Mock-mode demo seeding — the whole app should be walkable under ?mock=1
 * with ZERO setup, wayfinding included, because that is how it is demoed,
 * tested and developed (README: "?mock=1 renders the whole app").
 *
 * Strictly gated on mock mode: this must never be able to write org data.
 * Idempotent by inspection — it writes only when the demo graph is absent —
 * and the Settings "Danger zone" clear (which wipes fv.mockKv*) resets it.
 * The LIVE equivalent of this file is tools/seed-wayfinding.mjs.
 */
import { appStore } from './appStore';
import { isMockMode } from './provider';
import { normalizeCode } from '../vision/qr';
import { graphKey } from '../wayfinding/graph';

let seeding: Promise<void> | null = null;

export async function seedMockDemoData(): Promise<void> {
  if (!isMockMode()) return;
  // One IN-FLIGHT seed — two screens mounting at once must not race. The
  // promise is released when it settles, so (a) a failed seed retries instead
  // of being cached forever, and (b) clearing mock storage from Settings'
  // Danger zone re-seeds on the next visit rather than leaving the app empty
  // until a reload. The kvGet guard below is what keeps re-runs cheap.
  seeding ??= (async () => {
    // Imported here, not at the top: the demo dataset is ~11KB of fixtures and
    // landmark copy that only a ?mock=1 session ever reads. This function is
    // already async and already gated on mock mode, so deferring it costs
    // nothing and keeps the entry chunk free of demo content.
    const { buildDemoDataset, MOCK_DEMO_IDS } = await import('../wayfinding/demoData');
    const dataset = buildDemoDataset(MOCK_DEMO_IDS);
    const existing = await appStore.kvGet('settings', graphKey(dataset.graph.siteId));
    if (existing) return;
    await Promise.all([
      appStore.kvPut('settings', graphKey(dataset.graph.siteId), dataset.graph),
      appStore.kvPut('settings', `sitegeo.${dataset.sitegeo.siteId}`, dataset.sitegeo),
      ...dataset.surveys.map((s) => appStore.kvPut('surveys', `survey.${s.id}`, s)),
      ...dataset.codes.map((c) => appStore.kvPut('codes', normalizeCode(c.code), c)),
    ]);
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

/** TEST ONLY — lets a test re-seed after clearing localStorage. */
export function __resetDemoSeedForTest(): void {
  seeding = null;
}
