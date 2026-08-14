// The asset picker is a DROPDOWN, not a bare search box: options are visible
// the moment it opens (an empty query lists the scope), the filter narrows,
// and choosing never commits a marker by itself.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import AssetSelect from '../components/AssetSelect';
import type { Asset } from '../api/types';

/** The control is controlled — a real parent holds the choice. */
function Host({ onPick }: { onPick: (a: Asset) => void }) {
  const [value, setValue] = useState<Asset | null>(null);
  return (
    <AssetSelect
      value={value}
      scopeSiteId={undefined}
      onPick={(a) => {
        setValue(a);
        onPick(a);
      }}
    />
  );
}

function mount(onPick: (a: Asset) => void) {
  window.history.replaceState({}, '', '/?mock=1');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Host onPick={onPick} />
    </QueryClientProvider>,
  );
}

describe('AssetSelect', () => {
  it('opens as a combobox and lists the scope WITHOUT typing anything', async () => {
    const user = userEvent.setup();
    mount(() => undefined);

    const trigger = screen.getByRole('combobox', { name: 'Asset' });
    expect(trigger).toHaveClass('ds-select-btn'); // the DSM control, not a bare input
    await user.click(trigger);

    // options appear with an EMPTY query — that was the whole complaint
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(2);

    // and the list SCROLLS instead of bleeding over whatever sits below it —
    // the capped-but-unscrollable box is exactly what broke the Place-asset
    // sheet (options painted across the CTA)
    const list = screen.getByRole('listbox', { name: 'Asset' });
    expect(list).toHaveClass('scroll-y');
  });

  it('the filter narrows and picking closes the list', async () => {
    const user = userEvent.setup();
    const picked: Asset[] = [];
    mount((a) => picked.push(a));

    await user.click(screen.getByRole('combobox', { name: 'Asset' }));
    await screen.findAllByRole('option');
    await user.type(screen.getByLabelText('Filter assets'), 'ahu');

    await waitFor(() => {
      const rows = screen.getAllByRole('option');
      expect(rows.every((r) => /ahu/i.test(r.textContent ?? ''))).toBe(true);
    });

    await user.click(screen.getAllByRole('option')[0]);
    expect(picked).toHaveLength(1);
    expect(screen.queryByRole('option')).toBeNull(); // closed
    // the trigger now names the choice
    expect(screen.getByRole('combobox', { name: 'Asset' })).toHaveTextContent(picked[0].name);
  });
});

describe('deep links (fillLink)', () => {
  it('fills {id}, requires http(s), hides when unset', async () => {
    const { fillLink } = await import('../api/links');
    expect(fillLink('https://acme.facilio.com/maintenance/workorder/{id}/summary', 42)).toBe(
      'https://acme.facilio.com/maintenance/workorder/42/summary',
    );
    expect(fillLink('', 42)).toBeNull();
    expect(fillLink('no-placeholder', 42)).toBeNull();
    expect(fillLink('javascript:alert(1)//{id}', 42)).toBeNull();
  });
});

describe('AI brief fallback', () => {
  it('the deterministic brief names the count and the oldest open work order', async () => {
    const { localBrief } = await import('../api/agents');
    const text = localBrief({ name: 'AHU-03' }, [
      { id: 9, subject: 'Replace filter', status: 'Open' },
      { id: 4, subject: 'Belt inspection', status: 'Open' },
      { id: 2, subject: 'Old fix', status: 'Closed' },
    ]);
    expect(text).toContain('AHU-03');
    expect(text).toContain('2 open');
    expect(text).toContain('#4');
  });

  it('a clear asset is said to be clear', async () => {
    const { localBrief } = await import('../api/agents');
    expect(localBrief({ name: 'AHU-03' }, [])).toMatch(/clear/i);
  });
});

describe('system navigation (connected-app openSummary)', () => {
  it('embedded detection requires BOTH host params; standalone falls back fast', async () => {
    const { isEmbeddedInFacilio, openRecordSummary } = await import('../api/nav');
    window.history.replaceState({}, '', '/?mock=1');
    expect(isEmbeddedInFacilio()).toBe(false);
    // standalone: resolves false immediately — the caller uses the template
    await expect(openRecordSummary('workorder', 42)).resolves.toBe(false);

    window.history.replaceState({}, '', '/?origin=https%3A%2F%2Facme.facilio.com&capp_id=77');
    expect(isEmbeddedInFacilio()).toBe(true);

    window.history.replaceState({}, '', '/?origin=https%3A%2F%2Facme.facilio.com');
    expect(isEmbeddedInFacilio()).toBe(false); // origin alone is not the host
    window.history.replaceState({}, '', '/?mock=1');
  });
});
