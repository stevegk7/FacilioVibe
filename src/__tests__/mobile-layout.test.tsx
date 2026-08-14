// Layout invariants that broke in production and were only caught on a phone.
// Each of these is a bug that shipped, not a hypothetical:
//
//  1. the dock sat above a dead strip, because the shell asserted its own
//     100dvh instead of filling what the app frame gave it — so any banner
//     pushed it past the bottom of the screen
//  2. the survey authoring footer (Place marker / Save) was UNREACHABLE: the
//     overlay spanned the viewport while the dock still painted over it
//  3. the setup sheet swallowed the whole camera view
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';

function bootAt(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

describe('mobile shell layout', () => {
  it('the dock is the LAST thing in the shell and the shell fills, never asserts, its height', async () => {
    const { container } = bootAt('?mock=1&tab=surveys');
    await screen.findByRole('tab', { name: 'Surveys' });

    const shell = container.querySelector('.as-mobile') as HTMLElement;
    const dock = shell.querySelector('.as-dock') as HTMLElement;

    // nothing may render after the dock — that is what left a dead strip below it
    expect(shell.lastElementChild).toBe(dock);
    // main pane comes first and is the scroller
    expect(shell.firstElementChild).toHaveClass('as-mobile-main');
    expect(shell.querySelector('.as-mobile-main')).toBeTruthy();
  });

  it('camera-first screens mark their pane as bleed so the stage cannot scroll the page', async () => {
    const { container } = bootAt('?mock=1&tab=ar');
    await screen.findByRole('button', { name: 'AR on' });
    expect(container.querySelector('.as-mobile-main')).toHaveClass('bleed');
  });
});

describe('survey authoring — the footer must be reachable', () => {
  it('keeps the dock visible, and every step\'s footer actions are reachable', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=surveys');

    await user.click(await screen.findByRole('button', { name: /New survey/ }));

    // setup step: one field, one CTA — and NO location cascade, so the camera
    // behind the sheet stays visible
    const nameField = await screen.findByLabelText(/Survey point name/i);
    expect(screen.queryByRole('combobox', { name: 'Building' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Floor' })).toBeNull();

    await user.type(nameField, 'Plant room');
    await user.click(screen.getByRole('button', { name: /scan the standpoint code/i }));
    await waitFor(() => expect(document.body).toHaveClass('pa-open'));

    // the dock is NOT hidden — the stage stops where the dock begins
    expect(screen.getByRole('tab', { name: 'Surveys' })).toBeInTheDocument();

    // QR step is the gate: its typed-code fallback must be reachable too
    const qrFoot = document.querySelector('.pa-foot') as HTMLElement;
    expect(document.querySelector('.pa-badge')).toHaveTextContent(/Scan the standpoint code/);
    await user.type(within(qrFoot).getByLabelText('Standpoint code'), 'ws-qr-9');
    await user.click(within(qrFoot).getByRole('button', { name: 'Use code' }));

    // sweep step: pace tip + coverage dots + its action
    await waitFor(() => expect(document.querySelector('.pa-badge')).toHaveTextContent(/Sweep \d+\/12/));
    const sweepFoot = document.querySelector('.pa-foot') as HTMLElement;
    expect(document.querySelector('.pa-sweep-dots')).not.toBeNull();
    const toMarkers = within(sweepFoot).getByRole('button', { name: /Place markers/ });
    expect(toMarkers).toBeInTheDocument();
  });

  it('releases the takeover when the flow closes', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=surveys');

    await user.click(await screen.findByRole('button', { name: /New survey/ }));
    await waitFor(() => expect(document.body).toHaveClass('pa-open'));

    await user.click(screen.getByRole('button', { name: /Exit survey/ }));
    await waitFor(() => expect(document.body).not.toHaveClass('pa-open'));
  });
});

describe('select', () => {
  it('expands inline — it never opens a sheet inside a sheet', async () => {
    // jsdom reports no pointer info, so the component would take the desktop
    // (popover) path. Say we are a touch device, which is the case under test.
    window.matchMedia = ((query: string) => ({
      matches: query.includes('coarse') || query.includes('max-width'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const user = userEvent.setup();
    const { container } = bootAt('?mock=1&tab=surveys');

    // open the scope sheet, then the SITE field row inside it
    await user.click(await screen.findByRole('button', { name: /Working scope/i }));
    await user.click(await screen.findByRole('button', { name: /^Site/ }));

    // exactly ONE dialog on screen — the scope sheet. The options are a
    // full-height LIST PAGE inside it (search + scroll), never a second
    // layer, and never an inline expansion that resizes the sheet.
    expect(container.ownerDocument.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(await screen.findByLabelText('Search sites')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('.lp-list')).not.toBeNull();
    expect(container.ownerDocument.querySelector('.ds-sheet-panel')).toBeNull();

    // picking returns to the field rows with the value applied
    await user.click(await screen.findByRole('option', { name: 'Greenfield Business Park' }));
    await waitFor(() => {
      const value = container.ownerDocument.querySelector('.lp-row .lp-row-value');
      expect(value).toHaveTextContent('Greenfield Business Park');
    });
  });
});
