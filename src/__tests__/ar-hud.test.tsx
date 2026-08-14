// Design-system smoke for the mobile-native AR stage over the REAL camera.
//
// jsdom has no layout, so "fits the screen" is asserted STRUCTURALLY: the
// stage is class-driven (no inline/vh sizing), it is the only element between
// the shell pane and the camera, and nothing inside it is a page-level
// scroller — sheets and panels carry their own scrollers instead.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { setOrientationForTest } from '../hooks/useHeading';
import { __resetPoseForTest, __setPoseForTest } from '../ar/ArSpace';
import type { Survey } from '../api/types';

const scanBus = vi.hoisted(() => ({ emit: null as ((code: string) => void) | null }));
vi.mock('../vision/scanLoop', async () => {
  const React = await import('react');
  return {
    useScanLoop: () => {
      const [qrHit, setQrHit] = React.useState<{ code: string; at: number } | null>(null);
      React.useEffect(() => {
        scanBus.emit = (code: string) => setQrHit({ code, at: Date.now() });
        return () => {
          scanBus.emit = null;
        };
      }, []);
      return {
        candidates: [],
        locked: null,
        qrHit,
        hint: null,
        stats: { ticks: 0, embeds: 0, embedMs: 0, embedIntervalMs: 500, indexSize: 0 },
      };
    },
  };
});

const SURVEY: Survey = {
  id: 'sv-hud',
  name: 'WS-01',
  spaceName: 'Open Office 3F',
  geo: null,
  qrCode: 'ws-01-code',
  sweep: [{ heading: 0, pitch: 0, vec: { q: '', s: 1, dim: 0 } }],
  markers: [
    { id: 'm1', label: 'AHU-03', heading: 10, pitch: 0, assetId: 3001 },
    { id: 'm2', label: 'Belt slipping — check on next PM', heading: 40, pitch: -3, note: 'x' },
  ],
  modelId: 'luma64-v0',
  createdAt: '2026-08-01T00:00:00.000Z',
};

function seed() {
  localStorage.setItem(`fv.mockKv.surveys.survey.${SURVEY.id}`, JSON.stringify(SURVEY));
  localStorage.setItem(
    `fv.mockKv.codes.${SURVEY.qrCode}`,
    JSON.stringify({ code: SURVEY.qrCode, type: 'survey', surveyId: SURVEY.id, createdAt: SURVEY.createdAt }),
  );
}

function bootAt(query: string) {
  window.history.replaceState({}, '', `/${query}`);
  return render(<App />);
}

function stageOf(container: HTMLElement): HTMLElement {
  const stage = container.querySelector('.ar-stage');
  expect(stage).not.toBeNull();
  return stage as HTMLElement;
}

afterEach(() => {
  delete (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
});


// A technician reading markers is, by definition, holding a phone whose
// compass is answering — ArSpace refuses to place a marker without a pose, so
// jsdom (which has no sensors) has to supply one or the stage is legitimately
// empty.
beforeEach(() => {
  setOrientationForTest(0);
  __setPoseForTest(0, 0);
});
afterEach(() => {
  setOrientationForTest(null);
  __resetPoseForTest();
});

describe('AR HUD — mobile-native stage (mock mode)', () => {
  it('renders the site chip, the rail, ONE state chip and the bottom action row', async () => {
    const { container } = bootAt('?mock=1&tab=ar');

    // top-left: the site chip, tappable
    expect(await screen.findByRole('button', { name: /All sites/ })).toBeInTheDocument();
    // top-right rail: ONE button — AR itself. Voice + AI-create moved into
    // the Effi orb's visual-intelligence menu; duplicates were removed.
    expect(screen.getByRole('button', { name: 'AR on' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create work order with AI' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Talk to Effi' })).toBeInTheDocument();
    const rail = container.querySelector('.ar-rail') as HTMLElement;
    expect(within(rail).getAllByRole('button')).toHaveLength(1);
    // the AR toggle is an icon button in the rail, not a text pill
    expect(screen.getByRole('button', { name: 'AR on' })).toHaveClass('ar-rail-btn');
    expect(screen.queryByText('AR on')).toBeNull();

    // top-centre: exactly ONE state chip
    expect(container.querySelectorAll('.ar-state')).toHaveLength(1);

    // bottom action row: primary + secondary, sized by class contract
    const primary = screen.getByRole('button', { name: /Pin here/ });
    const secondary = screen.getByRole('button', { name: /Markers/ });
    expect(primary).toHaveClass('ar-action', 'ar-action-primary');
    expect(secondary).toHaveClass('ar-action', 'ar-action-secondary');
    // .ar-action is the 52px / ≥44px contract in src/styles/ar.css
    expect(container.querySelector('.ar-actions')?.children).toHaveLength(2);

    // camera-first: the feed surface is mounted without any tap
    await waitFor(() => expect(container.querySelector('.fv-cam')).not.toBeNull());
    expect(container.querySelector('.ar-crosshair')).not.toBeNull();
  });

  it('the stage fills its pane: class-driven height, no page-level scroller inside it', async () => {
    const { container } = bootAt('?mock=1&tab=ar');
    await screen.findByRole('button', { name: 'AR on' });
    const stage = stageOf(container);

    // no inline sizing at all — height comes from .ar-stage { height: 100% }
    expect(stage.getAttribute('style')).toBeNull();
    // the shell pane hosts it directly and opts out of scrolling (bleed)
    const pane = stage.parentElement as HTMLElement;
    expect(pane).toHaveClass('as-mobile-main', 'bleed');

    // nothing inside the stage declares itself a scrolling page: the only
    // scrollers are the opt-in .scroll-y / .scroll-x panes
    for (const el of stage.querySelectorAll<HTMLElement>('*')) {
      const style = el.getAttribute('style') ?? '';
      expect(style).not.toMatch(/100vh|overflow-y:\s*scroll/);
    }
    // and the app chrome is never owned by the stage (any sibling dock tab will
    // do — the dock is 3D Estate · AR · Wayfinder since the merge)
    expect(screen.getByRole('tab', { name: 'Wayfinder' })).toBeInTheDocument();
    expect(stage.querySelector('.as-dock')).toBeNull();
  });

  it('camera is live on open; the first touch arms the iOS motion sensors', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission,
    };
    const user = userEvent.setup();
    const { container } = bootAt('?mock=1&tab=ar');

    // No tap needed: the feed surface mounts inside the stage on open, and its
    // unavailable state is a card INSIDE the stage, not a whole-screen error.
    await screen.findByRole('button', { name: 'AR on' });
    const stage = stageOf(container);
    await waitFor(() => expect(stage.querySelector('.fv-cam')).not.toBeNull());
    expect(within(stage).getByText(/Camera unavailable here/)).toBeInTheDocument();
    expect(stage.querySelector('.fv-cam-unavailable')).not.toBeNull();
    expect(
      within(stage).getByRole('button', { name: /Open full app in browser/ }),
    ).toHaveClass('fv-cam-open-browser');

    // iOS gates MOTION (not camera) behind a gesture — the first touch arms it
    await user.click(stage);
    await waitFor(() => expect(requestPermission).toHaveBeenCalled());

    // toggling off still tears the feed down, and the rail button renames
    await user.click(screen.getByRole('button', { name: 'AR on' }));
    expect(container.querySelector('.fv-cam')).toBeNull();
    expect(screen.getByRole('button', { name: 'AR off' })).toBeInTheDocument();
    expect(screen.getByText('AR paused')).toBeInTheDocument();
  });

  it('the mid-screen hint pill carries an action: compass-only standpoint picking', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = bootAt('?mock=1&tab=ar');
    await screen.findByRole('button', { name: 'AR on' });

    // un-localized: ONE compact action chip, tucked under the top band.
    // The camera is the content — no chrome sits over the middle of it, and
    // the state chip up top already narrates what we are doing.
    const hints = container.querySelector('.ar-hints') as HTMLElement;
    expect(within(hints).queryByText(/pan slowly to locate|name the standpoint/)).toBeNull();
    const action = within(hints).getByRole('button', { name: /Show markers anyway|Pick a standpoint/ });
    expect(action).toHaveClass('ar-pill', 'ar-pill-action');

    // its action opens the standpoint sheet — which scrolls internally
    await user.click(action);
    const sheet = await screen.findByRole('dialog', { name: 'Pick a standpoint' });
    expect(sheet.querySelector('.sheet-body')).toHaveClass('scroll-y');

    // picking one places the markers on raw compass bearings
    await user.click(await within(sheet).findByRole('button', { name: /WS-01/ }));
    expect(await screen.findByRole('button', { name: /AHU-03/ })).toHaveClass('ar-asset-tag');
    expect(screen.getByText(/Compass-only at WS-01/)).toHaveClass('ar-toast');
  });

  it('the site chip opens the site picker sheet', async () => {
    const user = userEvent.setup();
    bootAt('?mock=1&tab=ar');
    await user.click(await screen.findByRole('button', { name: /All sites/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Site' });
    expect(within(sheet).getByText('Site')).toBeInTheDocument();
  });

  it('markers appear once localized, and the board minimizes ⇄ restores (persisted)', async () => {
    seed();
    const user = userEvent.setup();
    bootAt('?mock=1&tab=ar');

    await screen.findByRole('button', { name: 'AR on' });
    await act(async () => {
      scanBus.emit?.('ws-01-code');
    });

    // the survey's markers: asset tag + note tag
    const tag = await screen.findByRole('button', { name: /AHU-03/ });
    expect(tag).toHaveClass('ar-asset-tag');
    expect(
      screen.getByText('Belt slipping — check on next PM', { selector: '.txt' }),
    ).toBeInTheDocument();
    // the action row's secondary counts them
    expect(screen.getByRole('button', { name: /Markers/ })).toHaveTextContent('2');

    // minimize from the marker index (its footer action)
    await user.click(screen.getByRole('button', { name: /Markers/ }));
    await user.click(await screen.findByRole('button', { name: 'Minimize marker board' }));
    expect(screen.queryByRole('button', { name: /AHU-03/ })).not.toBeInTheDocument();

    const restore = await screen.findByRole('button', { name: /Restore markers \(2\)/ });
    expect(restore).toHaveClass('ar-pill', 'ar-pill-action');
    await waitFor(() =>
      expect(localStorage.getItem('fv.mockKv.settings.board.none')).toBe('{"minimized":true}'),
    );

    // restore
    await user.click(restore);
    expect(await screen.findByRole('button', { name: /AHU-03/ })).toHaveClass('ar-asset-tag');
    await waitFor(() =>
      expect(localStorage.getItem('fv.mockKv.settings.board.none')).toBe('{"minimized":false}'),
    );
  });
});

describe('Place asset — the sheet that shipped broken', () => {
  it('dropdown in the scrolling body, CTA in the sticky footer, never flush siblings', async () => {
    seed();
    const user = userEvent.setup();
    bootAt('?mock=1&tab=ar');
    await screen.findByRole('button', { name: 'AR on' });

    // localize by scanning the standpoint code
    await act(async () => {
      scanBus.emit?.('ws-01-code');
    });
    await screen.findByRole('button', { name: /Pin here/ });

    await user.click(screen.getByRole('button', { name: /Pin here/ }));
    await user.click(await screen.findByRole('button', { name: /Place asset/ }));

    const sheet = await screen.findByRole('dialog', { name: 'Pin details' });
    // the picker lives in the scrolling body…
    const trigger = within(sheet).getByRole('combobox', { name: 'Asset' });
    expect(trigger.closest('.sheet-body')).not.toBeNull();
    // …and the commit button lives in the footer, which never scrolls away
    // and can never be overlapped by the dropdown (the broken build had both
    // as flush siblings in the body, with an unscrollable list on top)
    const cta = within(sheet).getByRole('button', { name: /Place asset here/ });
    expect(cta.closest('.sheet-footer')).not.toBeNull();
    expect(cta).toBeDisabled(); // nothing chosen yet

    await user.click(trigger);
    const options = await within(sheet).findAllByRole('option');
    expect(within(sheet).getByRole('listbox', { name: 'Asset' })).toHaveClass('scroll-y');
    await user.click(options[0]);
    await waitFor(() =>
      expect(within(sheet).getByRole('button', { name: /Place .* here/ })).toBeEnabled(),
    );
  });
});

describe('Effi — the AR voice agent (design: Vision AR Voice Agent)', () => {
  it('the orb floats on the stage; tapping opens the panel; a command replies in place', async () => {
    seed();
    const user = userEvent.setup();
    bootAt('?mock=1&tab=ar');
    await screen.findByRole('button', { name: 'AR on' });

    // idle: the orb with its hint, floating clear of the marker field
    const orb = await screen.findByRole('button', { name: 'Talk to Effi' });
    expect(orb).toHaveClass('ef-orb');
    expect(screen.getByText('Tap to talk')).toBeInTheDocument();

    // tap → the VISUAL INTELLIGENCE menu rises: act on what the camera sees
    await user.click(orb);
    const panel = await screen.findByRole('region', { name: 'Effi voice agent' });
    expect(within(panel).getByText('Visual intelligence')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Create work order/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Record a finding/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Find the asset/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Read nameplate/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Directions/ })).toBeInTheDocument();

    // Ask anything → the listening surface (jsdom → typed fallback)
    await user.click(within(panel).getByRole('button', { name: /Ask anything/ }));
    expect(within(panel).getByText('Listening')).toBeInTheDocument();

    // a local intent answers in the panel, not a toast of prose elsewhere
    await user.type(within(panel).getByLabelText('Voice command'), 'rescan');
    await user.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(within(panel).getByText('Rescanning.')).toBeInTheDocument());

    // ✕ returns to the orb
    await user.click(within(panel).getByRole('button', { name: 'Close Effi' }));
    expect(await screen.findByRole('button', { name: 'Talk to Effi' })).toBeInTheDocument();
  });
});
