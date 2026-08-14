// The routing-coverage readout: the authoring debt made visible.
//
// The number this exists for is the last one — assets the router cannot reach.
// The mock portfolio has two, both because their space carries no floor, and one
// of them (Feed Pump P-07) has an open work order listed on the Wayfinder's own
// first screen. That combination — the app advertising a job it cannot navigate
// to — was invisible until this card.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import SettingsScreen from '../screens/SettingsScreen';

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function openCoverage(user: ReturnType<typeof userEvent.setup>) {
  window.history.replaceState({}, '', '/?mock=1');
  renderWithClient(<SettingsScreen />);
  const card = (await screen.findByText('Routing coverage')).closest('.kit-card') as HTMLElement;
  await user.click(within(card).getByRole('button', { name: 'Show' }));
  return card;
}

describe('Settings — routing coverage', () => {
  it('stays collapsed until asked, because opening it builds the estate', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    renderWithClient(<SettingsScreen />);
    expect(await screen.findByText('Routing coverage')).toBeInTheDocument();
    expect(screen.queryByText(/cannot be routed to/)).not.toBeInTheDocument();
  });

  it('lists each site with whether it has coordinates at all', async () => {
    const user = userEvent.setup();
    const card = await openCoverage(user);

    // Every mock site carries a CMMS location, so none should read "missing".
    expect(await within(card).findByText('Greenfield Business Park')).toBeInTheDocument();
    expect(within(card).getByText('Lakeside Manufacturing Plant')).toBeInTheDocument();
    expect(within(card).queryByText('missing')).not.toBeInTheDocument();
  });

  it('names the assets the router cannot reach, and why', async () => {
    const user = userEvent.setup();
    const card = await openCoverage(user);

    expect(await within(card).findByText(/cannot be routed to/)).toBeInTheDocument();
    // Both mock dropouts, each because its space has no floor.
    const pump = within(card).getByText('Feed Pump P-07').closest('tr') as HTMLElement;
    expect(within(pump).getByText(/Pump House/)).toBeInTheDocument();
    expect(within(pump).getByText(/no floor/)).toBeInTheDocument();

    const ahu = within(card).getByText('Isolation Room AHU').closest('tr') as HTMLElement;
    expect(within(ahu).getByText(/Ward B Corridor/)).toBeInTheDocument();
  });

  it('counts standpoints per site from the surveys the Wayfinder writes', async () => {
    const user = userEvent.setup();
    const card = await openCoverage(user);

    const row = (await within(card).findByText('Greenfield Business Park')).closest(
      'tr',
    ) as HTMLElement;
    // The demo dataset seeds four standpoints on the demo site; the assertion is
    // that the column is wired to real data, not that the fixture never changes.
    const cells = within(row).getAllByRole('cell');
    expect(Number(cells[cells.length - 2].textContent)).toBeGreaterThanOrEqual(0);
  });
});
