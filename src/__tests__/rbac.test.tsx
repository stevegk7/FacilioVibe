// Role-based access, end to end through the real app.
//
// These boot App itself rather than a screen, because the two things most worth
// proving are properties of the whole: that a technician cannot reach an
// admin-only screen by TYPING its id into the URL, and that the work-order
// filtering happens in the data layer where every screen inherits it.
//
// ?role= is honoured in mock mode only (SessionContext), which is what makes
// both roles testable without the real accounts.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { mockProvider } from '../api/mockProvider';
import { setSessionScope } from '../api/scope';

function bootAs(role: 'admin' | 'technician', tab = '') {
  window.history.replaceState({}, '', `/?mock=1&role=${role}${tab ? `&tab=${tab}` : ''}`);
  return render(<App />);
}

describe('navigation is role-aware', () => {
  // Rounds and Capture were withdrawn from the product, and Diagnostics moved
  // inside Settings — so none of the three is a screen any more, for anyone.
  it.each(['diagnostics', 'rounds', 'capture'])(
    'does not resolve ?tab=%s for anyone — the modules are gone, not hidden',
    async (tab) => {
      bootAs('admin', tab);

      // The app boots and falls back rather than erroring…
      expect(await screen.findByRole('tab', { name: 'AR' })).toBeInTheDocument();
      // …and the withdrawn module is nowhere, even for an admin.
      expect(screen.queryByRole('tab', { name: /diagnostics|rounds|capture/i })).toBeNull();
    },
  );

  it('keeps Diagnostics reachable for an admin inside Settings', async () => {
    bootAs('admin', 'settings');

    expect(await screen.findByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
  });

  it('gives a technician no Diagnostics at all, since Settings itself is reduced', async () => {
    bootAs('technician', 'settings');

    expect(await screen.findByText(/managed by your CAFM administrator/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Diagnostics' })).not.toBeInTheDocument(),
    );
  });

  it('shows a technician only their own settings', async () => {
    bootAs('technician', 'settings');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByText(/managed by your CAFM administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Administrators' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Danger zone' })).not.toBeInTheDocument();
  });

  it('lets an admin manage who the administrators are', async () => {
    bootAs('admin', 'settings');

    expect(await screen.findByRole('heading', { name: 'Administrators' })).toBeInTheDocument();
  });
});

describe('the data layer scopes work, not the screens', () => {
  // Fixtures: 4001 and 4003 belong to the mock user (uid 1), 4002 and 4005 to
  // other people, 4004 to nobody.
  it('returns a technician only the work assigned to them', async () => {
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });

    const page = await mockProvider.listWorkOrders({ pageSize: 50 });
    expect(page.data.map((wo) => wo.id).sort()).toEqual([4001, 4003]);
  });

  it('returns an admin everything', async () => {
    setSessionScope({ role: 'admin', uid: 1, email: 'admin@facilio.com' });

    const page = await mockProvider.listWorkOrders({ pageSize: 50 });
    expect(page.data).toHaveLength(5);
  });

  it('refuses a technician a direct read of someone else’s work order', async () => {
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });

    expect(await mockProvider.getWorkOrder(4001)).not.toBeNull();
    // 4002 is Arun's. Reading it by id is the URL-manipulation case.
    expect(await mockProvider.getWorkOrder(4002)).toBeNull();
  });

  it('narrows assets and their buildings to the work the technician holds', async () => {
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });

    const assets = await mockProvider.searchAssets({});
    const ids = assets.map((a) => a.id).sort();
    // 3001 (WO 4001) and 3003 (WO 4003) — not 3002, which is Arun's.
    expect(ids).toEqual([3001, 3003]);
    expect(ids).not.toContain(3002);

    // And the estate narrows with them, rather than showing the whole portfolio.
    const admin = await (async () => {
      setSessionScope({ role: 'admin' });
      return mockProvider.listBuildings();
    })();
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });
    const mine = await mockProvider.listBuildings();
    expect(mine.length).toBeLessThan(admin.length);
  });

  it('gives a technician with no assigned work an empty world, never the org', async () => {
    setSessionScope({ role: 'technician', uid: 999, employeeId: 999, email: 'nobody@facilio.com' });

    expect((await mockProvider.listWorkOrders({ pageSize: 50 })).data).toEqual([]);
    expect(await mockProvider.searchAssets({})).toEqual([]);
    expect(await mockProvider.listBuildings()).toEqual([]);
  });
});
