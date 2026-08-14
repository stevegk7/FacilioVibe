// The merged information architecture, and the navigation primitive under it.
//
// The dock has three slots and there are now twelve screens, so which three win
// is a real decision — and one that a later "just add a tab" would quietly undo.
// The sidebar grouping is a second decision on top: Surveys and Rounds lost dock
// slots to the 3D estate but are field tools, and filing them under Admin beside
// Diagnostics would misdescribe them.
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell, { type ShellScreen } from '../layout/AppShell';
import { goToTab, setNavParams, navParamId, cameFrom, currentTab } from '../shell/router';

const realMatchMedia = window.matchMedia;

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

/** Mirrors the real registry's shape: three dock tabs, two workspace-not-dock. */
const SCREENS: ShellScreen[] = [
  { id: 'estate', label: '3D Estate', visible: true, bleed: true, component: () => <h2>Estate</h2> },
  { id: 'ar', label: 'AR', visible: true, bleed: true, component: () => <h2>AR</h2> },
  { id: 'wayfinder', label: 'Wayfinder', visible: true, component: () => <h2>Wayfinder</h2> },
  { id: 'surveys', label: 'Surveys', visible: false, section: 'workspace', component: () => <h2>Surveys</h2> },
  { id: 'rounds', label: 'Rounds', visible: false, section: 'workspace', component: () => <h2>Rounds</h2> },
  { id: 'settings', label: 'Settings', visible: false, component: () => <h2>Settings</h2> },
  { id: 'boom', label: 'Boom', visible: false, devOnly: true, component: () => <h2>Boom</h2> },
];

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('shell sections', () => {
  it('mobile dock holds the three visible screens, then the overflow', () => {
    setViewport(false);
    window.history.replaceState({}, '', '/');
    render(<AppShell screens={SCREENS} />);

    const dock = document.querySelector('.as-dock') as HTMLElement;
    const labels = [...dock.querySelectorAll('.dock-label')].map((n) => n.textContent);
    // Three primary destinations keep their slots (design rule 1.5) and
    // "More" carries everything else — without it, nine screens including
    // Surveys were unreachable on a phone.
    expect(labels).toEqual(['3D Estate', 'AR', 'Wayfinder', 'More']);
  });

  it('desktop splits Workspace from Admin by section, not by dock membership', () => {
    setViewport(true);
    window.history.replaceState({}, '', '/');
    render(<AppShell screens={SCREENS} />);

    const nav = document.querySelector('.as-nav') as HTMLElement;
    const order = [...nav.children].map((n) =>
      n.classList.contains('nav-section') ? `# ${n.textContent}` : n.textContent,
    );

    // Surveys and Rounds are NOT in the dock but ARE workspace tools.
    expect(order).toEqual([
      '# Workspace',
      '3D Estate',
      'AR',
      'Wayfinder',
      'Surveys',
      'Rounds',
      '# Admin',
      'Settings',
    ]);
    // devOnly is never listed anywhere.
    expect(screen.queryByRole('tab', { name: 'Boom' })).not.toBeInTheDocument();
  });

  it('a screen that sets no section keeps the old behaviour', () => {
    setViewport(true);
    window.history.replaceState({}, '', '/');
    const legacy: ShellScreen[] = [
      { id: 'a', label: 'Visible', visible: true, component: () => <h2>A</h2> },
      { id: 'b', label: 'Hidden', visible: false, component: () => <h2>B</h2> },
    ];
    render(<AppShell screens={legacy} />);

    const nav = document.querySelector('.as-nav') as HTMLElement;
    const order = [...nav.children].map((n) =>
      n.classList.contains('nav-section') ? `# ${n.textContent}` : n.textContent,
    );
    expect(order).toEqual(['# Workspace', 'Visible', '# Admin', 'Hidden']);
  });
});

describe('cross-screen navigation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?mock=1&capp_id=42&origin=https%3A%2F%2Fapp.facilio.com&tab=ar');
  });

  it('preserves the params that must survive every navigation', () => {
    goToTab('estate', { asset: 991 });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('estate');
    expect(params.get('asset')).toBe('991');
    // Dropping any of these would silently take the user out of mock mode, or
    // out of the connected-app embed, mid-handoff.
    expect(params.get('mock')).toBe('1');
    expect(params.get('capp_id')).toBe('42');
    expect(params.get('origin')).toBe('https://app.facilio.com');
  });

  it('clears its own params so a there-and-back cannot re-fire a stale intent', () => {
    goToTab('estate', { asset: 991 });
    expect(navParamId('asset')).toBe(991);

    goToTab('ar');
    expect(navParamId('asset')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('mock')).toBe('1');
  });

  it('notifies listeners, because screens must react while mounted', () => {
    // The pre-merge Wayfinder read ?asset in a useState initialiser, so pushing a
    // new asset at an already-open Wayfinder did nothing at all.
    const seen: string[] = [];
    const off = ((): (() => void) => {
      const listener = () => seen.push(currentTab() ?? '');
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    })();

    goToTab('estate', { asset: 1 });
    goToTab('ar', { asset: 2 });
    off();

    expect(seen).toEqual(['estate', 'ar']);
  });

  it('records where a push came from, for webviews with no browser Back', () => {
    goToTab('estate', { asset: 7 });
    expect(cameFrom()).toBe('ar');
  });

  it('setNavParams updates in place without stacking history', () => {
    const before = window.history.length;
    setNavParams({ asset: 55 });
    expect(navParamId('asset')).toBe(55);
    expect(window.history.length).toBe(before);

    setNavParams({ asset: null });
    expect(navParamId('asset')).toBeNull();
  });
});
