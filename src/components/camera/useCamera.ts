// Lifted from asset-lens/src/components/camera/useCamera.ts. Load-bearing
// mechanics preserved verbatim: hosted-webview detection, the ImageCapture
// grabFrame bypass (NEVER video.play() inside the Facilio webview), muted/
// playsInline as PROPERTIES before srcObject+play, the starting|live|paused|
// unavailable state machine, gesture-gated resume, 1280x720-in-webview vs
// 1920x1080-in-browser, and the 3s grabFrame watchdog → paused.
// One adaptation: hosted detection is a FUNCTION evaluated when the camera
// starts (not a module-load const), so ?capp_id set after import still counts.
import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'starting' | 'live' | 'paused' | 'unavailable';

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
        // blit), so ask for a lighter stream there; Safari keeps 1080p.
        const ideal = HOSTED_WEBVIEW
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', ...ideal },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
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
          video.onpause = () => {
            // iOS pauses inline camera video without a gesture → native ▶ chrome
            if (streamRef.current) setState('paused');
          };
          try {
            await video.play();
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
  }, [enabled]);

  /** Resume a webview-paused stream — must run inside a user gesture. */
  const resume = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      setState('live');
    } catch {
      setState('unavailable');
    }
  }, []);

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

  return { videoRef, frameCanvasRef, state, snap, resume };
}

export type CameraHandle = ReturnType<typeof useCamera>;

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
