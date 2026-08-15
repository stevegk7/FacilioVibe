// Phase 1 acceptance: app loads, the dock renders, a deliberately thrown screen
// error shows a readable panel while the tab bar still works.
//
// The dock is 3D Estate · AR · Wayfinder since the merge. Surveys kept its screen
// and its authoring entry point but gave up its dock slot to the 3D estate, so it
// is now reached the same way every other non-dock screen is — by ?tab=.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';

function bootAt(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

describe('shell-smoke', () => {
  it('loads in mock mode and renders the dock', async () => {
    bootAt('?mock=1');

    // Auth gate resolves against the mock provider
    expect(await screen.findByRole('tab', { name: 'Vision' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '3D plan' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Wayfinder' })).toBeInTheDocument();

    // Non-dock screens stay out of the bar
    expect(screen.queryByRole('tab', { name: 'Surveys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Diagnostics' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Boom' })).not.toBeInTheDocument();

    // jsdom reports no desktop viewport, so the landing tab is AR — and it
    // renders with the camera ALREADY live. Camera-first: no tap required to see
    // through the lens.
    expect(await screen.findByRole('button', { name: 'AR on' })).toBeInTheDocument();
  });

  it('switches tabs and rewrites only the tab param', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1');

    await user.click(await screen.findByRole('tab', { name: 'Wayfinder' }));
    expect(await screen.findByRole('heading', { name: 'Wayfinder' })).toBeInTheDocument();

    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('wayfinder');
    expect(params.get('mock')).toBe('1'); // preserved
  });

  it('surveys keeps its screen and its authoring entry point off the dock', async () => {
    bootAt('?mock=1&tab=surveys');

    expect(await screen.findByRole('heading', { name: 'Surveys' })).toBeInTheDocument();
    // The gradient CTA that opens the AR survey overlay
    expect(await screen.findByRole('button', { name: 'New survey' })).toBeInTheDocument();
    // …and it joins the bar while it is the active screen
    expect(screen.getByRole('tab', { name: 'Surveys' })).toBeInTheDocument();
  });

  it('hidden screens join the bar when active via ?tab=', async () => {
    // Was ?tab=diagnostics (moved into Settings), then ?tab=rooms (withdrawn).
    // Portfolio is the surviving example of the case under test: hidden from
    // the dock, reachable by ?tab=, and joins the bar while active.
    bootAt('?mock=1&tab=portfolio');

    expect(await screen.findByRole('tab', { name: 'Portfolio' })).toBeInTheDocument();
    // Non-dock screens load in their own chunk now, so the heading arrives
    // after a Suspense fallback rather than on the same tick as the tab.
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeInTheDocument();
    // The dock tabs are still there alongside it
    expect(screen.getByRole('tab', { name: 'Vision' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Wayfinder' })).toBeInTheDocument();
  });

  it('a deliberately thrown screen error shows a readable panel while the tab bar still works', async () => {
    // React logs caught boundary errors loudly; keep the test output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    bootAt('?mock=1&tab=boom');

    // Readable panel, not a blank page
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent('The Boom screen crashed');
    expect(panel).toHaveTextContent('Deliberate crash from ?tab=boom');

    // Tab bar survived and still navigates
    await user.click(screen.getByRole('tab', { name: 'Wayfinder' }));
    expect(await screen.findByRole('heading', { name: 'Wayfinder' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    consoleError.mockRestore();
  });
});
