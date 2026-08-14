// dashboard-smoke (WS-D): the admin pages against the mock provider + mock KV.
//  - Dashboard stats agree with what the provider actually returns, retired
//    records excluded (the count is derived, never hardcoded)
//  - the work-order and survey tables render, and a survey written to KV shows
//    up in both the stat and the table after an invalidate
//  - the Settings geo editor writes settings/sitegeo.<siteId> and reloads it
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { appStore } from '../api/appStore';
import { mockProvider } from '../api/mockProvider';
import type { SiteGeo, Survey } from '../api/types';
import DashboardScreen, { isOpenStatus, kvKey } from '../screens/DashboardScreen';
import SettingsScreen, { siteGeoKey } from '../screens/SettingsScreen';

function mockMode(query = '') {
  window.history.replaceState({}, '', `/?mock=1${query}`);
}

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...result, queryClient };
}

/** "Surveys" is both a stat cap and a card title — scope the lookup to .stat. */
function statValue(cap: string): string {
  const card = [...document.querySelectorAll('.stat')].find(
    (el) => el.querySelector('.stat-cap')?.textContent === cap,
  );
  return card?.querySelector('.stat-num')?.textContent ?? '';
}

const survey = (id: string, over: Partial<Survey> = {}): Survey => ({
  id,
  name: `Standpoint ${id}`,
  siteId: 1001,
  geo: null,
  sweep: [],
  markers: [{ id: 'm1', label: 'AHU-03', heading: 12, pitch: 0 }],
  modelId: 'stub-test',
  createdAt: '2026-08-12T10:00:00Z',
  ...over,
});

describe('isOpenStatus', () => {
  it('treats only terminal states as not-open, unknown statuses stay visible', () => {
    expect(isOpenStatus('Open')).toBe(true);
    expect(isOpenStatus('In Progress')).toBe(true);
    expect(isOpenStatus('On Hold')).toBe(true);
    expect(isOpenStatus('Closed')).toBe(false);
    expect(isOpenStatus('resolved')).toBe(false);
    expect(isOpenStatus('Cancelled')).toBe(false);
    expect(isOpenStatus('Something Nobody Anticipated')).toBe(true);
    expect(isOpenStatus(undefined)).toBe(true);
  });
});

describe('DashboardScreen (mock mode)', () => {
  it('renders stats and the work-order table from the fixtures', async () => {
    mockMode();
    renderWithClient(<DashboardScreen />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    // The asset count is derived, not hardcoded: the fixtures grew when the 3D
    // estate needed enough rooms to stack, and a magic number here would just
    // break again next time. What matters is that the tile agrees with the
    // provider AND that the retired record is excluded from both.
    const visibleAssets = await mockProvider.searchAssets({});
    expect(visibleAssets.some((a) => /obsolete/i.test(a.name))).toBe(false);
    await waitFor(() => expect(statValue('Assets')).toBe(String(visibleAssets.length)));
    await waitFor(() => expect(statValue('Open WOs')).toBe('4'));
    expect(statValue('Surveys')).toBe('0');
    expect(statValue('Codes')).toBe('0');

    // recent work orders, newest first, with a status badge
    const table = (await screen.findByText('AHU-03 vibration above threshold')).closest('table');
    expect(table).not.toBeNull();
    const row = screen.getByText('AHU-03 vibration above threshold').closest('tr');
    expect(within(row as HTMLElement).getByText('Open')).toHaveClass('badge', 'b-open');
    expect(within(row as HTMLElement).getByText('High')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('AHU-03')).toBeInTheDocument();

    // no surveys yet → the empty state, not a table
    expect(
      screen.getByText('No standpoints surveyed yet — capture one from the AR screen.'),
    ).toBeInTheDocument();
  });

  it('a survey written to KV lands in the stat and the table after an invalidate', async () => {
    mockMode();
    const { queryClient } = renderWithClient(<DashboardScreen />);
    await waitFor(() => expect(statValue('Surveys')).toBe('0'));

    await appStore.kvPut('surveys', 'survey.s-1', survey('s-1', { qrCode: 'facilio_sp1' }));
    await appStore.kvPut('surveys', 'survey.s-2', survey('s-2', { siteId: 1002 }));
    await queryClient.invalidateQueries({ queryKey: kvKey('surveys', 'survey.') });

    await waitFor(() => expect(statValue('Surveys')).toBe('2'));
    expect(await screen.findByText('Standpoint s-1')).toBeInTheDocument();

    // site id resolves to the site name, markers are counted, QR state badged
    const row = screen.getByText('Standpoint s-1').closest('tr') as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByText('Greenfield Business Park')).toBeInTheDocument(),
    );
    expect(within(row).getByText('1')).toBeInTheDocument();
    expect(within(row).getByText('Enrolled')).toHaveClass('badge', 'b-done');

    const row2 = screen.getByText('Standpoint s-2').closest('tr') as HTMLElement;
    expect(within(row2).getByText('No QR')).toHaveClass('badge', 'b-draft');
  });

  it('renders the captures table when capture.* rows exist', async () => {
    mockMode();
    await appStore.kvPut('surveys', 'capture.cap-x', {
      id: 'cap-x',
      siteId: 1001,
      spaceName: 'Server Room',
      photoFileId: 1,
      thumbFileId: 2,
      markers: [{ assetId: 3002, rect: { x: 0, y: 0, w: 1, h: 1 }, cropFileId: 3 }],
      createdAt: '2026-08-12T12:00:00Z',
      embeddingStatus: 'done',
    });
    renderWithClient(<DashboardScreen />);

    expect(await screen.findByText('cap-x')).toBeInTheDocument();
    const row = screen.getByText('cap-x').closest('tr') as HTMLElement;
    expect(within(row).getByText('Server Room')).toBeInTheDocument();
    expect(within(row).getByText('Indexed')).toHaveClass('badge', 'b-done');
  });
});

describe('SettingsScreen (mock mode)', () => {
  it('shows the session card and round-trips the app store', async () => {
    mockMode();
    const user = userEvent.setup();
    renderWithClient(<SettingsScreen />);

    expect(await screen.findByText('mock (?mock=1)')).toBeInTheDocument();
    expect(await screen.findByText('Mock User <mock@facilio.com>')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run KV round-trip' }));
    expect(await screen.findByText('OK — put, get, delete all round-tripped')).toBeInTheDocument();
  });

  it('saves a site geo row and reloads it on remount', async () => {
    mockMode();
    const user = userEvent.setup();
    const first = renderWithClient(<SettingsScreen />);

    const lat = await screen.findByLabelText('Latitude for Greenfield Business Park');
    const lng = screen.getByLabelText('Longitude for Greenfield Business Park');
    await user.type(lat, '12.97');
    await user.type(lng, '77.59');
    await user.click(screen.getByRole('button', { name: 'Save coordinates for Greenfield Business Park' }));

    await waitFor(async () => {
      const stored = await appStore.kvGet<SiteGeo>('settings', siteGeoKey(1001));
      expect(stored).toEqual({ siteId: 1001, lat: 12.97, lng: 77.59 });
    });

    // a fresh mount loads the stored value back into the fields
    first.unmount();
    renderWithClient(<SettingsScreen />);
    await waitFor(async () =>
      expect(await screen.findByLabelText('Latitude for Greenfield Business Park')).toHaveValue(
        12.97,
      ),
    );
    expect(screen.getByLabelText('Longitude for Greenfield Business Park')).toHaveValue(77.59);
  });

  it('groups stored embeddings by site bucket, read-only', async () => {
    mockMode();
    const vec = { q: 'AAA', s: 0.1, dim: 8, assetId: 3001, captureId: 'cap-x', markerIdx: 0, modelId: 'stub' };
    await appStore.kvPut('surveys', 'emb.1001.cap-x.0', vec);
    await appStore.kvPut('surveys', 'emb.1001.cap-x.1', { ...vec, markerIdx: 1 });
    await appStore.kvPut('surveys', 'emb.0.cap-y.0', { ...vec, captureId: 'cap-y' });
    renderWithClient(<SettingsScreen />);

    const card = (await screen.findByText('Recognition index')).closest('.kit-card') as HTMLElement;
    await waitFor(() =>
      expect(within(card).getByText('Greenfield Business Park')).toBeInTheDocument(),
    );
    expect(
      within(within(card).getByText('Greenfield Business Park').closest('tr') as HTMLElement)
        .getByText('2'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Unscoped (no site)')).toBeInTheDocument();
  });

  it('lists the four studio agents', async () => {
    mockMode();
    renderWithClient(<SettingsScreen />);
    for (const name of ['fv-identify', 'fv-wo-draft', 'fv-nameplate', 'fv-voice']) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
  });
});
