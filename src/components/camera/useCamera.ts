// Lifted from asset-lens/src/components/camera/useCamera.ts. Load-bearing
// mechanics preserved verbatim: hosted-webview detection, the ImageCapture
// grabFrame bypass (NEVER video.play() inside the Facilio webview), muted/
// playsInline as PROPERTIES before srcObject+play, the starting|live|paused|
// unavailable state machine, gesture-gated resume, 1280x720-in-webview vs
// 1920x1080-in-browser, and the 3s grabFrame watchdog → paused.
// One adaptation: hosted detection is a FUNCTION evaluated when the camera
// starts (not a module-load const), so ?capp_id set after import still counts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { setCameraGeometry } from '../../ar/fovCal';

export type CameraState = 'starting' | 'live' | 'paused' | 'unavailable';

/** Dimensions of the frame the camera is actually delivering, sensor-oriented.
 * The AR projection needs this and CANNOT read it off the video element in the
 * hosted webview, where the video never plays and videoWidth stays 0. */
export interface FrameSize {
  w: number;
  h: number;
}

/** Facilio-app webview: inline <video> playback is disabled at the host level
 * (play() hijacks into the native fullscreen player, hidden or not). */
export function isHostedWebview(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.self !== window.top ||
      new URLSearchParams(window.location.search).has('capp_id') ||
      new URLSearchParams(window.location.search).has('origin'))
  );
}

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}

interface ZoomCapability {
  min: number;
  max: number;
}

/** `zoom` and `resizeMode` are real constraints that TypeScript's DOM lib does
 * not model yet (both are Media Capture extensions). Typed here rather than
 * cast at each call site, so a wrong shape is still a compile error. */
type ExtendedVideoConstraints = MediaTrackConstraints & {
  resizeMode?: 'none' | 'crop-and-scale';
  advanced?: Array<MediaTrackConstraintSet & { zoom?: number }>;
};

/**
 * Undo the digital zoom the platform applied before we ever saw the stream.
 *
 * iPadOS hands back a rear camera already zoomed in — every degree of hand
 * tremor then covers several times more of the screen, which is the "very
 * shaky" the field reported, and the narrowed field of view silently breaks
 * the AR projection, which assumes it is looking through the whole lens.
 *
 * Target is exactly 1.0: no digital crop. Deliberately never the capability
 * MINIMUM — on multi-camera devices that is 0.5, which switches to the
 * ultra-wide, whose barrel distortion the pinhole projection cannot model.
 */
async function resetZoom(track: MediaStreamTrack): Promise<void> {
  try {
    const caps = track.getCapabilities?.() as { zoom?: ZoomCapability } | undefined;
    const zoom = caps?.zoom;
    if (!zoom || typeof zoom.min !== 'number' || typeof zoom.max !== 'number') return;
    const settings = track.getSettings?.() as { zoom?: number } | undefined;
    const target = Math.min(Math.max(1, zoom.min), zoom.max);
    if (settings?.zoom != null && Math.abs(settings.zoom - target) < 0.01) return;
    await track.applyConstraints({ advanced: [{ zoom: target }] } as ExtendedVideoConstraints);
  } catch {
    /* zoom is unsupported on this device — the stream is still usable */
  }
}

/**
 * Rear-camera lifecycle: getUserMedia environment camera onto a playsInline
 * video, four-state status, full track cleanup on unmount. Mock mode renders
 * no stream — the caller substitutes a static image.
 */
export function useCamera(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** hosted-webview path: frames pulled via ImageCapture, no playing video */
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<CameraState>('starting');
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);

  // One place decides the frame geometry is known, so the FOV calibration is
  // always re-checked against it (a calibration learned through a zoomed lens
  // must not outlive the zoom fix).
  const publishFrameSize = useCallback((w: number, h: number) => {
    if (!w || !h) return;
    setCameraGeometry(w, h);
    setFrameSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable');
      return;
    }
    let cancelled = false;
    setState('starting');
    const HOSTED_WEBVIEW = isHostedWebview();
    void (async () => {
      try {
        // The Facilio webview pays for every pixel twice (grabFrame + mirror
        // blit), so ask for a lighter stream there; Safari keeps the bigger one.
        //
        // Sizes are 4:3, not 16:9. Asking a 4:3 sensor for 16:9 does not widen
        // the view — the platform CROPS the sensor to make the shape, and the
        // cover-fit crop to a portrait screen then crops again. Two crops is
        // the zoomed, shaky view iPad users get, and the projection has no way
        // to know a sensor crop happened, so every marker drifts as well.
        // `resizeMode: 'none'` is the other half: it forbids the UA from
        // manufacturing a format by cropping/scaling, so we get a real one.
        const ideal = HOSTED_WEBVIEW
          ? { width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } }
          : { width: { ideal: 1600 }, height: { ideal: 1200 } };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            aspectRatio: { ideal: 4 / 3 },
            resizeMode: 'none',
            ...ideal,
          } as ExtendedVideoConstraints,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (track) await resetZoom(track);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Hosted webview + ImageCapture: bypass the video element entirely —
        // grabFrame() reads the camera track directly, no play(), no hijack.
        const IC = (
          window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }
        ).ImageCapture;
        if (HOSTED_WEBVIEW && IC) {
          try {
            const cap = new IC(stream.getVideoTracks()[0]);
            const canvas = document.createElement('canvas');
            frameCanvasRef.current = canvas;
            const ctx = canvas.getContext('2d')!;
            let ok = false;
            const loop = async () => {
              while (streamRef.current && !cancelled) {
                try {
                  const bmp = await cap.grabFrame();
                  // bound the working surface — a 1080p blit per frame is what
                  // made the embedded view crawl
                  const k = Math.min(1, 960 / Math.max(bmp.width, bmp.height));
                  const w = Math.round(bmp.width * k);
                  const h = Math.round(bmp.height * k);
                  if (canvas.width !== w) {
                    canvas.width = w;
                    canvas.height = h;
                  }
                  ctx.drawImage(bmp, 0, 0, w, h);
                  // The projection's only route to the real frame shape on
                  // this path: the video element never plays here, so its
                  // videoWidth stays 0 and the FOV would fall back to a
                  // made-up default.
                  publishFrameSize(bmp.width, bmp.height);
                  bmp.close();
                  if (!ok) {
                    ok = true;
                    setState('live');
                  }
                } catch {
                  /* transient grab failure */
                }
                await new Promise((r) => setTimeout(r, 100));
              }
            };
            void loop();
            setTimeout(() => {
              if (!ok && !cancelled) setState('paused'); // grabFrame never delivered — fall back
            }, 3000);
            return;
          } catch {
            /* fall through to the video path */
          }
        }
        const video = videoRef.current;
        if (video) {
          // Webview autoplay policies (Facilio app's WKWebView) require these
          // to be set as PROPERTIES before play(), not just attributes.
          video.muted = true;
          video.playsInline = true;
          video.setAttribute('webkit-playsinline', '');
          video.setAttribute('disablepictureinpicture', '');
          video.srcObject = stream;
          const onMeta = () => publishFrameSize(video.videoWidth, video.videoHeight);
          video.addEventListener('loadedmetadata', onMeta);
          video.onpause = () => {
            // iOS pauses inline camera video without a gesture → native ▶ chrome
            if (streamRef.current) setState('paused');
          };
          try {
            await video.play();
            publishFrameSize(video.videoWidth, video.videoHeight);
            setState('live');
          } catch {
            // blocked without a user gesture — surface tap-to-start
            setState('paused');
          }
        } else {
          setState('live');
        }
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [enabled, publishFrameSize]);

  /** Resume a webview-paused stream — must run inside a user gesture. */
  const resume = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      publishFrameSize(video.videoWidth, video.videoHeight);
      setState('live');
    } catch {
      setState('unavailable');
    }
  }, [publishFrameSize]);

  /** Full-resolution JPEG snapshot of the current frame. */
  const snap = useCallback(async (maxEdge = 1600, quality = 0.8): Promise<Blob | null> => {
    const fc = frameCanvasRef.current;
    const src: CanvasImageSource | null =
      fc && fc.width
        ? fc
        : videoRef.current && videoRef.current.readyState >= 2
          ? videoRef.current
          : null;
    if (!src) return null;
    const sw = fc && fc.width ? fc.width : videoRef.current!.videoWidth;
    const sh = fc && fc.width ? fc.height : videoRef.current!.videoHeight;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }, []);

  return { videoRef, frameCanvasRef, state, frameSize, snap, resume };
}

export type CameraHandle = ReturnType<typeof useCamera>;

let warmed = false;

/**
 * Learn the camera's frame geometry at APP LOAD, so the AR projection is
 * correct on the very first frame instead of on the first frame AFTER the
 * camera reports itself.
 *
 * Strictly prompt-free: it opens a stream ONLY when the permission is already
 * granted, and closes it immediately. Asking for the camera on load — on the
 * Estate tab, say, where there is no camera surface at all — would be a
 * permission prompt for nothing, and a denial there costs the AR tab its
 * camera for the whole session.
 */
export async function warmCameraGeometry(): Promise<void> {
  if (warmed || typeof navigator === 'undefined') return;
  warmed = true;
  try {
    const perms = (navigator as { permissions?: Permissions }).permissions;
    if (!perms?.query || !navigator.mediaDevices?.getUserMedia) return;
    const status = await perms.query({ name: 'camera' as PermissionName });
    if (status.state !== 'granted') return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', aspectRatio: { ideal: 4 / 3 }, resizeMode: 'none' } as ExtendedVideoConstraints,
      audio: false,
    });
    try {
      const track = stream.getVideoTracks()[0];
      if (track) {
        await resetZoom(track);
        const s = track.getSettings?.();
        if (s?.width && s?.height) setCameraGeometry(s.width, s.height);
      }
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch {
    /* no permissions API, or the probe failed — the live camera warms it */
  }
}

/** TEST ONLY. */
export function __resetCameraWarmForTest(): void {
  warmed = false;
}

/** Downscale a blob to a JPEG thumbnail. */
export async function makeThumb(blob: Blob, maxEdge = 320, quality = 0.7): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('thumb failed'))), 'image/jpeg', quality),
  );
}

/** Crop a normalized rect out of a blob as a JPEG (reference crops, 256px). */
export async function cropBlob(
  blob: Blob,
  rect: { x: number; y: number; w: number; h: number },
  outEdge = 256,
): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const sx = Math.round(rect.x * bmp.width);
  const sy = Math.round(rect.y * bmp.height);
  const sw = Math.max(1, Math.round(rect.w * bmp.width));
  const sh = Math.max(1, Math.round(rect.h * bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = outEdge;
  canvas.height = outEdge;
  canvas.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, outEdge, outEdge);
  bmp.close();
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('crop failed'))), 'image/jpeg', 0.85),
  );
}
