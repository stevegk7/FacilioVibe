// A work order tapped BEFORE the portfolio graph has loaded.
//
// This window is real and it is the common one: the open-WO list is one cheap
// read, while the portfolio graph needs the whole estate plus a lazily imported
// builder. So the list paints first, the technician taps the job they came for,
// and on a cold start over a field connection the graph is not there yet.
//
// The screen used to answer "Still reading the portfolio — try again in a
// moment" and DROP the tap, handing the retry back to the person for a wait it
// could see the end of. It surfaced as a suite failure that only appeared under
// parallel load, which is exactly how a user meets it: not always, and never
// when you are looking.
//
// The delay below is deliberate, not incidental — it holds the module import
// open so the tap is guaranteed to land inside the window rather than racing it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationProvider } from '../state/LocationContext';
import WayfinderScreen from '../screens/WayfinderScreen';
import { __resetDemoSeedForTest } from '../api/seedDemoData';

const IMPORT_DELAY_MS = 1_500;

// The component does `await import('../estate/buildEstate')`. Vitest calls this
// factory on that first import, so awaiting here delays the graph itself — the
// real shape of a slow connection, without touching the builder's behaviour.
vi.mock('../estate/buildEstate', async () => {
  const actual =
    await vi.importActual<typeof import('../estate/buildEstate')>('../estate/buildEstate');
  await new Promise((resolve) => setTimeout(resolve, IMPORT_DELAY_MS));
  return actual;
});

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocationProvider>
        <WayfinderScreen />
      </LocationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?mock=1&tab=wayfinder');
  localStorage.clear();
  sessionStorage.clear();
  __resetDemoSeedForTest();
  sessionStorage.setItem(
    'fv.location',
    JSON.stringify({ scope: { siteId: 1001 }, names: { site: 'Greenfield Business Park' } }),
  );
});

describe('wayfinder — a work-order tap that beats the portfolio', () => {
  it('holds the tap and routes when the graph lands, instead of asking for a retry', async () => {
    const user = userEvent.setup();
    renderScreen();

    // The list is up well before the graph — that is the whole point.
    const woRow = await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.click(woRow);

    // The tap is acknowledged as WAITING, never bounced back as the user's job.
    expect(await screen.findByText(/will route as soon as it lands/)).toBeInTheDocument();
    expect(screen.queryByText(/try again in a moment/)).not.toBeInTheDocument();

    // And it completes on its own once the portfolio arrives.
    expect(
      await screen.findByText(/Cross the plaza to Tower A/, undefined, {
        timeout: IMPORT_DELAY_MS + 8_000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will route as soon as it lands/)).not.toBeInTheDocument();
  });
});
