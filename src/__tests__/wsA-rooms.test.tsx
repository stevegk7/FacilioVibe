// wsA-rooms: RoomsScreen renders seeded captures grouped by space, the viewer
// shows marker bubbles with asset names, and deleting a capture removes its
// emb.* vectors too. Plus a mount smoke for CaptureScreen (camera unavailable
// under jsdom → embed-aware fallback shows instead of a crash).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { appStore } from '../api/appStore';
import { LocationProvider } from '../state/LocationContext';
import { putCapture, putVector } from '../vision/captureStore';
import CaptureScreen from '../screens/CaptureScreen';
import RoomsScreen from '../screens/RoomsScreen';

function mockMode() {
  window.history.replaceState({}, '', '/?mock=1');
}

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocationProvider>{ui}</LocationProvider>
    </QueryClientProvider>,
  );
}

async function seedCapture(id: string, spaceName: string | undefined, assetId: number | null) {
  const photoFileId = await appStore.uploadPhoto(new Blob([`photo-${id}`]), `${id}.jpg`);
  const thumbFileId = await appStore.uploadPhoto(new Blob([`thumb-${id}`]), `${id}-t.jpg`);
  const markers =
    assetId === null
      ? []
      : [
          {
            assetId,
            rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
            cropFileId: await appStore.uploadPhoto(new Blob([`crop-${id}`]), `${id}-c.jpg`),
          },
        ];
  await putCapture({
    id,
    siteId: 1001,
    spaceName,
    photoFileId,
    thumbFileId,
    markers,
    geo: null,
    createdAt: '2026-08-13T09:00:00Z',
    embeddingStatus: 'done',
  });
  if (assetId !== null) {
    await putVector(1001, {
      assetId,
      captureId: id,
      markerIdx: 0,
      modelId: 'stub-test',
      q: 'AAAA',
      s: 1,
      dim: 3,
    });
  }
}

describe('rooms browser (mock mode)', () => {
  it('groups captures by space, viewer shows asset-name bubbles, delete removes vectors', async () => {
    mockMode();
    await seedCapture('r1', 'Server Room', 3001);
    await seedCapture('r2', undefined, null);

    const user = userEvent.setup();
    renderWithProviders(<RoomsScreen />);

    // grouped by space name; the unnamed capture falls into the fallback group
    expect(await screen.findByRole('heading', { name: /Server Room/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Unassigned space/ })).toBeInTheDocument();

    // open the Server Room capture → marker bubble resolves the asset name
    await user.click(screen.getByRole('button', { name: 'Open capture in Server Room' }));
    const viewer = await screen.findByRole('dialog', { name: 'Capture viewer' });
    expect(viewer).toBeInTheDocument();
    expect(await screen.findByText('AHU-03')).toBeInTheDocument();

    // delete needs an explicit confirm (no native dialogs), then cleans up KV
    await user.click(screen.getByRole('button', { name: 'Delete capture' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete photo + vectors' }));

    await waitFor(async () => {
      expect(await appStore.kvGet('surveys', 'capture.r1')).toBeNull();
    });
    expect(await appStore.kvList('surveys', 'emb.1001.r1.')).toHaveLength(0);
    // the other capture is untouched
    expect(await appStore.kvGet('surveys', 'capture.r2')).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open capture in Server Room' })).not.toBeInTheDocument(),
    );
  });

  it('CaptureScreen mounts under jsdom: camera unavailable fallback, no crash', async () => {
    mockMode();
    renderWithProviders(<CaptureScreen />);

    expect(await screen.findByText(/Camera unavailable here/)).toBeInTheDocument();
    // shutter exists but is disabled while the camera is not live
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeDisabled();
  });
});
