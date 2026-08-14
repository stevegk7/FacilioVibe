// The admin half of landmark authoring. The Wayfinder lets whoever is standing
// in the corridor write the sentence; this is where a wrong one gets corrected
// without having to route to it first.
//
// What these pin, in order of how much they would cost to get wrong:
//  - a note whose edge no longer exists is SHOWN and labelled, not hidden — the
//    overlay deliberately keeps it (the estate may grow the edge back), so an
//    admin has to be able to see and clear it
//  - clearing the text removes the note, because that is the only remove path
//  - a stale version is refused rather than silently clobbering another author
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { appStore } from '../api/appStore';
import { loadOverlay } from '../wayfinding/autoGraphStore';
import SettingsScreen from '../screens/SettingsScreen';

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const LIVE = 'Past the meter cupboard, second door on the right';
const ORPHAN = 'Past the old plant room';

async function seed() {
  window.history.replaceState({}, '', '/?mock=1');
  await appStore.kvPut('settings', 'wf.autograph.1001', {
    addEdges: [],
    removeEdgeIds: [],
    version: 3,
    edgeNotes: {
      // A real derived edge in the mock estate.
      'asset:3009--space:2008': { instruction: LIVE, at: '2026-08-14T19:23:19.394Z', by: 'tech@facilio.com' },
      // An edge the current estate no longer produces.
      'edge:that:vanished': { instruction: ORPHAN, at: '2026-08-14T19:00:00.000Z' },
    },
  });
}

/** The card is collapsed by default so opening Settings never builds the estate. */
async function openCard(user: ReturnType<typeof userEvent.setup>) {
  renderWithClient(<SettingsScreen />);
  const card = (await screen.findByText('Route landmarks')).closest('.kit-card') as HTMLElement;
  await user.click(within(card).getByRole('button', { name: 'Show' }));
  return card;
}

describe('Settings — route landmarks', () => {
  it('is collapsed until asked, so opening Settings does not build the estate', async () => {
    await seed();
    renderWithClient(<SettingsScreen />);
    expect(await screen.findByText('Route landmarks')).toBeInTheDocument();
    expect(screen.queryByText(LIVE)).not.toBeInTheDocument();
  });

  it('lists every site’s landmarks in one read', async () => {
    await seed();
    const user = userEvent.setup();
    await openCard(user);

    expect(await screen.findByText(LIVE)).toBeInTheDocument();
    // The orphan is shown too — the overlay keeps it on purpose, so it has to be
    // visible to be clearable.
    expect(screen.getByText(ORPHAN)).toBeInTheDocument();
  });

  it('edits a landmark and writes it back', async () => {
    await seed();
    const user = userEvent.setup();
    await openCard(user);

    await user.click(await screen.findByText(LIVE));
    const box = screen.getByRole('textbox', { name: /Landmark for/ });
    await user.clear(box);
    await user.type(box, 'Through the double doors, then left');
    await user.tab(); // blur commits

    await waitFor(async () => {
      const stored = await loadOverlay(1001);
      expect(stored?.edgeNotes['asset:3009--space:2008'].instruction).toBe(
        'Through the double doors, then left',
      );
    });
    // The version moved, which is what makes a concurrent edit detectable.
    expect((await loadOverlay(1001))?.version).toBe(4);
  });

  it('clearing the text removes the landmark — the only remove path there is', async () => {
    await seed();
    const user = userEvent.setup();
    await openCard(user);

    await user.click(await screen.findByText(ORPHAN));
    await user.clear(screen.getByRole('textbox', { name: /Landmark for/ }));
    await user.tab();

    await waitFor(async () => {
      const stored = await loadOverlay(1001);
      expect(stored?.edgeNotes['edge:that:vanished']).toBeUndefined();
    });
    // The other note is untouched.
    expect((await loadOverlay(1001))?.edgeNotes['asset:3009--space:2008']).toBeDefined();
  });

  it('refuses a write against a version someone else has moved on from', async () => {
    await seed();
    const user = userEvent.setup();
    await openCard(user);
    await screen.findByText(LIVE);

    // Another author saves while this card is open, bumping the version.
    await appStore.kvPut('settings', 'wf.autograph.1001', {
      addEdges: [],
      removeEdgeIds: [],
      version: 9,
      edgeNotes: { 'asset:3009--space:2008': { instruction: 'Theirs', at: '2026-08-14T20:00:00.000Z' } },
    });

    await user.click(screen.getByText(LIVE));
    const box = screen.getByRole('textbox', { name: /Landmark for/ });
    await user.clear(box);
    await user.type(box, 'Mine');
    await user.tab();

    expect(await screen.findByText(/Someone else changed/)).toBeInTheDocument();
    // Theirs survives — the whole point of the check.
    expect((await loadOverlay(1001))?.edgeNotes['asset:3009--space:2008'].instruction).toBe('Theirs');
  });
});
