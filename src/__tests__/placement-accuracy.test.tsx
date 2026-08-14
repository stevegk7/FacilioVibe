// The accuracy contract for placing a marker and getting it back.
//
// Three separate things had to be true for a pin to land on the equipment,
// and the field report ("not on the exact point", "very shaky", "the dialogue
// hides the camera") was all three failing at once:
//
//  1. AIM AT PLACE TIME. Choosing what to place and saying where it is are
//     different jobs. The aim must be read when the technician taps Place,
//     while looking at the thing — not when they opened the picker.
//  2. THE PROJECTION MUST KNOW THE REAL LENS. In the Facilio webview the
//     video element never plays, so its videoWidth is 0 and the FOV silently
//     fell back to a made-up default; and iPadOS hands back a zoomed track.
//  3. THE ROUND TRIP. A marker placed at a bearing must come back at the same
//     PHYSICAL bearing after a reload, on a device whose compass disagrees.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationProvider } from '../state/LocationContext';
import PlaceAssetsScreen from '../screens/PlaceAssetsScreen';
import { markerAbsBearing } from '../ar/presence';
import { Relocalizer } from '../ar/relocalize';
import type { Survey } from '../api/types';
import { defaultFov, displayedFov } from '../ar/projection';
import { arDisplayedFov, setArFrameSize, setArVideoSource } from '../ar/ArSpace';
import { __resetFovCalForTest, longAxisFovDeg, observeCalSample, setCameraGeometry } from '../ar/fovCal';
import { PROFILE_BINS } from '../ar/imageShift';
import { readFileSync } from 'node:fs';

function renderScreen(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocationProvider>{ui}</LocationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?mock=1');
  localStorage.clear();
  sessionStorage.clear();
  __resetFovCalForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Walk the authoring flow to the marker step. Mock mode supplies the heading
 * through the ⟲/⟳ buttons, which is the only compass jsdom can have. */
async function reachMarkerStep(user: ReturnType<typeof userEvent.setup>) {
  renderScreen(<PlaceAssetsScreen onClose={() => {}} />);
  await user.type(await screen.findByPlaceholderText(/Survey point name/), 'Pump room');
  await user.click(screen.getByRole('button', { name: /Start — scan the standpoint code/ }));
  await user.type(await screen.findByLabelText('Standpoint code'), 'ws-99');
  await user.click(screen.getByRole('button', { name: 'Use code' }));
  // Mock sweep frames arrive on their own; move on as soon as it is allowed.
  const next = await screen.findByRole('button', { name: /Place markers/ });
  await waitFor(() => expect(next).toBeEnabled(), { timeout: 4000 });
  await user.click(next);
}

describe('placement: the aim is read when Place is tapped', () => {
  it('the picker never covers the camera while aiming, and Place lands on the CURRENT aim', async () => {
    const user = userEvent.setup();
    await reachMarkerStep(user);

    // Compose first — the picker opens as a modal over the stage.
    await user.click(screen.getByRole('button', { name: '+ Asset' }));
    await screen.findByRole('dialog', { name: 'New marker' });

    await user.click(screen.getByRole('combobox', { name: 'Asset' }));
    await user.click(await screen.findByRole('option', { name: /AHU-03/ }));
    await user.click(screen.getByRole('button', { name: 'Next — aim at it' }));

    // Armed: the sheet is GONE (camera clear) and Place/Cancel sit under the
    // crosshair. This is the whole point of the change.
    expect(screen.queryByRole('dialog', { name: 'New marker' })).not.toBeInTheDocument();
    const dock = await screen.findByRole('group', { name: 'Place marker' });
    expect(dock).toHaveClass('pa-place-dock');
    expect(screen.getByRole('button', { name: 'Place' })).toBeInTheDocument();

    // Now AIM somewhere new — 60° right of where the picker was opened — and
    // only then place. The stored bearing must follow the aim, not the tap
    // that opened the picker.
    const right = screen.getByRole('button', { name: '⟳ 30°' });
    await user.click(right);
    await user.click(right);
    await user.click(screen.getByRole('button', { name: 'Place' }));

    await waitFor(() => expect(screen.getByText(/AHU-03 · 60°/)).toBeInTheDocument());
  });

  it('Cancel discards the armed marker and restores the normal footer', async () => {
    const user = userEvent.setup();
    await reachMarkerStep(user);

    await user.click(screen.getByRole('button', { name: '+ Asset' }));
    await user.click(screen.getByRole('combobox', { name: 'Asset' }));
    await user.click(await screen.findByRole('option', { name: /AHU-03/ }));
    await user.click(screen.getByRole('button', { name: 'Next — aim at it' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group', { name: 'Place marker' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Asset' })).toBeInTheDocument();
    expect(screen.queryByText(/AHU-03 ·/)).not.toBeInTheDocument();
  });
});

describe('reload: a placed marker comes back on the same physical spot', () => {
  it('survives a device whose compass disagrees by 25°, via the standpoint scan', () => {
    // Placed during authoring: sweep base 100, aimed at 160 → stored 60.
    const survey: Survey = {
      id: 'sv-1',
      name: 'Pump room',
      geo: null,
      qrCode: 'ws-99',
      qrHeading: 140,
      sweep: [{ heading: 100, pitch: 0, vec: { q: '', s: 1, dim: 0 } }],
      markers: [{ id: 'm1', label: 'AHU-03', heading: 60, pitch: -10, assetId: 3001 }],
      modelId: 'luma64-v0',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    // Authoring device drew it at 160.
    expect(markerAbsBearing(survey, survey.markers[0], 0)).toBe(160);

    // A second device reads every bearing 25° high. Facing the same sticker it
    // reports 165 where the first said 140.
    const reloc = new Relocalizer();
    reloc.confirmByQr([survey], 'ws-99', 165);
    expect(reloc.current?.delta).toBe(25);

    // 185 in the new frame IS 160 in the old one — the same physical
    // direction. The disagreement is cancelled for every marker at once.
    expect(markerAbsBearing(survey, survey.markers[0], reloc.current!.delta)).toBe(185);
  });
});

describe('the marker dialog is the top layer, not a peer of the stage chrome', () => {
  // Asserted against the stylesheet itself: jsdom does not apply CSS files, so
  // a computed-style check here would pass on any value at all. The reported
  // symptom — footer buttons and AR pins drawing THROUGH the Add Asset
  // dialog — was purely a z-index ordering fact, and this is where it lives.
  const css =
    readFileSync('src/ar/arspace.css', 'utf8') + readFileSync('src/screens/surveys.css', 'utf8');

  function zIndexOf(selector: string): number {
    const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`).exec(css);
    expect(block, `no rule found for ${selector}`).toBeTruthy();
    const z = /z-index:\s*(-?\d+)/.exec(block![0]);
    expect(z, `${selector} declares no z-index`).toBeTruthy();
    return Number(z![1]);
  }

  it('sits above the footer actions, the step badge and every AR card', () => {
    const sheet = zIndexOf('.pa-sheet');
    expect(sheet).toBeGreaterThan(zIndexOf('.pa-foot'));
    expect(sheet).toBeGreaterThan(zIndexOf('.pa-badge'));
    expect(sheet).toBeGreaterThan(zIndexOf('.pa-place-dock'));
    // The AR card layers inside the same stage (arspace.css uses up to 12).
    const cardLayers = [...css.matchAll(/z-index:\s*(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n < 30);
    expect(sheet).toBeGreaterThan(Math.max(...cardLayers));
  });

  it('the Place dock clears the crosshair without covering the aim point', () => {
    const block = /\.pa-place-dock\s*\{[^}]*\}/.exec(css)![0];
    // Anchored at the centre (the crosshair) and pushed BELOW it, never over.
    expect(block).toMatch(/top:\s*50%/);
    expect(/margin-top:\s*(\d+)px/.exec(block)![1]).toBeTruthy();
    expect(Number(/margin-top:\s*(\d+)px/.exec(block)![1])).toBeGreaterThanOrEqual(18);
  });
});

describe('projection: the FOV must come from the real frame, never a guess', () => {
  it('a zoomed 16:9 crop and a full 4:3 frame do NOT project the same', () => {
    // Portrait viewport, same assumed lens: the shape of the delivered frame
    // alone changes how many degrees a pixel is worth. This is why a silently
    // cropped stream slides the overlay against the scene.
    const wide = displayedFov(1600, 1200, 390, 844);
    const cropped = displayedFov(1920, 1080, 390, 844);
    expect(cropped.halfTanX).not.toBeCloseTo(wide.halfTanX, 3);
    expect(cropped.halfTanY).toBeLessThan(wide.halfTanY);
  });

  it('inside the webview the FOV comes from the measured frame, not the default', () => {
    // The Facilio webview never plays the video element, so this is the state
    // the app was ACTUALLY in on iPad: a video reporting 0x0.
    setArVideoSource({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement);
    setArFrameSize(null);
    const blind = arDisplayedFov(390, 844);
    expect(blind).toEqual(defaultFov()); // the old, wrong behaviour

    // With the real frame published by the grabFrame loop, the projection
    // sees the lens it is actually looking through.
    setArFrameSize({ w: 1280, h: 960 });
    const real = arDisplayedFov(390, 844);
    expect(real).toEqual(displayedFov(1280, 960, 390, 844));
    expect(real.halfTanX).not.toBeCloseTo(blind.halfTanX, 3);

    setArVideoSource(null);
    setArFrameSize(null);
  });

  it('a calibration measured through one frame geometry is discarded when the camera changes', () => {
    // Converge a calibration the way the field does: gentle level pans.
    setCameraGeometry(1920, 1080);
    const prev = new Float32Array(PROFILE_BINS);
    const next = new Float32Array(PROFILE_BINS);
    for (let i = 0; i < PROFILE_BINS; i++) {
      prev[i] = Math.sin((i / PROFILE_BINS) * Math.PI * 4);
      next[i] = Math.sin(((i + 3) / PROFILE_BINS) * Math.PI * 4);
    }
    for (let n = 0; n < 30; n++) {
      observeCalSample({ prev, next, dHeadingDeg: 3, dPitchDeg: 0, frameW: 1080, frameH: 1920 });
    }
    const learned = longAxisFovDeg(68);

    // The zoom fix changes the delivered frame. The stored focal length
    // describes a lens that is no longer there.
    setCameraGeometry(1600, 1200);
    expect(longAxisFovDeg(68)).toBe(68);
    expect(longAxisFovDeg(68)).not.toBe(learned === 68 ? -1 : learned);
  });

  it('a legacy calibration with no recorded geometry is discarded on sight', () => {
    localStorage.setItem('fv.cal.fovLong', '52');
    __resetFovCalForTest();
    localStorage.setItem('fv.cal.fovLong', '52');
    expect(longAxisFovDeg(68)).toBe(52); // loads, for back-compat…
    setCameraGeometry(1600, 1200); // …then the first real frame retires it
    expect(longAxisFovDeg(68)).toBe(68);
  });
});
