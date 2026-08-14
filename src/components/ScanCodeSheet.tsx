/**
 * Scan-a-code bottom sheet: live camera decode with a typed fallback.
 *
 * The Wayfinder's positioning model is "you are where you last scanned", and
 * the old screen made that a TYPING exercise — a technician squinting at a
 * sticker to copy `fv-sv-abc123` by hand. The camera is the scanner
 * everywhere else in this app (AR, surveys); position claims deserve the same
 * ergonomics. Camera fails (desktop, denied, webview without flags) → the
 * typed lane is right there, not behind another tap.
 */
import { useEffect, useState } from 'react';
import { isMockMode } from '../api/provider';
import { CameraView } from './camera/CameraView';
import { useCamera } from './camera/useCamera';
import { decodeQr } from '../vision/qr';
import Sheet from './Sheet';

export default function ScanCodeSheet({
  open,
  title = 'Where are you?',
  help,
  onClose,
  onCode,
}: {
  open: boolean;
  title?: string;
  help?: string;
  onClose(): void;
  /** Fires once per decoded/typed code; the caller decides what it means. */
  onCode(code: string): void;
}) {
  const mock = isMockMode();
  const camera = useCamera(open && !mock);
  const [typed, setTyped] = useState('');

  // Continuous decode off the live frame — the camera IS the scanner; walking
  // up to the sticker is the whole interaction. (Pattern from PlaceAssets.)
  useEffect(() => {
    if (!open || mock) return;
    const work = document.createElement('canvas');
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const fc = camera.frameCanvasRef.current;
      const video = camera.videoRef.current;
      const src: CanvasImageSource | null =
        fc && fc.width ? fc : video && video.readyState >= 2 && video.videoWidth ? video : null;
      if (!src) return;
      const w = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLCanvasElement).width;
      const h = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLCanvasElement).height;
      if (!w || !h) return;
      busy = true;
      void decodeQr(src, w, h, work)
        .then((hit) => {
          if (hit?.data) onCode(hit.data);
        })
        .finally(() => {
          busy = false;
        });
    }, 400);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mock, camera.state]);

  const submitTyped = () => {
    const code = typed.trim();
    if (!code) return;
    setTyped('');
    onCode(code);
  };

  if (!open) return null;

  return (
    <Sheet
      open
      title={title}
      onClose={onClose}
      footer={
        <button className="btn-cta" disabled={!typed.trim()} onClick={submitTyped}>
          Use typed code
        </button>
      }
    >
      {help && <p className="sv-help" style={{ marginTop: 0 }}>{help}</p>}
      {!mock && (
        <div className="scs-camera">
          <CameraView
            videoRef={camera.videoRef}
            frameCanvasRef={camera.frameCanvasRef}
            state={camera.state}
            onResume={() => void camera.resume()}
          />
          <div className="pa-scanframe scs-frame" aria-hidden="true">
            <span className="tl" />
            <span className="tr" />
            <span className="bl" />
            <span className="br" />
          </div>
        </div>
      )}
      <label className="sv-field">
        <span className="sv-field-label">{mock ? 'Code' : 'No camera? Type the code'}</span>
        <input
          className="sv-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitTyped();
          }}
          placeholder="e.g. fv-sv-demo-lobby"
        />
      </label>
    </Sheet>
  );
}
