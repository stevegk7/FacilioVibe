// Lifted from asset-lens/src/components/camera/CameraView.tsx (class names
// moved to fv-cam*, fallback URL → facilio-vision, unavailable copy embed-aware).
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { isHostedWebview, type CameraState } from './useCamera';
import './camera.css';

const BROWSER_URL = 'https://facilio-vision.vibe.facilio.com';

/**
 * Full-bleed rear-camera surface. Overlay children render above the feed.
 * In mock mode (or when the camera is unavailable) a message or a still
 * image stands in so flows stay testable on desktop.
 *
 * Inside the Facilio app's webview, inline video playback is disabled at the
 * host level — playing a visible <video> hijacks into the native fullscreen
 * player. Mirror frames onto a canvas instead and keep the video hidden.
 */
export function CameraView(props: {
  videoRef: RefObject<HTMLVideoElement>;
  frameCanvasRef?: { current: HTMLCanvasElement | null };
  state: CameraState;
  stillUrl?: string;
  onResume?: () => void;
  children?: ReactNode;
}) {
  const { videoRef, frameCanvasRef, state, stillUrl, onResume, children } = props;
  const hosted = isHostedWebview();
  return (
    <div className="fv-cam">
      {stillUrl ? (
        <img className="fv-cam-still" src={stillUrl} alt="" />
      ) : hosted ? (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{
              position: 'absolute',
              width: 2,
              height: 2,
              opacity: 0.01,
              pointerEvents: 'none',
              left: 0,
              top: 0,
            }}
          />
          <CanvasMirror videoRef={videoRef} frameCanvasRef={frameCanvasRef} active={state === 'live'} />
        </>
      ) : (
        <video ref={videoRef} playsInline muted autoPlay />
      )}
      {!stillUrl && state === 'starting' && <div className="fv-cam-msg">Starting camera…</div>}
      {!stillUrl && state === 'paused' && (
        <button className="fv-cam-resume" onClick={onResume}>
          <span className="fv-cam-resume-inner">
            <span className="fv-cam-resume-play">▶</span>
            Tap to start the camera
            <span
              className="fv-cam-resume-alt"
              onClick={(e) => {
                e.stopPropagation();
                window.open(BROWSER_URL, '_blank', 'noopener');
              }}
            >
              or open the full app in the browser ↗
            </span>
          </span>
        </button>
      )}
      {!stillUrl && state === 'unavailable' && (
        <div className="fv-cam-msg">
          <div className="fv-cam-unavailable">
            <span>
              Camera unavailable here.
              <br />
              {hosted
                ? 'The Facilio app hasn’t granted camera access to embedded pages yet.'
                : 'Allow camera access in the browser, or use manual pick.'}
            </span>
            <button className="fv-cam-open-browser" onClick={() => window.open(BROWSER_URL, '_blank', 'noopener')}>
              Open full app in browser ↗
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function CanvasMirror({
  videoRef,
  frameCanvasRef,
  active,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  frameCanvasRef?: { current: HTMLCanvasElement | null };
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const ctxRef = { c: null as CanvasRenderingContext2D | null };
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      // the mirror only needs to look live — 30fps halves the blit cost, and
      // drawing at DISPLAY size (not source size) is what keeps it smooth
      if (t - last < 33) return;
      last = t;
      const fc = frameCanvasRef?.current;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const src: CanvasImageSource | null =
        fc && fc.width ? fc : video && video.readyState >= 2 && video.videoWidth ? video : null;
      if (!src || !canvas) return;
      const sw = fc && fc.width ? fc.width : video!.videoWidth;
      const sh = fc && fc.width ? fc.height : video!.videoHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const dw = Math.round(canvas.clientWidth * dpr);
      const dh = Math.round(canvas.clientHeight * dpr);
      if (!dw || !dh) return;
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw;
        canvas.height = dh;
        ctxRef.c = null;
      }
      ctxRef.c ??= canvas.getContext('2d', { alpha: false });
      const ctx = ctxRef.c;
      if (!ctx) return;
      // object-fit: cover, computed on the source
      const scale = Math.max(dw / sw, dh / sh);
      const w = sw * scale;
      const h = sh * scale;
      ctx.drawImage(src, (dw - w) / 2, (dh - h) / 2, w, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, videoRef, frameCanvasRef]);
  return <canvas ref={canvasRef} className="fv-cam-mirror" />;
}
