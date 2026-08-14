// Capture flow (roadmap 4): camera → snap → location sheet → marker editor →
// save (photo+thumb parallel, crops, embeddings behind a 15s model-load race).
// The camera stage also runs the scan loop, so QR stickers seen while framing
// resolve through the code registry (link/conflict sheets).
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import LocationPicker from '../components/LocationPicker';
import { CameraView } from '../components/camera/CameraView';
import { CodeSheet } from '../components/camera/CodeSheets';
import { MarkerEditor, type EditorMarker } from '../components/camera/MarkerEditor';
import { useCamera } from '../components/camera/useCamera';
import { useLocationScope } from '../state/LocationContext';
import { saveCapture } from '../vision/capturePipeline';
import { listCaptures, type CaptureRow } from '../vision/captureStore';
import { useScanLoop } from '../vision/scanLoop';
import { describeEntry } from '../vision/codes';
import type { GeoFix } from '../api/types';
import '../components/camera/camera.css';

type Stage = 'camera' | 'location' | 'markers' | 'saving' | 'saved';

const HINT_COPY: Record<string, string> = {
  dark: 'Too dark — find more light',
  blur: 'Hold steady — image is blurry',
  moving: 'Hold still…',
};

/** Best-effort geolocation — indoors this is usually absent; null is normal. */
function sampleGeo(): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation?.getCurrentPosition) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), 3000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: Date.now(),
        });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { maximumAge: 60_000, timeout: 2500 },
    );
  });
}

export default function CaptureScreen() {
  const { scope, names } = useLocationScope();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<Stage>('camera');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [markers, setMarkers] = useState<EditorMarker[]>([]);
  const [savedRow, setSavedRow] = useState<CaptureRow | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const camera = useCamera(stage === 'camera');
  const scan = useScanLoop({ camera, siteId: scope.siteId, enabled: stage === 'camera' });

  // QR lane: each fresh hit resolves through the registry sheet flow.
  const [sheetCode, setSheetCode] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastHitAt = useRef(0);
  useEffect(() => {
    if (!scan.qrHit || scan.qrHit.at === lastHitAt.current) return;
    lastHitAt.current = scan.qrHit.at;
    setSheetCode(scan.qrHit.code);
  }, [scan.qrHit]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Object URLs are session junk: revoke on replace/unmount, never persist.
  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  const snap = async () => {
    const blob = await camera.snap();
    if (!blob) return;
    setPhoto(blob);
    setPhotoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
    setSpaceName(names.floor ?? names.building ?? names.site ?? '');
    setMarkers([]);
    setStage('location');
    void sampleGeo().then(setGeo);
  };

  const save = async () => {
    if (!photo) return;
    setStage('saving');
    setSaveError(null);
    try {
      const row = await saveCapture({
        photo,
        markers: markers
          .filter((m) => m.assetId !== undefined)
          .map((m) => ({ assetId: m.assetId as number, rect: m.rect })),
        siteId: scope.siteId,
        spaceName: spaceName.trim() || undefined,
        geo,
      });
      setSavedRow(row);
      await queryClient.invalidateQueries({ queryKey: ['captures'] });
      setStage('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setStage('markers');
    }
  };

  const reset = () => {
    setPhoto(null);
    setPhotoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setMarkers([]);
    setSavedRow(null);
    setSaveError(null);
    setGeo(null);
    setStage('camera');
  };

  const unassigned = markers.filter((m) => m.assetId === undefined).length;

  return (
    <div className="fv-capture">
      {stage === 'camera' && (
        <div className="fv-capture-cam">
          <CameraView
            videoRef={camera.videoRef}
            frameCanvasRef={camera.frameCanvasRef}
            state={camera.state}
            onResume={() => void camera.resume()}
          >
            {scan.hint && <div className="fv-hint-chip">{HINT_COPY[scan.hint] ?? scan.hint}</div>}
            {toast && <div className="fv-qr-toast">{toast}</div>}
            <button
              className="fv-shutter"
              aria-label="Take photo"
              disabled={camera.state !== 'live'}
              onClick={() => void snap()}
            />
          </CameraView>
        </div>
      )}

      {stage === 'location' && (
        <div className="fv-capture-panel">
          <h3>Where was this taken?</h3>
          {photoUrl && <img className="fv-capture-preview" src={photoUrl} alt="Captured frame" />}
          <LocationPicker />
          <label className="fv-field-label">
            Space / room name
            <input
              value={spaceName}
              placeholder="e.g. Server Room"
              onChange={(e) => setSpaceName(e.target.value)}
            />
          </label>
          <div className="fv-capture-actions">
            <button className="fv-btn-secondary" onClick={reset}>
              Retake
            </button>
            <button className="fv-btn-primary" onClick={() => setStage('markers')}>
              Continue to markers
            </button>
          </div>
        </div>
      )}

      {(stage === 'markers' || stage === 'saving') && photoUrl && (
        <div className="fv-capture-panel">
          <h3>Mark the assets</h3>
          {saveError && <p className="error">Save failed: {saveError}</p>}
          <MarkerEditor
            photoUrl={photoUrl}
            markers={markers}
            onChange={setMarkers}
            siteId={scope.siteId}
          />
          <div className="fv-capture-actions">
            <button className="fv-btn-secondary" disabled={stage === 'saving'} onClick={() => setStage('location')}>
              Back
            </button>
            <button
              className="fv-btn-primary"
              disabled={stage === 'saving' || unassigned > 0}
              onClick={() => void save()}
            >
              {stage === 'saving'
                ? 'Saving…'
                : unassigned > 0
                  ? `Assign ${unassigned} marker${unassigned > 1 ? 's' : ''} first`
                  : markers.length === 0
                    ? 'Save photo (no markers)'
                    : `Save capture (${markers.length} marker${markers.length > 1 ? 's' : ''})`}
            </button>
          </div>
        </div>
      )}

      {stage === 'saved' && savedRow && (
        <div className="fv-capture-panel">
          <h3>Capture saved</h3>
          <p>
            {savedRow.markers.length} marker{savedRow.markers.length === 1 ? '' : 's'}
            {savedRow.spaceName ? ` in ${savedRow.spaceName}` : ''}.
          </p>
          {savedRow.embeddingStatus === 'pending' && (
            <p className="muted">
              AI indexing is still pending — the model didn’t load in time. The photo and markers
              are safe; recognition vectors can be built later.
            </p>
          )}
          <div className="fv-capture-actions">
            <button className="fv-btn-primary" onClick={reset}>
              New capture
            </button>
          </div>
        </div>
      )}

      {sheetCode && (
        <CodeSheet
          code={sheetCode}
          siteId={scope.siteId}
          onClose={() => setSheetCode(null)}
          onLinked={(entry) => setToast(`QR linked: ${describeEntry(entry)}`)}
        />
      )}
    </div>
  );
}

/** Shared list hook so Rooms and future consumers use one cache key. */
export function useCaptures() {
  return useQuery({
    queryKey: ['captures'],
    queryFn: () => listCaptures(),
  });
}
