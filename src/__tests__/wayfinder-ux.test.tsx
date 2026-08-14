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
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocationProvider } from '../state/LocationContext';
import WayfinderScreen from '../screens/WayfinderScreen';
import { __resetDemoSeedForTest } from '../api/seedDemoData';
import { goToTab } from '../shell/router';
import {
  anchorAgeText,
  anchorIsStale,
  arrivalPhase,
  estimateSeconds,
  floorPhases,
  minutesText,
  progressForNode,
} from '../wayfinding/journey';
import { buildDemoDataset, MOCK_DEMO_IDS } from '../wayfinding/demoData';
import { withSurveyNodes } from '../wayfinding/graph';
import { findRoute } from '../wayfinding/router';
import { setOrientationForTest } from '../hooks/useHeading';
import { ACTIVE_KEY, type ActiveRound } from '../rounds/roundsStore';

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

/* The first route on this screen waits on more than the UI settling: the
   auto-graph query does `await import('../estate/buildEstate')` and then builds
   the estate and the graph. Vite serialises module transforms across workers, so
   that wait costs 427ms with this file alone and blows past the shared 5s
   `asyncUtilTimeout` when the whole suite runs in parallel — reproducibly, which
   is what distinguishes it from load flake. It gets its own budget rather than
   raising everyone's, since only a lazy module load is this slow. */
const ESTATE_BUILD_MS = 15_000;

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
    expect(
      await screen.findByText(/Cross the plaza to Tower A/, undefined, {
        timeout: ESTATE_BUILD_MS,
      }),
    ).toBeInTheDocument();
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
    // The question now lives in the conversation thread (spec: ambiguity is a
    // clarification message with the real options as chips), not a separate
    // "Did you mean" block.
    await user.type(screen.getByRole('textbox', { name: 'Destination' }), 'chiller{Enter}');
    const log = await screen.findByRole('log', { name: 'Navigation conversation' });
    expect(within(log).getByText(/which one do you need/i)).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: /Chiller CH-02/ }));

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
    expect(
      await screen.findByText(/Cross the plaza to Tower A/, undefined, {
        timeout: ESTATE_BUILD_MS,
      }),
    ).toBeInTheDocument();
    // Consumed: the param must not survive to re-fire on the next navigation.
    expect(new URLSearchParams(window.location.search).get('asset')).toBeNull();
  });
});

// Every case below is a defect an adversarial review found and confirmed
// against this branch. They are regression guards, not hypotheticals.
describe('wayfinder — confirmed regressions', () => {
  it('un-arrives when a scan moves you off the destination', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.type(screen.getByRole('textbox', { name: 'Destination' }), 'Primary Pump{Enter}');
    await screen.findByRole('button', { name: 'Guide me' });

    await scanCode(user, 'fv-sv-demo-plant');
    expect(await screen.findByText("You've arrived")).toBeInTheDocument();

    // Walking back to the lobby must not leave "You've arrived" on screen.
    await scanCode(user, 'fv-sv-demo-lobby');
    await waitFor(() => expect(screen.queryByText("You've arrived")).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Guide me' })).toBeInTheDocument();
  });

  it('drops a stale anchor that names a node this site has no longer', async () => {
    sessionStorage.setItem(
      'fv.wayfinder.anchor',
      JSON.stringify({ nodeId: 'sv:some-other-sites-standpoint', via: 'scan', at: Date.now() }),
    );
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });

    // Re-anchored by GPS to a node that exists, never left pointing at a ghost.
    expect(await screen.findByText('nearest entrance by GPS')).toBeInTheDocument();
  });

  it('keeps a work-order tap honest when no site is picked', async () => {
    const user = userEvent.setup();
    sessionStorage.removeItem('fv.location');
    renderScreen();

    const row = await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.click(row);
    // Silence used to make the row look dead; it now says which of the two
    // reasons applies.
    expect(await screen.findByText(/Pick a site first/)).toBeInTheDocument();
  });

  it('does not steal an ?asset param aimed at another tab', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });

    // A handoff to the 3D estate: the Wayfinder is still mounted for a commit
    // and hears the same popstate. It must leave the param alone.
    act(() => {
      goToTab('estate', { asset: 3007 });
    });
    expect(new URLSearchParams(window.location.search).get('asset')).toBe('3007');
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

/* Arrival is the one phase that can contradict reality, so its decision is a
   pure total function rather than two ifs in an effect. The bug these pin: both
   original branches required a route to EXIST, so `route === null` — the normal
   answer for a standpoint with no authored edges, i.e. every standpoint created
   in the AR tab — left the phase alone and kept "You've arrived" on screen at a
   place the asset is not, AR handoff and all. */
describe('arrivalPhase', () => {
  it('arrives only on a route with no steps left', () => {
    expect(arrivalPhase({ steps: [] }, 'guided')).toBe('arrived');
    expect(arrivalPhase({ steps: [] }, 'preview')).toBe('arrived');
  });

  it('UN-arrives when there is no route at all — the missed branch', () => {
    expect(arrivalPhase(null, 'arrived')).toBe('preview');
    expect(arrivalPhase(undefined, 'arrived')).toBe('preview');
  });

  it('un-arrives when steps remain', () => {
    expect(arrivalPhase({ steps: [1, 2] }, 'arrived')).toBe('preview');
  });

  it('leaves any non-arrived phase exactly as it found it', () => {
    expect(arrivalPhase(null, 'guided')).toBe('guided');
    expect(arrivalPhase(null, 'preview')).toBe('preview');
    expect(arrivalPhase({ steps: [1] }, 'guided')).toBe('guided');
  });
});

/* ---------------- facing ----------------
   The one thing a phone can genuinely add at a standpoint is which way to TURN:
   the failure there is rotational, not positional. These pin the refusals as
   hard as the happy path, because a confident arrow pointing the wrong way costs
   more trust than showing nothing — and most indoor edges have no bearing at all.

   Driven here rather than in a browser on purpose: the indicator polls the
   sensor on an interval, and a hidden/background tab throttles timers, which
   makes a live browser check unreliable in both directions. */
describe('facing indicator', () => {
  afterEach(() => setOrientationForTest(null));

  /** Entrance → lobby → … → plant room, then into guided mode on step 1. */
  async function guidedFirstStep(user: ReturnType<typeof userEvent.setup>) {
    renderScreen();
    await screen.findByRole('button', { name: /Quarterly UPS battery inspection/ });
    await user.type(screen.getByRole('textbox', { name: 'Destination' }), 'Primary Pump{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Guide me' }));
    await screen.findByText('Step 1 of 5');
  }

  /**
   * Turn the technician, then let the sensor poll land INSIDE act.
   *
   * useHeading samples on an interval rather than per event (a phrase and a
   * wedge do not need 60Hz), so a bare assertion races that tick. Waiting one
   * full period explicitly makes these deterministic instead of leaning on a
   * findBy timeout — which is what made them the first thing to fall over when
   * the machine was busy.
   */
  async function faceTowards(deg: number) {
    await act(async () => {
      setOrientationForTest(deg);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
  }

  it('shows which way to turn once the compass is north-referenced', async () => {
    const user = userEvent.setup();
    await guidedFirstStep(user);
    // Nothing before a compass exists — a desktop browser never sees this.
    expect(screen.queryByRole('img', { name: /Destination/ })).not.toBeInTheDocument();

    // Step 1 (entrance → lobby) is the only demo step with both ends geotagged;
    // its bearing is ~224°. Facing due south, that is slightly to the right.
    await faceTowards(180);
    expect(screen.getByRole('img', { name: 'Destination slightly right' })).toBeInTheDocument();
  });

  it('re-phrases as the technician turns', async () => {
    const user = userEvent.setup();
    await guidedFirstStep(user);

    await faceTowards(224);
    expect(screen.getByRole('img', { name: 'Destination straight ahead' })).toBeInTheDocument();

    await faceTowards(44);
    expect(screen.getByRole('img', { name: 'Destination behind you' })).toBeInTheDocument();
  });

  it('says nothing on a step with no bearing — most indoor edges', async () => {
    const user = userEvent.setup();
    await guidedFirstStep(user);
    await faceTowards(180);
    expect(screen.getByRole('img', { name: /Destination/ })).toBeInTheDocument();

    // Step 2 (lobby → lift) has no geotag on the lift, so no bearing exists.
    await user.click(screen.getByRole('button', { name: /I'm here — next/ }));
    await screen.findByText('Step 2 of 5');
    expect(screen.queryByRole('img', { name: /Destination/ })).not.toBeInTheDocument();
  });
});

/* ---------------- one tap from a work order ----------------
   The row that used to answer "Pick a site first — routes are per site", which
   was the app asking for something it already knew: the work order names its
   asset, and the portfolio graph knows which site that asset is in. */
describe('work order → route in one tap', () => {
  it('scopes itself to the asset’s site and routes, with nothing picked first', async () => {
    // No fv.location at all — the cold start the old copy sent people away from.
    sessionStorage.removeItem('fv.location');
    const user = userEvent.setup();
    renderScreen();

    const row = await screen.findByRole('button', { name: /AHU-03 vibration above threshold/ });
    await user.click(row);

    // A destination, not an instruction to go and configure something. Matched on
    // the thread's own prefix so this cannot pass on the row that was tapped.
    expect(await screen.findByText(/(Route|Destination) set — AHU-03/)).toBeInTheDocument();
    expect(screen.queryByText(/Pick a site first/)).not.toBeInTheDocument();

    // It scoped itself, which is what makes the AR-precise lane reachable at all.
    await waitFor(() => {
      const stored = JSON.parse(sessionStorage.getItem('fv.location') ?? '{}');
      expect(stored?.scope?.siteId).toBe(1001);
    });
  });

  it('routes to an asset nobody has pinned — the portfolio lane can reach it', async () => {
    sessionStorage.removeItem('fv.location');
    const user = userEvent.setup();
    renderScreen();

    // Conveyor M-114 is in the estate but is not pinned at any standpoint, so the
    // survey lane refuses it. It is still a perfectly routable record.
    const row = await screen.findByRole('button', { name: /Conveyor M-114 belt replacement/ });
    await user.click(row);

    await waitFor(() =>
      expect(screen.queryByText(/isn.t pinned in any survey/)).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText(/(Route|Destination) set — Conveyor Motor M-114/),
    ).toBeInTheDocument();
  });

  it('says WHY when the asset is not on any floor, and points at the readout', async () => {
    sessionStorage.removeItem('fv.location');
    const user = userEvent.setup();
    renderScreen();

    // Feed Pump P-07's space carries no floor, so the builder drops it and no
    // node exists. The old message blamed the AR tab, which cannot fix this.
    const row = await screen.findByRole('button', { name: /Pump P-07 seal leak/ });
    await user.click(row);

    const hint = await screen.findByText(/isn.t on any floor in the portfolio/);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toMatch(/Routing coverage/);
  });
});

/* ---------------- rounds ----------------
   A technician's real task is a ROUND, not one asset. roundsStore has modelled
   ordered stops from the start and the Wayfinder used exactly one function from
   it — so scanning proved a stop and then nothing pointed at the next one. */
describe('round in progress', () => {
  /** Lobby → plant room, nothing stamped yet. */
  function startRound(stops = ['demo-lobby', 'demo-plant']) {
    const active: ActiveRound = {
      roundId: 'r1',
      roundName: 'Morning checks',
      startedAt: '2026-08-15T07:00:00.000Z',
      stops: stops.map((surveyId) => ({ surveyId })),
    };
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
  }

  it('names the round and the stop you are on', async () => {
    startRound();
    renderScreen();

    expect(await screen.findByText('Morning checks')).toBeInTheDocument();
    expect(screen.getByText('Stop 1 of 2')).toBeInTheDocument();
    // Named from the survey itself, whatever the fixture calls it.
    expect(document.querySelector('.wf-round-stop')?.textContent).toMatch(/\S/);
  });

  it('routes to the stop in one tap', async () => {
    startRound();
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Route to it/ }));
    // A real route to the standpoint, not just a label change.
    expect(await screen.findByRole('button', { name: 'Guide me' })).toBeInTheDocument();
  });

  it('routes from a cold start, where the tap must scope the site first', async () => {
    startRound();
    // Nothing scoped — the state the app opens in before a site is picked, and
    // the one where this tap used to scope the site and then set no route: the
    // early return leaned on the follow-round effect, which only runs while a
    // scan is driving the round.
    sessionStorage.removeItem('fv.location');
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Route to it/ }));
    expect(
      await screen.findByRole('button', { name: 'Guide me' }, { timeout: ESTATE_BUILD_MS }),
    ).toBeInTheDocument();
  });

  it('advances to the NEXT stop when a scan proves the one you were routing to', async () => {
    startRound();
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Route to it/ }));
    await screen.findByRole('button', { name: 'Guide me' });

    // Scanning the lobby stamps stop 1; the round moves on and so does the route.
    await scanCode(user, 'fv-sv-demo-lobby');
    expect(await screen.findByText('Stop 2 of 2')).toBeInTheDocument();
    expect(await screen.findByText(/Stop 2 of 2 — .*Route set/)).toBeInTheDocument();
  });

  it('a scan somewhere else re-anchors without hijacking the destination', async () => {
    startRound();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText('Stop 1 of 2');

    // Not routing to anything yet — a stray scan must not retarget the round.
    await scanCode(user, 'fv-sv-demo-server');
    expect(await screen.findByText(/You are at/)).toBeInTheDocument();
    expect(screen.getByText('Stop 1 of 2')).toBeInTheDocument();
  });

  it('says the round is done rather than showing a phantom stop', async () => {
    const active: ActiveRound = {
      roundId: 'r1',
      roundName: 'Morning checks',
      startedAt: '2026-08-15T07:00:00.000Z',
      stops: [{ surveyId: 'demo-lobby', via: 'qr', at: '2026-08-15T07:05:00.000Z' }],
    };
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    renderScreen();

    expect(await screen.findByText('All stops done')).toBeInTheDocument();
  });

  it('still counts a stop whose standpoint was deleted, rather than shortening the round', async () => {
    startRound(['demo-lobby', 'survey-that-was-deleted']);
    renderScreen();
    await screen.findByText('Stop 1 of 2');

    // Stamp the first so the deleted one becomes current.
    const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) as string) as ActiveRound;
    active.stops[0].via = 'qr';
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));

    cleanup();
    renderScreen();
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Route to it/ })).toBeDisabled();
  });
});
