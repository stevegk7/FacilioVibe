// Surveys mobile UX contract (the iPhone report: "not mobile native, scroll
// issues, doesn't fit the screen"). These assert the ANATOMY, not the pixels:
// the screen frame that cannot page-scroll, the reference row/section/CTA
// primitives, the detail-as-bottom-sheet, and the authoring sheet over a live
// camera. Behaviour (QR mint, delete, marker geometry) is asserted alongside,
// because a re-skin that loses the wiring is a regression.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { appStore } from '../api/appStore';
import { LocationProvider } from '../state/LocationContext';
import type { Survey } from '../api/types';
import SurveysScreen from '../screens/SurveysScreen';

function renderScreen(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocationProvider>{ui}</LocationProvider>
    </QueryClientProvider>,
  );
}

function survey(extra: Partial<Survey> = {}): Survey {
  return {
    id: 'sv-1',
    name: 'WS-01 point',
    siteId: 1001,
    spaceName: 'Open Office 3F',
    geo: { lat: 12.97, lng: 77.59, accuracy: 12, at: 1_760_000_000_000 },
    sweep: Array.from({ length: 12 }, (_, i) => ({
      heading: (100 + i * 30) % 360,
      pitch: 0,
      vec: { q: '', s: 1, dim: 0 },
    })),
    markers: [
      { id: 'm1', label: 'AHU-03', heading: 30, pitch: -27, assetId: 3001 },
      { id: 'm2', label: 'Filter rattles', heading: 90, pitch: 0, note: 'Filter rattles' },
    ],
    modelId: 'luma64-v0',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  };
}

async function seed(s: Survey) {
  await appStore.kvPut('surveys', `survey.${s.id}`, s);
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?mock=1');
  localStorage.clear();
  sessionStorage.clear();
});

describe('surveys list — mobile anatomy', () => {
  it('is a fixed head over ONE internal scroller (the page itself never scrolls)', async () => {
    await seed(survey());
    const { container } = renderScreen(<SurveysScreen />);

    const frame = container.querySelector('.sv-screen');
    expect(frame).not.toBeNull();
    // head is flex:none chrome; the list is the only scrollable pane and opts
    // into the shared momentum/overscroll rules via .scroll-y
    expect(frame!.querySelector(':scope > .sv-head')).not.toBeNull();
    const list = frame!.querySelector(':scope > .sv-list');
    expect(list).not.toBeNull();
    expect(list).toHaveClass('scroll-y');
    await screen.findByRole('button', { name: /WS-01 point/ });
  });

  it('leads with the gradient CTA and a scope chip, not a text toolbar', async () => {
    renderScreen(<SurveysScreen />);

    const cta = await screen.findByRole('button', { name: 'New survey' });
    expect(cta).toHaveClass('btn-cta');
    // the chip is the working scope, defaulting to the unscoped label
    expect(screen.getByRole('button', { name: /Working scope: All sites/ })).toHaveClass('sv-chip');
  });

  it('empty state explains what a survey IS, in an empty card', async () => {
    const { container } = renderScreen(<SurveysScreen />);

    await waitFor(() => expect(container.querySelector('.empty-card')).not.toBeNull());
    expect(container.querySelector('.empty-card')!.textContent).toMatch(/standpoint you have swept/);
    expect(container.querySelector('.section-label')!.textContent).toBe('Standpoints (0)');
  });

  it('rows are cards: bold title, one grey meta line, trailing QR badge', async () => {
    await seed(survey());
    await seed(survey({ id: 'sv-2', name: 'WS-02 point', qrCode: 'ws-02', createdAt: '2026-07-01T00:00:00.000Z' }));
    renderScreen(<SurveysScreen />);

    const row = await screen.findByRole('button', { name: /WS-01 point/ });
    expect(row).toHaveClass('row-card');
    expect(within(row).getByText('WS-01 point')).toHaveClass('row-card-title');
    expect(within(row).getByText('Open Office 3F · 1 asset · 1 note · 12 sweep frames')).toHaveClass(
      'row-card-meta',
    );
    // no code enrolled → the quiet badge; an enrolled one goes .ok
    expect(within(row).getByText('No QR')).toHaveClass('row-badge');
    const enrolled = screen.getByRole('button', { name: /WS-02 point/ });
    expect(within(enrolled).getByText('QR')).toHaveClass('row-badge', 'ok');
  });
});

describe('survey detail — bottom sheet', () => {
  it('opens as a Sheet with photo-slot, info table, QR explainer, markers and delete', async () => {
    const user = userEvent.setup();
    await seed(survey());
    const { container } = renderScreen(<SurveysScreen />);

    await user.click(await screen.findByRole('button', { name: /WS-01 point/ }));

    const sheet = await screen.findByRole('dialog');
    expect(sheet.querySelector('.sheet-grip')).not.toBeNull(); // grab handle
    expect(sheet.querySelector('.sheet-body')).toHaveClass('scroll-y'); // body scrolls, not the page
    expect(within(sheet).getByRole('heading', { name: 'WS-01 point' })).toBeInTheDocument();

    // info table rows
    const table = container.querySelector('.info-table')!;
    expect(within(table as HTMLElement).getByText(/Open Office 3F/)).toBeInTheDocument();
    expect(within(table as HTMLElement).getByText('12 frames · ±12m fix')).toBeInTheDocument();

    // QR explainer + gradient CTA (no code enrolled yet)
    expect(screen.getByText(/mints a unique code for this standpoint/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate QR for this survey' })).toHaveClass(
      'btn-cta',
    );

    // markers carry DSM ICONS, never emoji (emoji cannot inherit colour and
    // render differently per platform)
    const markers = container.querySelectorAll('.sv-marker');
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      const icon = marker.querySelector('.sv-marker-icon svg');
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('stroke')).toBe('currentColor');
    }
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    // sweep frame 0 is 100° and the marker sits 30° off it → 130° absolute
    expect(markers[0].querySelector('.sv-marker-meta')!.textContent).toBe(
      'bearing 130° · pitch -27°',
    );

    expect(screen.getByRole('button', { name: 'Delete survey' })).toHaveClass('btn-danger-outline');
  });

  it('generating a QR mints ONE code in the shared registry, and delete unlinks it', async () => {
    const user = userEvent.setup();
    await seed(survey());
    renderScreen(<SurveysScreen />);

    await user.click(await screen.findByRole('button', { name: /WS-01 point/ }));
    await user.click(screen.getByRole('button', { name: 'Generate QR for this survey' }));

    await waitFor(async () => {
      const stored = await appStore.kvGet<Survey>('surveys', 'survey.sv-1');
      expect(stored?.qrCode).toBe('fv-sv-sv-1');
    });
    expect(await appStore.kvGet('codes', 'fv-sv-sv-1')).toMatchObject({
      type: 'survey',
      surveyId: 'sv-1',
    });
    expect(await screen.findByText(/print it and stick it/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete survey' }));

    await waitFor(async () => {
      expect(await appStore.kvGet('surveys', 'survey.sv-1')).toBeNull();
    });
    expect(await appStore.kvGet('codes', 'fv-sv-sv-1')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('new survey point — camera + sheet', () => {
  it('opens the authoring overlay with a live camera slot, an exit pill and a single Start CTA', async () => {
    const user = userEvent.setup();
    const { container } = renderScreen(<SurveysScreen />);

    await user.click(await screen.findByRole('button', { name: 'New survey' }));

    // camera mounts immediately (jsdom has no getUserMedia → the fallback
    // renders INSIDE the slot; the point is that the slot is live from step 1)
    expect(container.querySelector('#pa-camera-slot .fv-cam')).not.toBeNull();
    expect(screen.getByRole('button', { name: '← Exit survey' })).toHaveClass('pa-exit');

    // the form is a bottom sheet over the lens, not a page that replaces it
    const panel = container.querySelector('.sheet-panel');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.sheet-grip')).not.toBeNull();
    expect(within(panel as HTMLElement).getByRole('heading', { name: 'New survey point' })).toBeInTheDocument();

    // name input + CTA only. The location cascade was REMOVED from creation:
    // it made this sheet so tall it covered the entire camera view, and the
    // scope is already chosen (and shown) on the Surveys screen.
    const input = screen.getByLabelText('Survey point name');
    expect(input).toHaveClass('sv-input');
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelectorAll('.ds-select-btn')).toHaveLength(0);

    const start = screen.getByRole('button', { name: /scan the standpoint code/i });
    expect(start).toHaveClass('btn-cta');
    expect(start).toBeDisabled(); // needs a name first
    await user.type(input, 'AHU room — door side');
    expect(start).toBeEnabled();
  });
});
