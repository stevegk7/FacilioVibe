// qr-smoke (WS-A): extractAssetId table, the code registry, and the CONFLICT
// path — a code the registry maps to one target while the code itself encodes
// a different asset. The sheet must ASK; it must never auto-pick or silently
// repoint the registry.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appStore } from '../api/appStore';
import type { CodeEntry } from '../api/types';
import { CodeSheet } from '../components/camera/CodeSheets';
import { linkCode, resolveCode } from '../vision/codes';
import { extractAssetId, normalizeCode } from '../vision/qr';

function mockMode() {
  window.history.replaceState({}, '', '/?mock=1');
}

describe('extractAssetId', () => {
  it.each([
    ['facilio_123', 123], // Facilio qrVal format
    ['FACILIO_88', 88], // …case-insensitive
    ['3001', 3001], // bare digits
    ['?asset=45', 45], // bare query string
    ['https://app.facilio.com/scan?asset=45', 45],
    ['https://app.facilio.com/a?id=777', 777],
    ['https://app.facilio.com/a?qr=9042', 9042],
    ['https://app.facilio.com/app/assets/4521', 4521], // trailing path digits
    ['https://app.facilio.com/app/assets/4521/', 4521],
    ['gibberish-sticker', null],
    ['12', null], // bare short runs are too collision-prone
    ['https://app.facilio.com/about', null],
  ] as const)('%s → %s', (code, expected) => {
    expect(extractAssetId(code)).toBe(expected);
  });

  it('normalizeCode trims, lowercases and bounds length', () => {
    expect(normalizeCode('  FACILIO_9 ')).toBe('facilio_9');
    expect(normalizeCode('x'.repeat(500))).toHaveLength(200);
  });
});

describe('code registry (mock mode)', () => {
  it('linking a new code stores a CodeEntry and resolves to it', async () => {
    mockMode();

    expect(await resolveCode('QR-STICKER-A1')).toEqual({
      kind: 'unknown',
      code: 'qr-sticker-a1',
    });

    await linkCode('QR-STICKER-A1', { type: 'asset', assetId: 3002 });

    const entry = await appStore.kvGet<CodeEntry>('codes', 'qr-sticker-a1');
    expect(entry?.type).toBe('asset');
    expect(entry?.assetId).toBe(3002);

    const res = await resolveCode('qr-sticker-a1');
    expect(res.kind).toBe('target');
    if (res.kind === 'target') expect(res.entry.assetId).toBe(3002);
  });

  it('an unregistered code opens the link-code sheet', async () => {
    mockMode();
    render(<CodeSheet code="mystery-sticker" onClose={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Link this code' })).toBeInTheDocument();
    // type picker offers all four target kinds
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
  });

  it('a code mapped to two different targets opens the conflict sheet and does NOT auto-pick', async () => {
    mockMode();

    // Seed both mappings for one sticker: the registry says Space 2002…
    const seeded: CodeEntry = {
      code: 'facilio_3001',
      type: 'space',
      spaceId: 2002,
      createdAt: '2026-08-01T00:00:00Z',
    };
    await appStore.kvPut('codes', 'facilio_3001', seeded);
    // …while the code itself encodes asset 3001 (the mock org's AHU-03 qrVal).

    const res = await resolveCode('facilio_3001');
    expect(res.kind).toBe('conflict');
    if (res.kind === 'conflict') expect(res.impliedAssetId).toBe(3001);

    render(<CodeSheet code="facilio_3001" onClose={() => {}} />);

    // The conflict sheet ASKS — both targets on offer, a question, no verdict.
    const sheet = await screen.findByRole('alertdialog', { name: 'QR code conflict' });
    expect(sheet).toHaveTextContent('Which one is correct?');
    const keepBtn = await screen.findByRole('button', { name: /^Keep / });
    const relinkBtn = await screen.findByRole('button', { name: /^Relink to / });
    expect(keepBtn).toBeInTheDocument();
    expect(relinkBtn).toBeInTheDocument();

    // give the label enrichment a beat, then prove nothing was repointed
    expect(await screen.findByRole('button', { name: 'Relink to AHU-03' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Keep Server Room' })).toBeInTheDocument();
    expect(await appStore.kvGet<CodeEntry>('codes', 'facilio_3001')).toEqual(seeded);
  });

  it('the conflict only resolves through an explicit user choice', async () => {
    mockMode();
    await appStore.kvPut('codes', 'facilio_3001', {
      code: 'facilio_3001',
      type: 'space',
      spaceId: 2002,
      createdAt: '2026-08-01T00:00:00Z',
    } satisfies CodeEntry);

    const user = userEvent.setup();
    render(<CodeSheet code="facilio_3001" onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Relink to AHU-03' }));

    const entry = await appStore.kvGet<CodeEntry>('codes', 'facilio_3001');
    expect(entry?.type).toBe('asset');
    expect(entry?.assetId).toBe(3001);
  });
});
