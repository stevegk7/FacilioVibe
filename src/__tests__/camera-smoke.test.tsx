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

function fakeStream(track: Partial<MediaStreamTrack> = {}) {
  const t = { stop: vi.fn(), ...track };
  return {
    getTracks: () => [t],
    getVideoTracks: () => [t],
  } as unknown as MediaStream;
}

function installMediaDevices(stream: MediaStream = fakeStream()) {
  const getUserMedia = vi.fn(async (_constraints?: MediaStreamConstraints) => stream);
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

  // The iPad report: "the camera is zoomed by default … so it is very shaky".
  // A zoomed track is not just uncomfortable — it narrows the field of view,
  // and the AR projection assumes it is looking through the whole lens, so
  // every marker drifts against the scene too.
  it('asks for an UNCROPPED native-shape stream, not a 16:9 crop of a 4:3 sensor', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    const getUserMedia = installMediaDevices();
    installSrcObject();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(<CamHarness />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    const video = getUserMedia.mock.calls[0][0]!.video as {
      aspectRatio?: { ideal: number };
      resizeMode?: string;
      width?: { ideal: number };
      height?: { ideal: number };
    };
    // resizeMode 'none' forbids the UA from manufacturing a format by
    // cropping — the crop is what silently zoomed the view.
    expect(video.resizeMode).toBe('none');
    expect(video.aspectRatio?.ideal).toBeCloseTo(4 / 3, 5);
    // and the requested size must itself be 4:3, or the constraint fights it
    expect(video.width!.ideal / video.height!.ideal).toBeCloseTo(4 / 3, 5);
  });

  it('resets digital zoom to 1.0 — and never below it, which would swap to the ultra-wide', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    const applyConstraints = vi.fn(async (_c?: MediaTrackConstraints) => {});
    installMediaDevices(
      fakeStream({
        getCapabilities: () => ({ zoom: { min: 0.5, max: 8 } }) as MediaTrackCapabilities,
        getSettings: () => ({ zoom: 2 }) as MediaTrackSettings,
        applyConstraints,
      } as Partial<MediaStreamTrack>),
    );
    installSrcObject();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(<CamHarness />);
    await waitFor(() => expect(applyConstraints).toHaveBeenCalled());
    const applied = applyConstraints.mock.calls[0][0] as unknown as { advanced: Array<{ zoom: number }> };
    expect(applied.advanced[0].zoom).toBe(1);
  });

  it('leaves a camera that is already at 1.0 alone', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    const applyConstraints = vi.fn(async (_c?: MediaTrackConstraints) => {});
    installMediaDevices(
      fakeStream({
        getCapabilities: () => ({ zoom: { min: 1, max: 5 } }) as MediaTrackCapabilities,
        getSettings: () => ({ zoom: 1 }) as MediaTrackSettings,
        applyConstraints,
      } as Partial<MediaStreamTrack>),
    );
    installSrcObject();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(<CamHarness />);
    await waitFor(() => expect(screen.getByTestId('cam-state')).toHaveTextContent('live'));
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it('a camera with no zoom capability still goes live', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    installMediaDevices(
      fakeStream({ getCapabilities: () => ({}) as MediaTrackCapabilities }),
    );
    installSrcObject();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    render(<CamHarness />);
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
