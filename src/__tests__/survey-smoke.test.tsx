// WS-B acceptance: presence — the rule that markers belong to a PLACE.
// A scanned standpoint sticker is strong proof (180s), a visual match is weak
// proof (20s), leaving the area kills presence outright, and a background
// ['surveys'] refetch must never evict the standpoint under the technician.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { setOrientationForTest } from '../hooks/useHeading';
import { __resetPoseForTest, __setPoseForTest } from '../ar/ArSpace';
import type { GeoFix, Survey } from '../api/types';
import {
  markerAbsBearing,
  presenceDecayCheck,
  QR_STALE_MS,
  VISUAL_STALE_MS,
  type Presence,
} from '../ar/presence';

// The scan loop is WS-A's camera-driven hook; in jsdom it never sees a frame,
// so the QR lane is driven directly.
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

const SWEEP_BASE = 100;

function makeSurvey(extra: Partial<Survey> = {}): Survey {
  return {
    id: 'sv-1',
    name: 'WS-01',
    siteId: 1001,
    spaceName: 'Open Office 3F',
    geo: null,
    qrCode: 'ws-01-code',
    sweep: [{ heading: SWEEP_BASE, pitch: 0, vec: { q: '', s: 1, dim: 0 } }],
    markers: [{ id: 'm1', label: 'AHU-03', heading: 30, pitch: 0, assetId: 3001 }],
    modelId: 'luma64-v0',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  };
}

function seed(survey: Survey) {
  localStorage.setItem(`fv.mockKv.surveys.survey.${survey.id}`, JSON.stringify(survey));
  if (survey.qrCode) {
    localStorage.setItem(
      `fv.mockKv.codes.${survey.qrCode}`,
      JSON.stringify({
        code: survey.qrCode,
        type: 'survey',
        surveyId: survey.id,
        createdAt: survey.createdAt,
      }),
    );
  }
}

async function bootLocalized() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  window.history.replaceState({}, '', '/?mock=1&tab=ar');
  render(<App />);
  // AR is live on open now; just wait for the stage.
  await screen.findByRole('button', { name: 'AR on' });
  // The camera no longer waits on a tap, so the scan can fire before the
  // surveys query settles — re-emit until the standpoint is recognised.
  // Arm first: emitting through `?.` before the mock's effect has flushed does
  // nothing at all, so the retry below was silently burning its first attempts
  // on a no-op rather than on the race it exists for.
  await waitFor(() => expect(scanBus.emit).not.toBeNull());
  await waitFor(
    async () => {
      await act(async () => {
        scanBus.emit!('ws-01-code');
      });
      screen.getByText('Localized · WS-01 · QR');
    },
    { timeout: 4000 },
  );
  return user;
}


// A technician reading markers is, by definition, holding a phone whose
// compass is answering — ArSpace refuses to place a marker without a pose, so
// jsdom (which has no sensors) has to supply one or the stage is legitimately
// empty.
beforeEach(() => {
  // facing the fixture's marker (sweep base 100 + marker 30), so it is in view rather than
  // parked on an edge chevron
  setOrientationForTest(130);
  __setPoseForTest(130, 0);
});
afterEach(() => {
  setOrientationForTest(null);
  __resetPoseForTest();
});

describe('presence (component)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a standpoint QR confirms presence and shows its markers', async () => {
    seed(makeSurvey());
    await bootLocalized();

    expect(await screen.findByRole('button', { name: /AHU-03/ })).toHaveClass('ar-asset-tag');
    // the camera's own unavailable state renders INSIDE the stage
    expect(document.querySelector('.ar-stage .fv-cam')).not.toBeNull();
  });

  it('QR presence survives 25s of no further proof, and dies past 180s', async () => {
    seed(makeSurvey());
    await bootLocalized();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(screen.getByText('Localized · WS-01 · QR')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(190_000);
    });
    await waitFor(() =>
      expect(screen.queryByText('Localized · WS-01 · QR')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /AHU-03/ })).not.toBeInTheDocument();
  });

  it('presence survives a ["surveys"] refetch (pinning a note reloads them)', async () => {
    seed(makeSurvey());
    const user = await bootLocalized();

    await user.click(screen.getByRole('button', { name: /Pin here/ }));
    await user.click(await screen.findByRole('button', { name: /Note.*next technician/s }));
    await user.type(
      screen.getByRole('textbox', { name: /Note/ }),
      'Filter housing rattles at full speed',
    );
    await user.click(screen.getByRole('button', { name: 'Pin note' }));

    // the survey list refetched under us — the standpoint must NOT be evicted
    await waitFor(() =>
      expect(screen.getByText('Localized · WS-01 · QR')).toBeInTheDocument(),
    );
    expect(
      await screen.findByRole('button', { name: /Filter housing rattles/ }),
    ).toBeInTheDocument();
  });
});

describe('presence decay policy (pure)', () => {
  const now = 1_760_000_000_000;
  const survey = makeSurvey({ geo: { lat: 12.97, lng: 77.59, accuracy: 8, at: now } });
  const qr: Presence = { surveyId: 'sv-1', delta: 0, via: 'qr' };
  const visual: Presence = { surveyId: 'sv-1', delta: 0, via: 'visual' };
  const fixHere: GeoFix = { lat: 12.97, lng: 77.59, accuracy: 10, at: now };
  const fixFarAway: GeoFix = { lat: 12.99, lng: 77.59, accuracy: 10, at: now }; // ~2.2km

  it('a visual match goes stale long before a scanned sticker does', () => {
    const at50s = { survey, fix: null, lastMatchAt: now - 50_000, now };
    expect(presenceDecayCheck({ presence: visual, ...at50s })).toEqual({
      decayed: true,
      reason: 'stale',
    });
    expect(presenceDecayCheck({ presence: qr, ...at50s })).toEqual({ decayed: false });
  });

  it('even a sticker goes stale past 180s', () => {
    expect(
      presenceDecayCheck({ presence: qr, survey, fix: null, lastMatchAt: now - 200_000, now }),
    ).toEqual({ decayed: true, reason: 'stale' });
    expect(QR_STALE_MS).toBe(180_000);
    expect(VISUAL_STALE_MS).toBe(45_000);
  });

  it('REGRESSION: a scan is proof on its own clock — the visual matcher\'s silence cannot expire it', () => {
    // The bug: decay was measured only from the relocalizer's lastMatchAt, so
    // panning away (matcher stops matching) made markers vanish under someone
    // who had just scanned the sticker and had not moved.
    const justScanned = { ...qr, at: now - 5_000 };
    expect(
      presenceDecayCheck({
        presence: justScanned,
        survey,
        fix: null,
        lastMatchAt: now - 10 * 60_000, // matcher quiet for ten minutes
        now,
      }),
    ).toEqual({ decayed: false });
  });

  it('the freshest proof of either kind keeps presence alive', () => {
    const oldScan = { ...qr, at: now - 10 * 60_000 };
    // stale scan, but the visual matcher just re-confirmed the same standpoint
    expect(
      presenceDecayCheck({ presence: oldScan, survey, fix: null, lastMatchAt: now - 1_000, now }),
    ).toEqual({ decayed: false });
  });

  it('walking out of the area kills visual presence, but the geo gate never applies to QR', () => {
    expect(
      presenceDecayCheck({ presence: visual, survey, fix: fixFarAway, lastMatchAt: now, now }),
    ).toEqual({ decayed: true, reason: 'left-area' });
    expect(
      presenceDecayCheck({ presence: qr, survey, fix: fixFarAway, lastMatchAt: now, now }),
    ).toEqual({ decayed: false });
    expect(
      presenceDecayCheck({ presence: visual, survey, fix: fixHere, lastMatchAt: now, now }),
    ).toEqual({ decayed: false });
  });

  it('forced presence (no Δ source) never decays', () => {
    expect(
      presenceDecayCheck({
        presence: { ...qr, forced: true },
        survey,
        fix: fixFarAway,
        lastMatchAt: now - 10 * QR_STALE_MS,
        now,
      }),
    ).toEqual({ decayed: false });
  });
});

describe('Δ-corrected absolute bearings', () => {
  const survey = makeSurvey();
  const marker = survey.markers[0];

  it('abs = (sweep[0].heading + marker.heading + Δ + 360) % 360', () => {
    expect(markerAbsBearing(survey, marker, 0)).toBe(130);
    expect(markerAbsBearing(survey, marker, -15)).toBe(115);
    expect(markerAbsBearing(survey, marker, 12)).toBe(142);
  });

  it('wraps through north in both directions', () => {
    const near360 = makeSurvey({
      sweep: [{ heading: 350, pitch: 0, vec: { q: '', s: 1, dim: 0 } }],
    });
    expect(markerAbsBearing(near360, marker, 0)).toBe(20);
    expect(markerAbsBearing(near360, { ...marker, heading: 0 }, -20)).toBe(330);
  });

  it('a survey with no sweep frames falls back to a 0° base', () => {
    expect(markerAbsBearing(makeSurvey({ sweep: [] }), marker, 5)).toBe(35);
  });
});
