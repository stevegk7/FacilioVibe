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
      expect(await screen.findByRole('tab', { name: 'Vision' })).toBeInTheDocument();
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

  /**
   * Sites were the one level of the tree that did not narrow — and the one the
   * user meets FIRST, in the picker every screen is scoped by. A technician was
   * offered every site in the org, and choosing one their work never reaches
   * showed an empty building list underneath: the app naming a place it had
   * already decided not to show them.
   */
  it('narrows SITES too — the level the picker offers first', async () => {
    setSessionScope({ role: 'admin' });
    const all = (await mockProvider.listSites({ pageSize: 50 })).data;
    expect(all.length).toBeGreaterThan(1); // the fixture must be able to show a difference

    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });
    const mine = (await mockProvider.listSites({ pageSize: 50 })).data;
    expect(mine.length).toBeLessThan(all.length);

    // Every site offered must be one the technician's own buildings sit in —
    // no site may be listed that has nothing they can reach beneath it.
    const buildings = await mockProvider.listBuildings();
    const reachable = new Set(buildings.map((b) => b.siteId));
    for (const site of mine) expect(reachable.has(site.id)).toBe(true);
  });

  /**
   * The 3D estate is a SECOND read path with its own payload, and it was
   * narrowing four levels while spreading sites through untouched — the same
   * omission as the picker, in a place the picker's test could not see.
   */
  it('narrows the estate payload at every level, sites included', async () => {
    setSessionScope({ role: 'technician', uid: 1, employeeId: 1, email: 'mock@facilio.com' });
    const estate = await mockProvider.loadEstate();

    // Sites must not outrun the buildings beneath them.
    const siteOf = new Set(estate.buildings.map((b) => (b.site as { id?: number } | null)?.id));
    for (const site of estate.sites) expect(siteOf.has(Number(site.id))).toBe(true);

    setSessionScope({ role: 'admin' });
    const all = await mockProvider.loadEstate();
    expect(estate.sites.length).toBeLessThan(all.sites.length);
  });

  it('gives a technician with no assigned work an empty world, never the org', async () => {
    setSessionScope({ role: 'technician', uid: 999, employeeId: 999, email: 'nobody@facilio.com' });

    expect((await mockProvider.listWorkOrders({ pageSize: 50 })).data).toEqual([]);
    expect(await mockProvider.searchAssets({})).toEqual([]);
    expect(await mockProvider.listBuildings()).toEqual([]);
    expect((await mockProvider.listSites({ pageSize: 50 })).data).toEqual([]);
    // …including the estate's own payload, which is a separate read path.
    expect((await mockProvider.loadEstate()).sites).toEqual([]);
  });
});
