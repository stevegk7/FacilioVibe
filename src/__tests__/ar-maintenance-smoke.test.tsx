// WS-B acceptance: the maintenance loop a technician actually runs —
// stand at a standpoint (scan its sticker), see the asset marker, open its
// work orders, tick a task, move the status, pin a note for the next person,
// and find that note still there after the app is remounted.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { setOrientationForTest } from '../hooks/useHeading';
import { __resetPoseForTest, __setPoseForTest } from '../ar/ArSpace';
import type { Survey } from '../api/types';

const scanBus = vi.hoisted(() => ({ emit: null as ((code: string) => void) | null }));

/**
 * A gate on the surveys KV read. appStore is a Proxy (it resolves mock-vs-real
 * per property access), so it cannot be spied on — wrap the module instead.
 * Inert until a test sets `kvGate.hold`, so every other test is untouched.
 */
const kvGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('../api/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appStore')>();
  return {
    ...actual,
    appStore: new Proxy(actual.appStore, {
      get(target, prop: keyof typeof actual.appStore) {
        const value = Reflect.get(target, prop);
        if (prop !== 'kvList' || typeof value !== 'function') return value;
        return async (...args: Parameters<typeof actual.appStore.kvList>) => {
          if (args[0] === 'surveys' && kvGate.hold) await kvGate.hold;
          return (value as typeof actual.appStore.kvList)(...args);
        };
      },
    }),
  };
});
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
  id: 'sv-pump',
  name: 'WS-07 · Plant room door',
  siteId: 1001,
  spaceName: 'Open Office 3F',
  geo: null,
  qrCode: 'ws-07-code',
  sweep: [{ heading: 210, pitch: 0, vec: { q: '', s: 1, dim: 0 } }],
  markers: [{ id: 'm-ahu', label: 'AHU-03', heading: 20, pitch: 0, assetId: 3001 }],
  modelId: 'luma64-v0',
  createdAt: '2026-08-01T00:00:00.000Z',
};

function seed() {
  localStorage.setItem(`fv.mockKv.surveys.survey.${SURVEY.id}`, JSON.stringify(SURVEY));
  localStorage.setItem(
    `fv.mockKv.codes.${SURVEY.qrCode}`,
    JSON.stringify({
      code: SURVEY.qrCode,
      type: 'survey',
      surveyId: SURVEY.id,
      createdAt: SURVEY.createdAt,
    }),
  );
}

/** Boot the AR tab (camera live on open) and scan the standpoint sticker. */
async function standAtStandpoint() {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/?mock=1&tab=ar');
  render(<App />);
  // AR is live on open now; just wait for the stage.
  await screen.findByRole('button', { name: 'AR on' });
  // Wait for the mocked scan loop to arm itself before firing.
  //
  // `scanBus.emit` is assigned by an effect inside the mock, and finding the
  // "AR on" button does not guarantee that effect has flushed. Emitting through
  // `?.` while it was still null silently did NOTHING — the scan simply never
  // happened, and the assertion below then failed as though the app were
  // broken. Which interleaving you got depended on machine load, so this failed
  // about one full-suite run in five and passed every time in isolation.
  await waitFor(() => expect(scanBus.emit).not.toBeNull());
  await act(async () => {
    scanBus.emit!(SURVEY.qrCode as string);
  });
  await screen.findByText(`Localized · ${SURVEY.name} · QR`);
  return user;
}


// A technician reading markers is, by definition, holding a phone whose
// compass is answering — ArSpace refuses to place a marker without a pose, so
// jsdom (which has no sensors) has to supply one or the stage is legitimately
// empty.
beforeEach(() => {
  // 30° off the fixture's marker (which sits at 210 + 20 = 230°): near enough
  // to be in view, far enough that ArGuide does not fire arrival the instant
  // it mounts — pointing straight at it IS arrival.
  setOrientationForTest(200);
  __setPoseForTest(200, 0);
});
afterEach(() => {
  setOrientationForTest(null);
  __resetPoseForTest();
  // A test that fails mid-way must not leave the KV gate armed for the next one.
  kvGate.hold = null;
});

describe('AR maintenance loop (mock mode)', () => {
  it('scan → marker → work orders → task → status → note → survives a remount', async () => {
    seed();
    const user = await standAtStandpoint();

    // the survey's asset marker, coloured by its live work orders
    const marker = await screen.findByRole('button', { name: /AHU-03/ });
    expect(marker).toHaveClass('ar-asset-tag');
    // its work orders land a beat later and colour the marker red
    await waitFor(() => expect(within(marker).getByText('1 open')).toBeInTheDocument());
    expect(marker.querySelector('.edge')).toHaveClass('st-red');

    // focusing it opens the AR WINDOW anchored at the marker (visionOS style):
    // home view → the Work orders group → one work order's summary
    await user.click(marker);
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByRole('heading', { name: 'AHU-03' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /Work orders/ }));
    const woRow = await within(panel).findByRole('button', {
      name: /AHU-03 vibration above threshold/,
    });
    await user.click(woRow);

    // tick a checklist task
    const task = await within(panel).findByRole('button', {
      name: 'Complete: Measure vibration at bearing housings',
    });
    await user.click(task);
    await waitFor(() =>
      expect(
        within(panel).getByRole('button', {
          name: 'Reopen: Measure vibration at bearing housings',
        }),
      ).toBeInTheDocument(),
    );

    // Walk the work order through the org's STATE FLOW, not the status
    // catalogue. There is no longer a one-tap jump to Closed, because the flow
    // does not offer one from Open — and the buttons must be re-read after each
    // transition, which is the whole contract of this panel.
    const actions = () => within(panel).findByRole('group', { name: 'Actions' });

    // Open offers Start Work; it does NOT offer Resolve or Close.
    let group = await actions();
    expect(within(group).queryByRole('button', { name: /^Close$/ })).toBeNull();
    await user.click(within(group).getByRole('button', { name: 'Start Work' }));
    await waitFor(() => expect(panel.querySelector('.vg-chip')).toHaveTextContent('In Progress'));

    // …and now the strip has refreshed to what In Progress allows.
    group = await actions();
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Resolve' })).toBeInTheDocument(),
    );
    await user.click(within(group).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(panel.querySelector('.vg-chip')).toHaveTextContent('Resolved'));

    group = await actions();
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Close' })).toBeInTheDocument(),
    );
    await user.click(within(group).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(panel.querySelector('.vg-chip')).toHaveTextContent('Closed'));

    // pin a note at this standpoint for whoever comes next: "Pin here" freezes
    // the aim, THEN asks which module this is
    await user.click(screen.getByRole('button', { name: /Pin here/ }));
    await user.click(await screen.findByRole('button', { name: /Note.*next technician/s }));
    await user.type(
      screen.getByRole('textbox', { name: /Note/ }),
      'Left the isolation valve half open',
    );
    await user.click(screen.getByRole('button', { name: 'Pin note' }));
    expect(
      await screen.findByRole('button', { name: /Left the isolation valve half open/ }),
    ).toBeInTheDocument();

    // ---- remount: the note is in the survey, not in React state ----
    cleanup();
    await standAtStandpoint();
    expect(
      await screen.findByRole('button', { name: /Left the isolation valve half open/ }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /AHU-03/ })).toBeInTheDocument();
  });

  it('the marker index lists both markers and can guide to one', async () => {
    seed();
    const user = await standAtStandpoint();
    await screen.findByRole('button', { name: /AHU-03/ });

    await user.click(screen.getByRole('button', { name: /Markers/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Marker index' });
    const rows = within(sheet).getAllByRole('button', { name: 'Guide' });
    expect(rows).toHaveLength(SURVEY.markers.length);

    // abs = (sweep[0].heading + marker.heading + Δ) % 360 = (210 + 20 + 0) % 360
    expect(within(sheet).getByText('230°')).toBeInTheDocument();

    await user.click(rows[0]);
    expect(await screen.findByText('AHU-03', { selector: '.vs-guide-name' })).toBeInTheDocument();
  });
});

it('minimize sends the window to a DOT; tapping the dot brings it back', async () => {
  seed();
  const user = await standAtStandpoint();
  const marker = await screen.findByRole('button', { name: /AHU-03/ });
  await user.click(marker);

  const panel = await screen.findByRole('complementary');
  await user.click(within(panel).getByRole('button', { name: 'Minimize AHU-03' }));

  // the window is gone; in its place the visionOS dot with the label
  expect(screen.queryByRole('complementary')).toBeNull();
  const dot = await screen.findByRole('button', { name: 'Restore AHU-03' });
  expect(dot).toHaveClass('ar-min-dot');

  await user.click(dot);
  expect(await screen.findByRole('complementary')).toBeInTheDocument();
});

it('the open window WINS the stacking war, anchors on its dot, and always offers the summary ornament', async () => {
  seed();
  const user = await standAtStandpoint();
  const marker = await screen.findByRole('button', { name: /AHU-03/ });

  // markers lead with the anchor dot — the pixel that was aimed at placement
  expect(marker.querySelector('.edge')).not.toBeNull();
  expect(marker.querySelector('.plate')).not.toBeNull();

  await user.click(marker);
  const panel = await screen.findByRole('complementary');

  // the card hosting the OPEN window is lifted above sibling nameplates
  // (each card is its own stacking context, so the z-index sits on the card)
  const card = panel.closest('div[style*="translate"]') as HTMLElement;
  expect(card.style.zIndex).toBe('5');

  // the summary ornament is ALWAYS there: without a configured link template
  // it routes to Settings instead of silently vanishing
  await user.click(within(panel).getByRole('button', { name: /Work orders/ }));
  await user.click(await within(panel).findByRole('button', { name: /AHU-03 vibration/ }));
  expect(
    screen.getByRole('button', { name: /Open summary — set link in Settings/ }),
  ).toBeInTheDocument();
});

/**
 * Regression: a sticker scanned before the standpoint registry has loaded.
 *
 * The QR effect used to record the hit's timestamp on its very first run, then
 * try to match the code against `surveys` — which is empty while its query is
 * in flight. The match failed, and the recorded timestamp meant the effect
 * never retried the hit when the surveys arrived: the scan was swallowed.
 *
 * The field never showed it, because the real scan loop re-emits every tick
 * with a fresh `at` while the code is in frame. The mock here emits ONCE, which
 * is what turns a self-healing race into a deterministic assertion — and what
 * made the suite flaky before the fix, since whether the emit beat the query
 * depended purely on machine load.
 */
it('a sticker scanned before the survey registry loads still localizes', async () => {
  seed();

  // Hold the surveys read open so the scan is guaranteed to arrive first —
  // the losing side of the race every time, instead of once in twenty runs.
  let releaseSurveys: (() => void) | null = null;
  kvGate.hold = new Promise<void>((resolve) => {
    releaseSurveys = resolve;
  });

  window.history.replaceState({}, '', '/?mock=1&tab=ar');
  render(<App />);
  await screen.findByRole('button', { name: 'AR on' });

  // Scan while the registry is still in flight. One emit, as the mock gives —
  // but only once the mock is armed. Emitting through `?.` before its effect has
  // flushed silently does nothing, which is indistinguishable from the app
  // dropping the scan and is exactly the flake this file already fixed once.
  await waitFor(() => expect(scanBus.emit).not.toBeNull());
  await act(async () => {
    scanBus.emit!(SURVEY.qrCode as string);
  });
  expect(screen.queryByText(`Localized · ${SURVEY.name} · QR`)).toBeNull();

  // Registry arrives — the deferred hit must now be honoured.
  await act(async () => {
    releaseSurveys?.();
    await Promise.resolve();
  });
  expect(await screen.findByText(`Localized · ${SURVEY.name} · QR`)).toBeInTheDocument();
});
