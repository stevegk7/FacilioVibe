// Survey authoring (roadmap phase 5): full-screen overlay opened from the
// Surveys tab. Setup → guided 360° sweep → optional standpoint-QR enrolment
// → crosshair marker placement → save to appStore KV 'surveys'.
//
// Camera: the live feed comes from src/components/camera (WS-A). Sweep frames
// are embedded off that feed; with no camera (desktop/?mock=1) they fall back
// to the deterministic synthetic embedding — the survey geometry (headings,
// markers, Δ math) is real either way.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { appStore } from '../api/appStore';
import { isMockMode } from '../api/provider';
import type { Asset, Survey, SurveyMarker, SweepFrame } from '../api/types';
import { getEmbedFn, syntheticVec, EMBED_MODEL_ID } from '../ar/embedding';
import { draftBearing } from '../wayfinding/bearingDraft';
import { ArCard, ArSpace, setArPoseDelay, setArVideoSource } from '../ar/ArSpace';
import { AssetTag, NoteTag } from '../ar/markers';
import AssetSelect from '../components/AssetSelect';
import DsSelect from '../components/DsSelect';
import Sheet from '../components/Sheet';
import { CameraView } from '../components/camera/CameraView';
import { useCamera } from '../components/camera/useCamera';
import { linkCode, resolveCode } from '../vision/codes';
import { decodeQr } from '../vision/qr';
import { CAMERA_LONG_AXIS_FOV_DEG, captureFov, qrAngularOffset } from '../ar/projection';
import { longAxisFovDeg } from '../ar/fovCal';
import { columnProfile } from '../ar/imageShift';
import { useGeoFix } from '../hooks/useGeoFix';
import { enableArOrientation, holdYawOffset, placementOrientation, poseSpeedDegS, useHeading } from '../hooks/useHeading';
import { wrap } from '../wayfinding/bearing';
import { useLocationScope } from '../state/LocationContext';
import '../styles/ar.css';
import '../ar/arspace.css';
import './surveys.css';

/** Test/integration seam: overrides the camera as the sweep-frame source. */
let sweepFrameSource: (() => CanvasImageSource | null) | null = null;
export function setSweepFrameSource(fn: (() => CanvasImageSource | null) | null): void {
  sweepFrameSource = fn;
}

const MAX_FRAMES = 12;
/** Enough frames to relocalize from: 8 live, 4 in mock (no sensors to sweep). */
function minFrames(): number {
  return isMockMode() ? 4 : 8;
}
/** Auto-capture cadence: one frame every ~30° of heading change. */
const CAPTURE_STEP_DEG = 28;

/**
 * Name it -> SCAN THE STANDPOINT QR -> slow 360° sweep -> place markers.
 *
 * The QR is now the FIRST capture and it is mandatory: it is the survey's
 * origin. Everything else — every marker, every sweep frame — is stored
 * relative to the direction of that code, and every later visit re-derives
 * the exact frame by scanning the same code (Δ = bearing-of-code-now −
 * bearing-of-code-at-enrolment). That is what makes markers land on the same
 * physical spots on load, on any device, whatever its compass thinks north
 * is. A survey without a code has no origin to re-find — which is exactly
 * the "notes load in the centre" report this replaces.
 *
 * The camera is full-bleed on every step and NOTHING covers it: chrome is
 * floating pills over the feed, and the app dock stays visible beneath.
 */
type Step = 'setup' | 'qr' | 'sweep' | 'markers';

/** Sweep pace gates (deg/s): capture only below CAPTURE, warn above WARN.
 * A frame grabbed mid-swing is motion-blurred and its embedding matches
 * nothing later — a slow sweep IS the accuracy. */
const SWEEP_CAPTURE_MAX_DEG_S = 25;
const SWEEP_WARN_DEG_S = 35;

/** What a marker stands for. Work orders and findings are raised in place. */
export type MarkerKind = 'asset' | 'note' | 'workorder' | 'finding';

interface MarkerDraft {
  rel: number;
  pitch: number;
  /** Chosen by the footer button, so the form opens on the right mode. */
  kind: MarkerKind;
  /** False when the compass was silent — the form then asks for the direction. */
  bearingKnown: boolean;
}

let markerSeq = 0;

export default function PlaceAssetsScreen({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: (surveyId: string) => void;
}) {
  const mock = isMockMode();
  const queryClient = useQueryClient();
  const { scope, names } = useLocationScope();
  const scopeLabel = names.floor ?? names.building ?? names.site ?? '';
  const getFix = useGeoFix(true);
  const pose = useHeading(150);

  const [step, setStep] = useState<Step>('setup');
  const [name, setName] = useState('');
  const [frames, setFrames] = useState<SweepFrame[]>([]);
  const [markers, setMarkers] = useState<SurveyMarker[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Mock stand-in for the device heading: rotated by explicit buttons.
  const [mockHeading, setMockHeading] = useState(0);
  const [markerForm, setMarkerForm] = useState<MarkerDraft | null>(null);
  /** The mandatory standpoint code — the survey's origin. */
  const [qrCode, setQrCode] = useState<string | null>(null);
  /** Bearing OF THE CODE at enrolment (corner-corrected when scanned). */
  const [qrHeading, setQrHeading] = useState<number | undefined>(undefined);
  const [typedCode, setTypedCode] = useState('');
  /** Live sweep pace (deg/s), sampled for the pace pill. */
  const [sweepSpeed, setSweepSpeed] = useState(0);
  /** Sweep-frame JPEGs by frame index, uploaded at save. */
  const shotsRef = useRef<Record<number, Blob>>({});
  const busyRef = useRef(false);

  // Existing surveys — a code must identify exactly ONE standpoint, so the
  // scan step refuses one that is already someone else's origin.
  const surveysQuery = useQuery({
    queryKey: ['surveys'],
    queryFn: () =>
      appStore
        .kvList<Survey>('surveys', 'survey.', 200)
        .then((rows) => rows.map((r) => r.value).filter((s) => s && Array.isArray(s.markers))),
  });

  // Camera-first: the live feed runs from the moment the overlay opens — the
  // setup sheet sits OVER the lens instead of hiding it behind a form.
  const camera = useCamera(true);
  const cameraFrame = (): CanvasImageSource | null => {
    const fc = camera.frameCanvasRef.current;
    if (fc && fc.width) return fc;
    const video = camera.videoRef.current;
    return video && video.readyState >= 2 && video.videoWidth ? video : null;
  };

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 3600);
    return () => clearTimeout(t);
  }, [hint]);

  /**
   * null means "the compass is not answering" — NEVER 0.
   *
   * Returning 0 silently gave every marker the same bearing whenever motion
   * access was denied or absent (desktop, or iOS before the permission
   * prompt), so notes stacked on one point AND were saved that way. A wrong
   * bearing that looks placed is worse than no bearing at all.
   */
  // Placement reads the MEDIAN of the last ~600ms, not one instant: a marker
  // is written once and lives forever, so an outlier at the moment of the tap
  // is permanent. The live overlay keeps using the un-medianed value.
  const currentHeading = (): number | null => {
    if (mock) return mockHeading;
    return placementOrientation()?.heading ?? null;
  };
  const currentPitch = (): number | null => {
    if (mock) return 0;
    return placementOrientation()?.pitch ?? null;
  };

  // The stage stops where the dock begins, so the dock stays visible (design)
  // and the footer is never covered. The marker keeps tests honest about which
  // surface owns the screen.
  useEffect(() => {
    document.body.classList.add('pa-open');
    return () => document.body.classList.remove('pa-open');
  }, []);

  // ONE frame per survey: from the moment the origin is being captured until
  // the overlay closes, the compass may not move the world frame. qrHeading,
  // every sweep frame and every marker must be written against the SAME
  // frame — a mid-authoring compass correction (or a 35° snap in a steel
  // plant room) would silently split the survey into two frames and nothing
  // could ever line it up again.
  useEffect(() => {
    if (step !== 'setup') holdYawOffset(true);
    return () => holdYawOffset(false);
  }, [step]);

  // Authoring must render markers through the SAME projection the AR screen
  // will use — the FOV comes from the real video, the pose from the frame's
  // age. Otherwise a card sits one place while placing and another on load.
  useEffect(() => {
    if (camera.state === 'live') {
      setArVideoSource(camera.videoRef.current);
      setArPoseDelay(90);
    } else {
      setArVideoSource(null);
      setArPoseDelay(0);
    }
    return () => {
      setArVideoSource(null);
      setArPoseDelay(0);
    };
  }, [camera.state, camera.videoRef]);

  /**
   * Accept a code as this survey's origin. The heading captured here is the
   * bearing OF THE CODE (aim + its in-frame angular offset when scanned) —
   * scanning it on a later visit yields Δ exactly, which is what puts every
   * marker back on its physical spot.
   */
  const acceptCode = (code: string, offYawDeg = 0): void => {
    const clean = code.trim();
    if (!clean) return;
    const taken = (surveysQuery.data ?? []).find((sv) => sv.qrCode === clean);
    if (taken) {
      setHint(`That code is already the origin of “${taken.name}” — one code, one standpoint`);
      return;
    }
    void (async () => {
      const res = await resolveCode(clean);
      if (res.kind === 'target' && res.entry.type !== 'survey') {
        setHint(`That code points at ${res.entry.type === 'asset' ? 'an asset' : 'a space'} — use a fresh sticker for the standpoint`);
        return;
      }
      const aim = mock ? { heading: mockHeading } : placementOrientation();
      setQrCode(clean);
      setQrHeading(aim ? (aim.heading + offYawDeg + 360) % 360 : undefined);
      if (!aim && !mock) {
        setHint('Code locked, but no compass — markers will rely on scanning this code');
      }
      setStep('sweep');
    })();
  };

  // Step 'qr': continuously decode the live frame. The camera IS the scanner —
  // no separate mode, no shutter, walking up to the sticker is the interaction.
  useEffect(() => {
    if (step !== 'qr' || mock) return;
    const work = document.createElement('canvas');
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const src = cameraFrame();
      if (!src) return;
      const w = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLCanvasElement).width;
      const h = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLCanvasElement).height;
      if (!w || !h) return;
      busy = true;
      void decodeQr(src, w, h, work)
        .then((hit) => {
          if (!hit) return;
          const off = hit.corners
            ? qrAngularOffset(
                hit.corners,
                hit.frameW,
                hit.frameH,
                captureFov(hit.frameW, hit.frameH, longAxisFovDeg(CAMERA_LONG_AXIS_FOV_DEG)),
              )
            : null;
          acceptCode(hit.data, off?.yawDeg ?? 0);
        })
        .finally(() => {
          busy = false;
        });
    }, 400);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mock, surveysQuery.data]);

  // Step 'sweep': sample the rotation pace for the pace pill.
  useEffect(() => {
    if (step !== 'sweep' || mock) return;
    const t = setInterval(() => setSweepSpeed(poseSpeedDegS()), 250);
    return () => clearInterval(t);
  }, [step, mock]);

  const captureFrame = async (heading: number, pitch: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const src = sweepFrameSource?.() ?? cameraFrame();
      const vec = src ? await getEmbedFn()(src) : syntheticVec(heading);

      // The frame's column profile rides along (64 numbers): it is what lets
      // a later visit measure its rotation WITHIN this frame instead of
      // rounding Δ to the frame grid.
      let profile: number[] | undefined;
      if (src) {
        try {
          const w = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLCanvasElement).width;
          const h = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLCanvasElement).height;
          if (w && h) {
            const work = document.createElement('canvas');
            profile = Array.from(columnProfile(src, w, h, work), (v) => Math.round(v * 10) / 10);
          }
        } catch {
          /* a frame without a profile still relocalizes coarsely */
        }
      }

      // Keep the frame's PICTURE too, not just its embedding. Held in memory
      // and uploaded at save, so abandoning a sweep costs no uploads and the
      // sweep itself stays responsive.
      let shot: Blob | null = null;
      try {
        shot = await camera.snap(640, 0.6);
      } catch {
        /* a frame without a photo still recognises the room */
      }

      setFrames((prev) => {
        if (prev.length >= MAX_FRAMES) return prev;
        if (shot) shotsRef.current[prev.length] = shot;
        return [...prev, { heading, pitch, vec, profile }];
      });
    } finally {
      busyRef.current = false;
    }
  };

  // Live guided sweep: auto-capture a frame every ~30° of heading change —
  // but ONLY while the rotation is slow. A frame grabbed mid-swing is blurred
  // and its embedding never matches again; refusing it makes the technician
  // slow down, which is the entire point of the pace UI.
  useEffect(() => {
    if (step !== 'sweep' || mock) return;
    if (!pose.ok || frames.length >= MAX_FRAMES) return;
    if (poseSpeedDegS() > SWEEP_CAPTURE_MAX_DEG_S) return;
    const last = frames[frames.length - 1];
    if (!last || Math.abs(wrap(pose.heading - last.heading)) >= CAPTURE_STEP_DEG) {
      void captureFrame(pose.heading, pose.pitch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mock, pose, frames]);


  const placeMarkerHere = (kind: MarkerKind) => {
    // Direction FROZEN AT THE MOMENT OF THE TAP so the phone can be lowered
    // to type. Stored relative to sweep frame 0.
    const base = frames[0]?.heading ?? 0;
    const heading = currentHeading();
    const pitch = currentPitch();

    const { rel, bearingKnown } = draftBearing({
      heading,
      sweepBase: base,
      markerCount: markers.length,
    });
    if (!bearingKnown) setHint('No compass here — set each marker’s direction by hand.');
    setMarkerForm({ rel, pitch: pitch ?? 0, kind, bearingKnown });
  };

  const addMarker = (m: Omit<SurveyMarker, 'id'>) => {
    setMarkers((prev) => [...prev, { ...m, id: `m-${Date.now().toString(36)}-${markerSeq++}` }]);
    setMarkerForm(null);
  };

  const moveMarker = (id: string, dHeading: number, dPitch: number) => {
    setMarkers((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              heading: (m.heading + dHeading + 360) % 360,
              pitch: Math.max(-90, Math.min(90, m.pitch + dPitch)),
            }
          : m,
      ),
    );
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const id = `sv-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

      // Upload the sweep photos in parallel. A failed upload costs that frame
      // its picture, never the survey — recognition only needs the embedding.
      setHint('Saving sweep photos…');
      const shots = shotsRef.current;
      const withPhotos = await Promise.all(
        frames.map(async (frame, index) => {
          const blob = shots[index];
          if (!blob) return frame;
          try {
            const fileId = await appStore.uploadPhoto(blob, `${id}-sweep-${index}.jpg`);
            return { ...frame, fileId };
          } catch {
            return frame;
          }
        }),
      );

      const survey: Survey = {
        id,
        name: name.trim() || 'Untitled survey',
        siteId: scope.siteId,
        buildingId: scope.buildingId,
        floorId: scope.floorId,
        spaceName: names.floor ?? names.building ?? names.site,
        geo: getFix(), // null is fine — indoors is the normal case
        qrCode: qrCode ?? undefined,
        qrHeading: qrCode != null ? qrHeading : undefined,
        sweep: withPhotos,
        markers,
        modelId: EMBED_MODEL_ID,
        createdAt: new Date().toISOString(),
      };
      await appStore.kvPut('surveys', `survey.${id}`, survey);
      if (qrCode) await linkCode(qrCode, { type: 'survey', surveyId: id });
      await queryClient.invalidateQueries({ queryKey: ['surveys'] });
      onSaved?.(id);
      onClose();
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const sweepBase = frames[0]?.heading ?? 0;

  return (
    <div className="pa-stage" role="dialog" aria-label="Place assets — AR survey">
      {/* On setup the camera carries the screen and a floating pill is the only
          chrome over it; the step bar returns once the flow is underway. */}
      {step !== 'setup' && (
        <>
          <button className="pa-exit" onClick={onClose}>
            ← Exit survey
          </button>
          <span className={step === 'sweep' ? 'pa-badge sweep' : 'pa-badge'}>
            {step === 'qr'
              ? 'Scan the standpoint code'
              : step === 'sweep'
                ? `Sweep ${Math.min(frames.length, MAX_FRAMES)}/${MAX_FRAMES}`
                : `${markers.length} marker${markers.length === 1 ? '' : 's'}`}
          </span>
        </>
      )}

      <div className="pa-body">
        {/* Camera mount — the live feed is the backdrop the whole way through. */}
        <div id="pa-camera-slot" className="ar-camera-slot">
          <CameraView
            videoRef={camera.videoRef}
            frameCanvasRef={camera.frameCanvasRef}
            state={camera.state}
            onResume={() => void camera.resume()}
          />
        </div>

        {step === 'setup' && (
          <>
            <button className="pa-exit" onClick={onClose}>
              ← Exit survey
            </button>
            <Sheet open title="New survey point" onClose={onClose}>
              <label className="sv-field">
                <span className="sv-field-label">Survey point name</span>
                <input
                  className="sv-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Survey point name (e.g. AHU room — door side)"
                />
              </label>
              <button
                className="btn-cta"
                disabled={!name.trim()}
                onClick={() => {
                  void enableArOrientation(); // iOS gate — this click is the user gesture
                  setStep('qr');
                }}
              >
                Start — scan the standpoint code
              </button>
              <p className="sv-help">
                {scopeLabel
                  ? `Saved under ${scopeLabel}. `
                  : 'Saved without a location — set one on the Surveys screen. '}
                Stick a QR at this spot first: it becomes the survey’s origin, and
                scanning it later is what loads every marker back in its exact place.
              </p>
            </Sheet>
          </>
        )}

        {step === 'markers' && (
          <>
            <ArSpace active>
              {markers.map((m) => (
                <ArCard
                  key={m.id}
                  heading={(sweepBase + m.heading) % 360}
                  pitch={m.pitch}
                  onMove={(dh, dp) => moveMarker(m.id, dh, dp)}
                >
                  {m.assetId ? (
                    <AssetTag name={m.label} sub="drag to adjust" status="green" />
                  ) : (
                    <NoteTag text={m.label} />
                  )}
                </ArCard>
              ))}
            </ArSpace>

            <div className="ar-crosshair" aria-hidden="true">
              <span className="n" />
              <span className="s" />
              <span className="w" />
              <span className="e" />
            </div>

            {mock && (
              <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6, zIndex: 5 }}>
                <button className="ar-toggle" onClick={() => setMockHeading((h) => (h + 330) % 360)}>
                  ⟲ 30°
                </button>
                <span className="pa-step" style={{ alignSelf: 'center' }}>{mockHeading}°</span>
                <button className="ar-toggle" onClick={() => setMockHeading((h) => (h + 30) % 360)}>
                  ⟳ 30°
                </button>
              </div>
            )}

            <div className="pa-marker-chips">
              {markers.map((m) => (
                <span key={m.id} className="pa-chip">
                  {m.label} · {Math.round(m.heading)}°
                  <button aria-label={`Delete ${m.label}`} onClick={() => setMarkers((prev) => prev.filter((x) => x.id !== m.id))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>

            {markerForm && (
              <MarkerForm
                draft={markerForm}
                scopeSiteId={scope.siteId}
                onCancel={() => setMarkerForm(null)}
                onAdd={addMarker}
              />
            )}
          </>
        )}

        {hint && <div className="ar-hint" role="status">{hint}</div>}
      </div>

      {step === 'qr' && (
        <>
          <div className="pa-scanframe" aria-hidden="true">
            <span className="tl" /><span className="tr" /><span className="bl" /><span className="br" />
          </div>
          <div className="pa-foot sweep">
            <p className="pa-tip">
              Point the camera at the standpoint’s QR sticker — it locks in as this
              survey’s origin
            </p>
            <div className="pa-actions">
              <input
                className="sv-input"
                aria-label="Standpoint code"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                placeholder="No sticker scanner? Type the code"
              />
              <button
                className="pa-btn light"
                disabled={!typedCode.trim()}
                onClick={() => acceptCode(typedCode)}
              >
                Use code
              </button>
            </div>
          </div>
        </>
      )}

      {step === 'sweep' && (
        <div className="pa-foot sweep">
          {!mock && sweepSpeed > SWEEP_WARN_DEG_S ? (
            <p className="pa-tip pa-tip-warn" role="status">Too fast — slow right down, frames only capture when steady</p>
          ) : (
            <p className="pa-tip">
              Start facing the code, then rotate slowly in place — frames capture on their own
            </p>
          )}
          <div className="pa-sweep-dots" aria-hidden="true">
            {Array.from({ length: MAX_FRAMES }, (_, i) => (
              <span key={i} className={i < frames.length ? 'dot on' : 'dot'} />
            ))}
          </div>
          <div className="pa-actions">
            <button
              className="pa-btn light"
              disabled={frames.length < minFrames()}
              onClick={() => setStep('markers')}
            >
              Place markers →
            </button>
          </div>
        </div>
      )}

      {step === 'markers' && (
        <div className="pa-foot">
          <div className="pa-actions">
            <button className="pa-btn primary" onClick={() => placeMarkerHere('asset')}>
              + Asset
            </button>
            <button className="pa-btn dark" onClick={() => placeMarkerHere('workorder')}>
              Work order
            </button>
            <button className="pa-btn dark" onClick={() => placeMarkerHere('finding')}>
              Finding
            </button>
          </div>
          <div className="pa-actions">
            <button className="pa-btn light" onClick={() => placeMarkerHere('note')}>
              Note
            </button>
            <button className="pa-btn light" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : `Save survey (${markers.length})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- marker form: asset (search picker) | note | plain label ----

function MarkerForm({
  draft,
  scopeSiteId,
  onCancel,
  onAdd,
}: {
  draft: MarkerDraft;
  scopeSiteId: number | undefined;
  onCancel: () => void;
  onAdd: (m: Omit<SurveyMarker, 'id'>) => void;
}) {
  const [kind, setKind] = useState<MarkerKind>(draft.kind);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Asset | null>(null);
  // Editable when the compass could not supply it — see placeMarkerHere.
  const [bearing, setBearing] = useState(String(Math.round(draft.rel)));

  const bearingNum = Number(bearing);
  const bearingOk = Number.isFinite(bearingNum) && bearingNum >= 0 && bearingNum < 360;
  const canAdd = (kind === 'asset' ? picked !== null : text.trim().length > 0) && bearingOk;

  const submit = () => {
    if (!canAdd) return;
    const heading = ((bearingNum % 360) + 360) % 360;
    const base = { heading, pitch: draft.pitch };
    if (kind === 'asset' && picked) {
      onAdd({ ...base, label: picked.name, assetId: picked.id });
    } else if (kind === 'note' || kind === 'finding') {
      // A finding is a note the technician wants acted on — same anchor, and
      // the AR panel offers "raise a work order" from it.
      const body = text.trim();
      onAdd({
        ...base,
        label: (kind === 'finding' ? `Finding: ${body}` : body).slice(0, 60),
        note: body,
      });
    } else if (kind === 'workorder') {
      onAdd({ ...base, label: text.trim().slice(0, 60), note: text.trim() });
    } else {
      onAdd({ ...base, label: text.trim() });
    }
  };

  return (
    <div className="pa-sheet" role="dialog" aria-label="New marker">
      <h3>
        {draft.bearingKnown
          ? `Marker at ${Math.round(draft.rel)}° / ${Math.round(draft.pitch)}°`
          : 'New marker — set its direction'}
      </h3>
      {!draft.bearingKnown && (
        <>
          <p className="pa-hint" style={{ padding: 0, textAlign: 'left' }}>
            No compass reading here, so the direction can’t be captured by aiming. Enter it in
            degrees from the survey’s first sweep frame (0 = where you started).
          </p>
          <label className="field">
            <span>Direction (0–359°)</span>
            <input
              inputMode="numeric"
              value={bearing}
              onChange={(e) => setBearing(e.target.value)}
              placeholder="e.g. 90"
            />
          </label>
        </>
      )}
      <DsSelect
        label="Type"
        value={kind}
        options={[
          { value: 'asset', label: 'Asset' },
          { value: 'workorder', label: 'Work order' },
          { value: 'finding', label: 'Finding' },
          { value: 'note', label: 'Note' },
        ]}
        onChange={(v) => {
          setKind(v as MarkerKind);
          setPicked(null);
        }}
      />
      {kind === 'asset' ? (
        <AssetSelect value={picked} scopeSiteId={scopeSiteId} onPick={setPicked} />
      ) : (
        <label className="field">
          <span>{kind === 'note' ? 'Note' : 'Label text'}</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Text shown on the marker"
            autoFocus
          />
        </label>
      )}
      <div className="row">
        <button className="btn btn-primary" disabled={!canAdd} onClick={submit}>
          Add marker
        </button>
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
