// The rebuilt Wayfinder's UX contract, exercised over the auto-seeded mock
// demo dataset (src/wayfinding/demoData.ts — the same walk the live org
// carries). What is being pinned:
//  - the journey state machine: preview by default, guided opt-in, arrival as
//    a distinct state, steps NEVER advancing on their own
//  - honest positioning: GPS auto-anchors to the entrance and SAYS so; a scan
//    re-anchors quietly (off-route = re-anchor, never an alarm)
//  - grounded destination resolution: names route instantly, ambiguity is
//    tap-chips, work orders are destinations
//  - the ?asset= handoff consumed WHILE MOUNTED (the pre-rebuild staleness bug)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocationProvider } from '../state/LocationContext';
import WayfinderScreen from '../screens/WayfinderScreen';
import { __resetDemoSeedForTest } from '../api/seedDemoData';
import { goToTab } from '../shell/router';
import {
  anchorAgeText,
  anchorIsStale,
  estimateSeconds,
  floorPhases,
  minutesText,
  progressForNode,
} from '../wayfinding/journey';
import { buildDemoDataset, MOCK_DEMO_IDS } from '../wayfinding/demoData';
import { withSurveyNodes } from '../wayfinding/graph';
import { findRoute } from '../wayfinding/router';

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
  // Scope to the demo site the way LocationContext persists it.
  sessionStorage.setItem(
    'fv.location',
    JSON.stringify({ scope: { siteId: 1001 }, names: { site: 'Greenfield Business Park' } }),
  );
});

/** Type a code into the scan sheet (mock mode has no camera — typed lane). */
async function scanCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.click(screen.getAllByRole('button', { name: /Scan/ })[0]);
  await user.type(await screen.findByPlaceholderText(/fv-sv-demo-lobby/), code);
  await user.click(screen.getByRole('button', { name: 'Use typed code' }));
}

describe('wayfinder — demo data and destination resolution', () => {
  it('auto-seeds demo data, GPS-anchors to the entrance, and routes a work order', async () => {
    const user = userEvent.setup();
    renderScreen();

    // The open-WO list is the cold entry. UPS-A2's inspection is routable —
    // its asset is pinned at the demo server-room standpoint.
    const woRow = await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.click(woRow);

    // Mock GPS supplies a fix, so the anchor is the entrance — LABELLED as
    // the guess it is, never dressed up as a scan.
    expect(await screen.findByText('nearest entrance by GPS')).toBeInTheDocument();
    expect(await screen.findByText(/Cross the plaza to Tower A/)).toBeInTheDocument();
    // Preview shows totals and the guided-mode opt-in.
    expect(screen.getByRole('button', { name: 'Guide me' })).toBeInTheDocument();
    expect(screen.getByText(/~\d+ min/)).toBeInTheDocument();

    // A scan re-anchors quietly — no alarm, just the updated route.
    await scanCode(user, 'fv-sv-demo-lobby');
    expect(await screen.findByText(/Route updated from Tower B — Reception/)).toBeInTheDocument();
    expect(screen.getByText('scanned just now')).toBeInTheDocument();
  });

  it('resolves a typed name; ambiguity becomes tap chips; the route is set on pick', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });

    // Two chillers exist in the mock org — the resolver must ASK, not guess.
    await user.type(screen.getByRole('textbox', { name: 'Destination' }), 'chiller{Enter}');
    const chips = await screen.findByRole('group', { name: 'Did you mean' });
    await user.click(within(chips).getByRole('button', { name: /Chiller CH-02/ }));

    // The multi-floor route to the plant room: landmark walk, lift
    // interstitial, fire door, yellow line — in order, from the entrance.
    expect(await screen.findByText(/green feature wall/)).toBeInTheDocument();
    expect(screen.getByText(/Take the lift to/)).toBeInTheDocument();
    expect(screen.getByText(/fire door marked 'Plant'/)).toBeInTheDocument();
    expect(screen.getByText(/yellow floor line past the fire-hose cabinet/)).toBeInTheDocument();
  });
});

describe('wayfinder — guided mode and arrival', () => {
  /** Entrance → lobby → lift → landing → plant room: 5 steps. */
  async function toPlantRoomPreview(user: ReturnType<typeof userEvent.setup>) {
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.type(screen.getByRole('textbox', { name: 'Destination' }), 'Primary Pump{Enter}');
    await screen.findByRole('button', { name: 'Guide me' });
  }

  it('guides step by step, advancing ONLY on the tap, and arrives distinctly', async () => {
    const user = userEvent.setup();
    await toPlantRoomPreview(user);

    await user.click(screen.getByRole('button', { name: 'Guide me' }));
    expect(await screen.findByText('Step 1 of 5')).toBeInTheDocument();
    expect(screen.getByText(/Through the glass doors/)).toBeInTheDocument();
    // The next-step preview keeps people walking (dual-instruction pattern).
    expect(screen.getByText('Then')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /I'm here — next/ }));
    expect(await screen.findByText('Step 2 of 5')).toBeInTheDocument();
    expect(screen.getByText(/green feature wall/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /I'm here — next/ }));
    // The floor change is an interstitial: badge AND step text both say lift.
    expect((await screen.findAllByText(/Take the lift/)).length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole('button', { name: /I'm here — next/ }));
    await user.click(screen.getByRole('button', { name: /I'm here — next/ }));
    await user.click(screen.getByRole('button', { name: /I'm here — arrived/ }));

    // Arrival is a state with the AR handoff, not just an empty list.
    expect(await screen.findByText("You've arrived")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open AR/ })).toBeInTheDocument();
  });

  it('a mid-route scan re-anchors quietly and snaps progress', async () => {
    const user = userEvent.setup();
    await toPlantRoomPreview(user);
    await user.click(screen.getByRole('button', { name: 'Guide me' }));
    await screen.findByText('Step 1 of 5');

    // Scanning the mechanical-floor landing — four steps of progress proved
    // by one code, no alarm, just "route updated".
    await scanCode(user, 'fv-sv-demo-landing');
    expect(
      await screen.findByText(/Route updated from Mechanical Floor — Lift Landing/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Step 1 of 1')).toBeInTheDocument();
    expect(screen.getByText(/yellow floor line/)).toBeInTheDocument();
  });

  it('scanning the DESTINATION code is arrival, from any journey phase', async () => {
    const user = userEvent.setup();
    await toPlantRoomPreview(user);
    await scanCode(user, 'fv-sv-demo-plant');
    expect(await screen.findByText("You've arrived")).toBeInTheDocument();
  });
});

describe('wayfinder — handoffs land while mounted', () => {
  it('consumes ?asset pushed at an ALREADY-OPEN wayfinder (the staleness bug)', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });

    act(() => {
      goToTab('wayfinder', { asset: 3002 });
    });

    // Destination set without a remount — the route renders in place.
    expect(await screen.findByText(/Cross the plaza to Tower A/)).toBeInTheDocument();
    // Consumed: the param must not survive to re-fire on the next navigation.
    expect(new URLSearchParams(window.location.search).get('asset')).toBeNull();
  });
});

describe('journey model (pure)', () => {
  const dataset = buildDemoDataset(MOCK_DEMO_IDS);
  const graph = withSurveyNodes(dataset.graph, dataset.surveys);
  const route = findRoute(graph, 'sv:demo-lobby', 'sv:demo-plant')!;

  it('routes via the lift (honest metres beat kind-default costs) with landmarks', () => {
    expect(route.steps.map((s) => s.edge.kind)).toEqual(['walk', 'lift', 'door', 'walk']);
    expect(route.steps[0].text).toMatch(/green feature wall/);
  });

  it('estimates walking time conservatively, lifts costing their wait', () => {
    const seconds = estimateSeconds(route.steps);
    expect(seconds).toBeGreaterThan(60);
    expect(seconds).toBeLessThan(180);
    expect(minutesText(seconds)).toMatch(/^~\d+ min$/);
  });

  it('groups steps into floor phases; walking within a floor keeps the phase', () => {
    const phases = floorPhases(route.steps);
    expect(phases[0].label).toBe('Level 1');
    expect(phases[phases.length - 1].label).toBe('Level 2');
  });

  it('progressForNode: start, en-route, destination, off-route', () => {
    expect(progressForNode(route, 'sv:demo-lobby', 'sv:demo-lobby')).toBe(0);
    expect(progressForNode(route, 'sv:demo-lobby', 'sv:demo-mech-landing')).toBe(3);
    expect(progressForNode(route, 'sv:demo-lobby', 'sv:demo-plant')).toBe(route.steps.length);
    expect(progressForNode(route, 'sv:demo-lobby', 'n-demo-stairs-g')).toBeNull();
  });

  it('anchors age honestly and go stale after five minutes', () => {
    const now = Date.now();
    const scan = { nodeId: 'x', via: 'scan' as const, at: now - 2 * 60_000 };
    expect(anchorAgeText(scan, now)).toBe('scanned 2 min ago');
    expect(anchorIsStale(scan, now)).toBe(false);
    expect(anchorIsStale({ ...scan, at: now - 6 * 60_000 }, now)).toBe(true);
    expect(anchorAgeText({ nodeId: 'x', via: 'gps', at: now }, now)).toBe('nearest entrance by GPS');
  });
});
