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
import { buildDemoDataset, MOCK_DEMO_IDS } from '../wayfinding/demoData';

let seeding: Promise<void> | null = null;

export async function seedMockDemoData(): Promise<void> {
  if (!isMockMode()) return;
  // One in-flight seed per session — two screens mounting at once must not race.
  seeding ??= (async () => {
    const dataset = buildDemoDataset(MOCK_DEMO_IDS);
    const existing = await appStore.kvGet('settings', graphKey(dataset.graph.siteId));
    if (existing) return;
    await Promise.all([
      appStore.kvPut('settings', graphKey(dataset.graph.siteId), dataset.graph),
      appStore.kvPut('settings', `sitegeo.${dataset.sitegeo.siteId}`, dataset.sitegeo),
      ...dataset.surveys.map((s) => appStore.kvPut('surveys', `survey.${s.id}`, s)),
      ...dataset.codes.map((c) => appStore.kvPut('codes', normalizeCode(c.code), c)),
    ]);
  })();
  return seeding;
}

/** TEST ONLY — lets a test re-seed after clearing localStorage. */
export function __resetDemoSeedForTest(): void {
  seeding = null;
}
