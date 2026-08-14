// layout-smoke (WS-D): AppShell picks its chrome from the environment and
// keeps TabShell's navigation semantics in every one of them.
//   desktop (≥1024, not embedded) → topbar + sidebar, hidden screens under Admin
//   embedded (?capp_id=…)         → compact top pills, visible screens only
//   mobile (everything else)      → bottom icon dock, visible screens only
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell, { type ShellScreen } from '../layout/AppShell';
import { CameraIcon, LayoutGridIcon } from '../layout/icons';

const SCREENS: ShellScreen[] = [
  { id: 'capture', label: 'Capture', visible: true, icon: <CameraIcon />, component: () => <h2>Capture screen</h2> },
  { id: 'rooms', label: 'Rooms', visible: true, icon: <LayoutGridIcon />, component: () => <h2>Rooms screen</h2> },
  { id: 'dashboard', label: 'Dashboard', visible: false, component: () => <h2>Dashboard screen</h2> },
  { id: 'settings', label: 'Settings', visible: false, component: () => <h2>Settings screen</h2> },
  { id: 'devtest', label: 'Dev test', visible: false, devOnly: true, component: () => <h2>Dev test</h2> },
];

const realMatchMedia = window.matchMedia;

/** Minimal MediaQueryList stub — jsdom's own always reports `matches: false`. */
function setViewport(desktop: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function bootAt(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<AppShell screens={SCREENS} />);
}

beforeEach(() => setViewport(false));
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('AppShell chrome selection', () => {
  it('desktop lists every screen in the sidebar, hidden ones under Admin', async () => {
    setViewport(true);
    const { container } = bootAt('?mock=1');

    expect(container.querySelector('.as-desktop')).not.toBeNull();
    expect(container.querySelector('.as-sidebar')).not.toBeNull();
    expect(container.querySelector('.as-dock')).toBeNull();

    // Wordmark
    expect(screen.getByText('Facilio')).toBeInTheDocument();
    expect(screen.getByText('Vision 3D')).toBeInTheDocument();

    // Hidden screens are first-class citizens of the admin layout
    expect(screen.getByText('Admin')).toBeInTheDocument();
    for (const label of ['Capture', 'Rooms', 'Dashboard', 'Settings']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }

    // …and the Admin section holds exactly the hidden ones
    const items = [...(container.querySelectorAll('.as-nav > *') as NodeListOf<HTMLElement>)];
    const adminIndex = items.findIndex((el) => el.textContent === 'Admin');
    const afterAdmin = items.slice(adminIndex + 1).map((el) => el.textContent);
    expect(afterAdmin).toEqual(['Dashboard', 'Settings']);

    // First visible screen is the default
    expect(await screen.findByRole('heading', { name: 'Capture screen' })).toBeInTheDocument();
  });

  it('below 1024 renders the bottom dock with visible screens only', () => {
    const { container } = bootAt('?mock=1');

    expect(container.querySelector('.as-dock')).not.toBeNull();
    expect(container.querySelector('.as-sidebar')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('embedded (?capp_id=) renders compact pills, never the desktop frame', () => {
    // Even at desktop width: the host chrome already owns the page furniture.
    setViewport(true);
    const { container } = bootAt('?mock=1&capp_id=1');

    expect(container.querySelector('.as-embedded')).not.toBeNull();
    expect(container.querySelector('.as-sidebar')).toBeNull();
    expect(container.querySelector('.as-dock')).toBeNull();
    expect(container.querySelectorAll('.tab-bar .tab')).toHaveLength(2);
    expect(screen.queryByRole('tab', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});

describe('AppShell navigation semantics', () => {
  it('a tab click rewrites only the tab param', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&capp_id=7');

    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    expect(await screen.findByRole('heading', { name: 'Rooms screen' })).toBeInTheDocument();

    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('rooms');
    expect(params.get('mock')).toBe('1');
    expect(params.get('capp_id')).toBe('7');
  });

  it('an unknown ?tab= falls back to the first visible screen', async () => {
    bootAt('?mock=1&tab=nosuchscreen');
    expect(await screen.findByRole('heading', { name: 'Capture screen' })).toBeInTheDocument();
  });

  it('a hidden screen reached by ?tab= joins the mobile dock while active', async () => {
    bootAt('?mock=1&tab=settings');

    expect(await screen.findByRole('heading', { name: 'Settings screen' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    // the visible pair is still there alongside it; its sibling stays hidden
    expect(screen.getByRole('tab', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('popstate re-reads the tab from the URL', async () => {
    bootAt('?mock=1&tab=rooms');
    expect(await screen.findByRole('heading', { name: 'Rooms screen' })).toBeInTheDocument();

    window.history.replaceState({}, '', '/?mock=1&tab=capture');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('heading', { name: 'Capture screen' })).toBeInTheDocument();
  });

  it('a crashing screen is contained by its boundary and the nav still works', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const screens: ShellScreen[] = [
      ...SCREENS,
      {
        id: 'boom',
        label: 'Boom',
        visible: false,
        component: () => {
          throw new Error('Deliberate layout crash');
        },
      },
    ];
    window.history.replaceState({}, '', '/?mock=1&tab=boom');
    render(<AppShell screens={screens} />);

    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent('The Boom screen crashed');

    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    expect(await screen.findByRole('heading', { name: 'Rooms screen' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    consoleError.mockRestore();
  });

  it('the desktop grid FILLS the frame and the sidebar collapses', async () => {
    const user = userEvent.setup();
    setViewport(true); // desktop
    const { container } = bootAt('?tab=capture');

    const grid = container.querySelector('.as-desktop') as HTMLElement;
    expect(grid).not.toBeNull();
    // it must not be collapsed by default...
    expect(grid.className).not.toMatch(/collapsed/);

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(container.querySelector('.as-desktop')?.className).toMatch(/collapsed/);
    // labels are hidden by CSS, so the accessible name must survive on the button
    expect(screen.getByRole('tab', { name: 'Dashboard' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(container.querySelector('.as-desktop')?.className).not.toMatch(/collapsed/);
  });

  it('dev-only screens never appear in navigation', () => {
    setViewport(true);
    bootAt('?tab=capture');
    // reachable by ?tab= for the error-boundary test, but never listed
    expect(screen.queryByRole('tab', { name: 'Dev test' })).toBeNull();
    // ...while ordinary hidden screens still surface under Admin
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });
});
