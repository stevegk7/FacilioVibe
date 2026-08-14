// portfolio-smoke acceptance (Phase 2): pick a location, list assets, open
// one, see its work orders, tick a task, change a status; then RELOAD and
// repeat. Mock mode throughout.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';

function bootAt(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

// Native-picker interaction: tap the field ROW, pick from the list page.
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${label}`) }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('portfolio (mock mode)', () => {
  it('scopes assets to the picked site, including assets parented directly to it', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=portfolio');

    // Unscoped: all fixtures visible
    expect(await screen.findByText('Conveyor Motor M-114')).toBeInTheDocument();

    await pick(user, 'Site', 'Greenfield Business Park');

    expect(await screen.findByText('AHU-03')).toBeInTheDocument();
    expect(screen.getByText('UPS-A2')).toBeInTheDocument();
    // The site-parented asset must appear — naive space-only scoping loses it
    expect(screen.getByText('Campus Chiller CH-01')).toBeInTheDocument();
    // Other sites' assets are gone
    expect(screen.queryByText('Conveyor Motor M-114')).not.toBeInTheDocument();

    // Narrow to Tower A → Floor 3
    await pick(user, 'Building', 'Tower A');
    await pick(user, 'Floor', 'Floor 3');
    expect(await screen.findByText('AHU-03')).toBeInTheDocument();
    expect(screen.queryByText('Campus Chiller CH-01')).not.toBeInTheDocument();
  });

  it('remembers the location for the session (2.7 sticky)', async () => {
    const user = userEvent.setup();
    const first = bootAt('?mock=1&tab=portfolio');
    await screen.findByText('Conveyor Motor M-114'); // options loaded
    await pick(user, 'Site', 'Lakeside Manufacturing Plant');
    expect(await screen.findByText(/Scope: Lakeside/)).toBeInTheDocument();
    first.unmount();

    // Remount = new page load in the same session
    bootAt('?mock=1&tab=portfolio');
    expect(await screen.findByText(/Scope: Lakeside/)).toBeInTheDocument();
    expect(await screen.findByText('Feed Pump P-07')).toBeInTheDocument();
  });

  it('portfolio-smoke: open asset → work orders → tick task → change status → reload → repeat', async () => {
    const user = userEvent.setup();
    const first = bootAt('?mock=1&tab=portfolio');

    // Open AHU-03
    await user.click(await screen.findByText('AHU-03'));
    expect(await screen.findByRole('heading', { name: 'AHU-03' })).toBeInTheDocument();

    // Its work order is listed with a status badge
    const woHead = await screen.findByText('AHU-03 vibration above threshold');
    expect(screen.getByText('1 linked')).toBeInTheDocument();

    // Expand → tasks
    await user.click(woHead);
    expect(await screen.findByText('Measure vibration at bearing housings')).toBeInTheDocument();

    // Tick a task
    await user.click(
      screen.getByRole('button', { name: 'Complete: Measure vibration at bearing housings' }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Reopen: Measure vibration at bearing housings',
      }),
    ).toBeInTheDocument();

    // Change status Open → In Progress through the catalogue
    await user.click(screen.getByRole('combobox', { name: 'Move to' }));
    await user.click(await screen.findByRole('option', { name: 'In Progress' }));
    const row = (await screen.findByText('AHU-03 vibration above threshold')).closest(
      '.wo-row',
    ) as HTMLElement;
    expect(await within(row).findByText('In Progress', { selector: '.badge' })).toBeInTheDocument();

    // RELOAD (unmount + fresh mount, same session) and repeat the reads
    first.unmount();
    bootAt('?mock=1&tab=portfolio');
    await user.click(await screen.findByText('AHU-03'));
    const reloadedHead = await screen.findByText('AHU-03 vibration above threshold');
    const reloadedRow = reloadedHead.closest('.wo-row') as HTMLElement;
    // Mutations survived: status badge is In Progress, task stays closed
    expect(await within(reloadedRow).findByText('In Progress', { selector: '.badge' })).toBeInTheDocument();
    await user.click(reloadedHead);
    expect(
      await screen.findByRole('button', {
        name: 'Reopen: Measure vibration at bearing housings',
      }),
    ).toBeInTheDocument();
  });

  it('creates a work order against the asset', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=portfolio');

    await user.click(await screen.findByText('UPS-A2'));
    await user.click(await screen.findByRole('button', { name: '+ Create work order' }));
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Replace battery string B');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // The new WO appears in the asset's list
    expect(await screen.findByText('Replace battery string B')).toBeInTheDocument();
    expect(screen.getByText('2 linked')).toBeInTheDocument();
  });

  it('text search + open asset detail', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=portfolio');

    await user.type(await screen.findByPlaceholderText('Search assets by name…'), 'pump');
    expect(await screen.findByText('Feed Pump P-07')).toBeInTheDocument();
    expect(screen.queryByText('AHU-03')).not.toBeInTheDocument();

    await user.click(screen.getByText('Feed Pump P-07'));
    expect(await screen.findByRole('heading', { name: 'Feed Pump P-07' })).toBeInTheDocument();
    expect(screen.getByText('#3004')).toBeInTheDocument();
  });
});
