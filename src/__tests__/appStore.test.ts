// 2.5/2.6 client layer against the mock store (?mock=1 → localStorage KV,
// in-memory object URLs). The real fvApi handlers were each verified with
// `facilio vibe function run` — see the PR description.
import { describe, expect, it } from 'vitest';
import { appStore } from '../api/appStore';

function mockMode() {
  window.history.replaceState({}, '', '/?mock=1');
}

describe('appStore (mock mode)', () => {
  it('kv round-trip: put → get → list → delete', async () => {
    mockMode();

    await appStore.kvPut('surveys', 'survey.1', { name: 'Plant room sweep', markers: 3 });
    await appStore.kvPut('surveys', 'survey.2', { name: 'Ward B', markers: 1 });
    await appStore.kvPut('codes', 'qr.abc', { assetId: 3001 });

    expect(await appStore.kvGet('surveys', 'survey.1')).toEqual({
      name: 'Plant room sweep',
      markers: 3,
    });

    const surveys = await appStore.kvList('surveys', 'survey.');
    expect(surveys.map((e) => e.key).sort()).toEqual(['survey.1', 'survey.2']);
    // Collections are isolated
    expect(await appStore.kvList('codes')).toHaveLength(1);

    await appStore.kvDelete('surveys', 'survey.1');
    expect(await appStore.kvGet('surveys', 'survey.1')).toBeNull();
    expect(await appStore.kvList('surveys')).toHaveLength(1);
  });

  it('photo lane: upload returns an id, url resolves, id is what you persist', async () => {
    mockMode();

    const blob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    const fileId = await appStore.uploadPhoto(blob, 'shot.jpg');
    expect(typeof fileId).toBe('number');

    const url = await appStore.getPhotoUrl(fileId);
    expect(url.startsWith('blob:')).toBe(true);

    // Object URLs are session junk — the KV value you persist is the id.
    await appStore.kvPut('surveys', 'capture.1', { photoFileId: fileId });
    const stored = await appStore.kvGet<{ photoFileId: number }>('surveys', 'capture.1');
    expect(stored?.photoFileId).toBe(fileId);
  });
});
