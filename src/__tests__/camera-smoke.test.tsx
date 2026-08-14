// camera-smoke (WS-A): the useCamera state machine under jsdom.
//  - no getUserMedia → 'unavailable' with an embed-aware message
//  - mocked stream + resolving play() → 'live'
//  - rejected play() → 'paused' with tap-to-start, gesture resume works
//  - hosted-webview (?capp_id) path grabs frames via ImageCapture and NEVER
//    calls video.play()
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraView } from '../components/camera/CameraView';
import { useCamera } from '../components/camera/useCamera';

function CamHarness() {
  const cam = useCamera(true);
  return (
    <>
      <span data-testid="cam-state">{cam.state}</span>
      <CameraView
        videoRef={cam.videoRef}
        frameCanvasRef={cam.frameCanvasRef}
        state={cam.state}
        onResume={() => void cam.resume()}
      />
    </>
  );
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

function installMediaDevices() {
  const getUserMedia = vi.fn(async () => fakeStream());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

/** jsdom has no srcObject on media elements — give it a plain slot. */
function installSrcObject() {
  Object.defineProperty(window.HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() {
      return (this as { _srcObject?: unknown })._srcObject ?? null;
    },
    set(v: unknown) {
      (this as { _srcObject?: unknown })._srcObject = v;
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // remove per-test globals so the next test starts clean
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  delete (window as { ImageCapture?: unknown }).ImageCapture;
});

describe('camera smoke (jsdom)', () => {
  it('no getUserMedia → unavailable, with the browser-flavoured message', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    render(<CamHarness />);

    expect(await screen.findByTestId('cam-state')).toHaveTextContent('unavailable');
    expect(screen.getByText(/Camera unavailable here/)).toBeInTheDocument();
    // not embedded → browser advice, plus the open-in-browser escape hatch
    expect(screen.getByText(/Allow camera access in the browser/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open full app in browser/ })).toBeInTheDocument();
  });

  it('no getUserMedia inside the Facilio webview → embed-aware message', async () => {
    window.history.replaceState({}, '', '/?mock=1&capp_id=42');
    render(<CamHarness />);

    expect(await screen.findByTestId('cam-state')).toHaveTextContent('unavailable');
    expect(
      screen.getByText(/Facilio app hasn’t granted camera access to embedded pages/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open full app in browser/ })).toBeInTheDocument();
  });

  it('mocked stream + resolving play() → live', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    installMediaDevices();
    installSrcObject();
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);

    render(<CamHarness />);

    await waitFor(() => expect(screen.getByTestId('cam-state')).toHaveTextContent('live'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Camera unavailable/)).not.toBeInTheDocument();
  });

  it('rejected play() → paused with tap-to-start; gesture resume goes live', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    installMediaDevices();
    installSrcObject();
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new Error('NotAllowedError'));

    render(<CamHarness />);

    await waitFor(() => expect(screen.getByTestId('cam-state')).toHaveTextContent('paused'));
    const resume = screen.getByRole('button', { name: /Tap to start the camera/ });
    expect(resume).toBeInTheDocument();

    // the retry runs inside the user gesture and succeeds this time
    play.mockResolvedValueOnce(undefined);
    await userEvent.setup().click(resume);
    await waitFor(() => expect(screen.getByTestId('cam-state')).toHaveTextContent('live'));
  });

  it('hosted webview: ImageCapture grabFrame path goes live and NEVER calls video.play()', async () => {
    window.history.replaceState({}, '', '/?mock=1&capp_id=42');
    installMediaDevices();
    installSrcObject();
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);

    // jsdom canvases have no 2d context — hand the grab loop a fake one
    const fakeCtx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fakeCtx as never,
    );

    const grabFrame = vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }));
    (window as { ImageCapture?: unknown }).ImageCapture = class {
      grabFrame = grabFrame;
    };

    render(<CamHarness />);

    await waitFor(() => expect(screen.getByTestId('cam-state')).toHaveTextContent('live'));
    expect(grabFrame).toHaveBeenCalled();
    // the load-bearing assertion: inside the webview the video is never played
    expect(play).not.toHaveBeenCalled();
  });
});
