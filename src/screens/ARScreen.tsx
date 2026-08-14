// The AR stage (roadmap 5): a REAL camera surface with survey markers
// anchored to compass directions.
//
// Mobile-native HUD (matches the reference AR screen). The stage fills its
// pane exactly (height:100%, no 100vh, no page scroll) and lays chrome out in
// thumb-reachable bands:
//   top-left     site chip (40px, 15px) → the site picker sheet
//   top-right    vertical rail of 56px squares — Voice · AI fault · AR toggle
//                (the AR button keeps the accessible name "AR on"/"AR off":
//                the camera contract and the smoke tests read it)
//   top-centre   exactly ONE state chip, below it the standpoint banner
//   middle       dark translucent hint pills, tappable when they carry an action
//   bottom       52px primary + secondary action row, above the app dock
//   sheets       the shared Sheet primitive — they scroll internally, never the page
//
// What is real now: the camera feed (src/components/camera), the recognition
// loop (src/vision/scanLoop), presence via standpoint QR + visual
// relocalization, and marker bearings corrected by the relocalization Δ:
//   abs = (sweep[0].heading + marker.heading + relocΔ + 360) % 360
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { provider } from '../api/provider';
import { loadPlaceAssetPolicy, policyAllows } from '../api/permissions';
import { appStore } from '../api/appStore';
import { draftWorkOrder } from '../api/agents';
import { useAsset, useAssetSearch } from '../api/hooks';
import { useLocationScope } from '../state/LocationContext';
import type { Asset, Survey, SurveyMarker, WorkOrder } from '../api/types';
import { ArCard, ArGuide, ArSpace, setArFrameSize, setArPoseDelay, setArVideoSource } from '../ar/ArSpace';
import { AssetTag, MinimizedDot, NoteTag, StandpointMarker } from '../ar/markers';
import ArWindow from '../ar/ArWindow';
import { fillLink, loadLinks, normaliseLinks } from '../api/links';
import type { MarkerStatus } from '../ar/markers';
import { DEFAULT_MARKER_RANGE_M, markerAbsBearing, parallaxCorrected, presenceDecayCheck, refreshedPresence, type Presence } from '../ar/presence';
import { columnProfile } from '../ar/imageShift';
import { longAxisFovDeg, observeCalSample } from '../ar/fovCal';
import { CAMERA_LONG_AXIS_FOV_DEG, captureFov } from '../ar/projection';
import { installPdr, pdrOffset, resetPdr, TRUST_RADIUS_M, type PdrOffset } from '../ar/pdr';
import { Relocalizer } from '../ar/relocalize';
import { getEmbedFn, EMBED_MODEL_ID } from '../ar/embedding';
import { dequantize, l2Normalize } from '../vision/quantize';
import { CameraView } from '../components/camera/CameraView';
import { CodeSheet } from '../components/camera/CodeSheets';
import { useCamera } from '../components/camera/useCamera';
import Sheet from '../components/Sheet';
import Icon from '../components/Icon';
import AssetSelect from '../components/AssetSelect';
import LocationPicker from '../components/LocationPicker';
import EffiOverlay from '../voice/EffiOverlay';
import { useScanLoop } from '../vision/scanLoop';
import { describeEntry, resolveCode } from '../vision/codes';
import { stampStopByCode } from '../rounds/roundsStore';
import { useGeoFix } from '../hooks/useGeoFix';
import { arOrientation, enableArOrientation, holdYawOffset, placementOrientation, poseSpeedDegS, useHeading } from '../hooks/useHeading';
import { navParamId, onNavigate, setNavParams } from '../shell/router';
import '../styles/ar.css';
import '../ar/arspace.css';

const OPEN_STATUSES = ['open', 'submitted', 'assigned', 'work in progress', 'in progress'];
const PLANNED_STATUSES = ['on hold', 'scheduled', 'pre-open', 'preopen', 'yet to start'];

const HINT_COPY: Record<string, string> = {
  dark: 'Too dark — find more light',
  blur: 'Hold steady — image is blurry',
  moving: 'Hold still…',
};

const EMPTY_SURVEYS: Survey[] = [];
const NO_WALK: PdrOffset = { x: 0, y: 0, dist: 0, steps: 0 };

/** WO roll-up → the one colour a marker is allowed to vary. */
function summarize(workOrders: WorkOrder[]) {
  let open = 0;
  let planned = 0;
  for (const wo of workOrders) {
    const s = (wo.status ?? '').toLowerCase();
    if (OPEN_STATUSES.includes(s)) open++;
    else if (PLANNED_STATUSES.includes(s)) planned++;
  }
  const status: MarkerStatus = open > 0 ? 'red' : planned > 0 ? 'amber' : 'green';
  return { open, planned, status };
}

function dotClass(status: MarkerStatus): string {
  return status === 'red' ? 'st-red' : status === 'amber' ? 'st-amber' : 'st-green';
}

/** Best-effort spoken arrival cue — absent in jsdom and older webviews. */
function speak(text: string) {
  try {
    const synth = (window as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (synth && typeof SpeechSynthesisUtterance === 'function') {
      synth.speak(new SpeechSynthesisUtterance(text));
    }
  } catch {
    /* speech is a bonus, never a dependency */
  }
}

interface FaultDraft {
  subject: string;
  description: string;
  busy: boolean;
  fromPhoto: boolean;
}

type SheetId =
  | 'markers'
  | 'pin'        // module picker: what am I pinning here?
  | 'pin-form'   // the chosen module's form
  | 'fault'
  | 'site'
  | 'stand'
  | 'voice'
  | null;

/** What a pin becomes. Asset is gated — see src/api/permissions.ts. */
export type PinKind = 'workorder' | 'finding' | 'note' | 'asset';

/**
 * The aim, captured the instant "Pin here" is tapped.
 *
 * It used to be read at SAVE time, so tapping, typing a note and lowering the
 * phone pinned the marker wherever the phone had ended up. Freezing at the tap
 * is the whole reason the point lands where the technician was looking.
 */
interface PinPoint {
  /** Relative to sweep frame 0, Δ already removed. */
  rel: number;
  pitch: number;
  known: boolean;
}

/**
 * The shared Sheet primitive, named for assistive tech.
 *
 * Sheet owns the dialog root but takes no label prop (it is frozen for this
 * workstream), and a `role="dialog"` gets no accessible name from its
 * contents — so the name is stamped on the mounted root instead of nesting a
 * second dialog inside it.
 */
function ArSheet(props: {
  label: string;
  open: boolean;
  title?: ReactNode;
  onClose(): void;
  footer?: ReactNode;
  size?: 'auto' | 'tall';
  children: ReactNode;
}) {
  const { label, open, ...rest } = props;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.querySelector('.sheet-root')?.setAttribute('aria-label', label);
  });
  if (!open) return null;
  return (
    <div ref={host} className="ar-sheet-host">
      <Sheet open {...rest} />
    </div>
  );
}

const ArIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </svg>
);

export default function ARScreen() {
  const { scope, names } = useLocationScope();
  const queryClient = useQueryClient();

  // Whether the sensor is ANSWERING. Markers are hidden without it (ArSpace
  // refuses to place what it cannot point at), so the stage has to say so
  // rather than look empty.
  const pose = useHeading(300);

  // The camera is LIVE ON OPEN — this is a camera-first app, not a page with a
  // camera on it. getUserMedia may be called without a gesture (the browser
  // shows its own permission prompt); only iOS motion-sensor access needs one,
  // which is handled by the first-gesture effect below.
  const [arOn, setArOn] = useState(true);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [focusAssetId, setFocusAssetId] = useState<number | null>(null);

  // Handoffs (Estate "Find it on site", voice show_on_site, the Wayfinder's
  // arrival card) arrive as ?asset= — a param this screen historically set
  // out to ignore, so every caller's promise of "AR will point at it" was
  // silently broken. Consume it into focus, at mount AND while mounted.
  useEffect(() => {
    const consume = () => {
      const assetId = navParamId('asset');
      if (assetId == null) return;
      setFocusAssetId(assetId);
      setNavParams({ asset: null }); // consumed — a stale param must not re-fire
    };
    consume();
    return onNavigate(consume);
  }, []);

  /** Markers the user minimized to a DOT — the visionOS "put it away" state. */
  const [dotted, setDotted] = useState<Set<string>>(() => new Set());
  const [guide, setGuide] = useState<{ heading: number; name: string } | null>(null);
  const [sheet, setSheet] = useState<SheetId>(null);
  const [codeSheet, setCodeSheet] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [pinPoint, setPinPoint] = useState<PinPoint | null>(null);
  const [pinKind, setPinKind] = useState<PinKind>('note');
  const [pinBusy, setPinBusy] = useState(false);
  const [canPlaceAsset, setCanPlaceAsset] = useState(false);
  const [fault, setFault] = useState<FaultDraft>({
    subject: '',
    description: '',
    busy: false,
    fromPhoto: false,
  });

  const relocRef = useRef<Relocalizer>(new Relocalizer());

  // Placing an ASSET declares where the portfolio physically lives, so it is
  // gated; notes/findings/work orders are ordinary field work.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [policy, me] = await Promise.all([
          loadPlaceAssetPolicy(),
          provider.getCurrentUser(),
        ]);
        if (live) setCanPlaceAsset(policyAllows(policy, me?.user.email));
      } catch {
        if (live) setCanPlaceAsset(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const getFix = useGeoFix(arOn);

  const camera = useCamera(arOn);

  // The projection must match the DISPLAYED camera: hand ArSpace the video
  // element (for the real FOV + cover-crop) and how old its frames are (the
  // pose is sampled at the frame's age; ~90ms is the measured order for
  // mobile pipelines — without captureTime metadata it is a calibrated
  // constant, and 0 whenever there is no live feed to lag behind).
  useEffect(() => {
    if (camera.state === 'live') {
      setArVideoSource(camera.videoRef.current);
      // In the Facilio webview the video never plays, so the element cannot
      // report its size — the frame size measured off the real frames is the
      // only truthful source there.
      setArFrameSize(camera.frameSize);
      setArPoseDelay(90);
    } else {
      setArVideoSource(null);
      setArFrameSize(null);
      setArPoseDelay(0);
    }
    return () => {
      setArVideoSource(null);
      setArFrameSize(null);
      setArPoseDelay(0);
    };
  }, [camera.state, camera.videoRef, camera.frameSize]);
  const scan = useScanLoop({ camera, siteId: scope.siteId, enabled: arOn });

  // ---- data ----

  const surveysQuery = useQuery({
    queryKey: ['surveys'],
    queryFn: () =>
      appStore
        .kvList<Survey>('surveys', 'survey.', 200)
        .then((rows) => rows.map((r) => r.value).filter((s) => s && Array.isArray(s.markers))),
  });
  const surveys = surveysQuery.data ?? EMPTY_SURVEYS;

  const activeSurvey = useMemo(
    () => (presence ? (surveys.find((s) => s.id === presence.surveyId) ?? null) : null),
    [presence, surveys],
  );
  const markers = activeSurvey?.markers ?? [];

  const markerAssetIds = useMemo(
    () => markers.map((m) => m.assetId).filter((id): id is number => typeof id === 'number'),
    [markers],
  );

  const workOrders = useQuery({
    queryKey: ['workorders', 'ar', markerAssetIds.join(',')],
    queryFn: () => provider.listWorkOrdersForAssets(markerAssetIds),
    enabled: markerAssetIds.length > 0,
  });

  const byAsset = useMemo(() => {
    const map = new Map<number, WorkOrder[]>();
    for (const wo of workOrders.data ?? []) {
      if (!wo.resourceId) continue;
      map.set(wo.resourceId, [...(map.get(wo.resourceId) ?? []), wo]);
    }
    return map;
  }, [workOrders.data]);

  const assets = useAssetSearch({ scope });
  const assetName = useCallback(
    (id: number) => (assets.data ?? []).find((a) => a.id === id)?.name ?? `Asset #${id}`,
    [assets.data],
  );
  const focusAsset = useAsset(focusAssetId);
  const linksQuery = useQuery({ queryKey: ['org-links'], queryFn: loadLinks });
  const links = linksQuery.data ?? normaliseLinks(null);

  // ---- board minimize/restore, persisted per site ----

  const boardKey = `board.${scope.siteId ?? 'none'}`;
  const board = useQuery({
    queryKey: ['settings', boardKey],
    queryFn: () => appStore.kvGet<{ minimized?: boolean }>('settings', boardKey),
  });
  useEffect(() => {
    if (board.data) setMinimized(board.data.minimized === true);
  }, [board.data]);
  const setBoardMinimized = (next: boolean) => {
    setMinimized(next);
    void appStore.kvPut('settings', boardKey, { minimized: next });
  };

  // ---- relocalizer: reload sweeps when surveys change, KEEP presence ----
  // A background ['surveys'] refetch must never evict the standpoint the
  // technician is standing at, so the current fix is carried across load().
  useEffect(() => {
    const reloc = relocRef.current;
    const keepCurrent = reloc.current;
    const keepMatchAt = reloc.lastMatchAt;
    reloc.load(surveys, EMBED_MODEL_ID);
    reloc.current = keepCurrent;
    reloc.lastMatchAt = keepMatchAt;
  }, [surveys]);

  // ---- transient hints ----
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(t);
  }, [hint]);

  // ---- QR lane: standpoint codes confirm presence, asset codes focus ----
  const lastQrAt = useRef(0);
  useEffect(() => {
    const qrHit = scan.qrHit;
    if (!qrHit || qrHit.at === lastQrAt.current) return;
    // Do NOT consume the hit until the standpoint registry it is resolved
    // against has loaded. Both paths below match the code against `surveys`,
    // which is EMPTY_SURVEYS while its query is in flight — so a sticker
    // scanned in the first moments after AR opens resolved to nothing, and
    // because the line below had already recorded its timestamp, the effect
    // never retried it when the surveys arrived. The scan was swallowed.
    //
    // It self-heals in the field (the scan loop re-emits every tick with a new
    // `at` while the code is in frame), which is why it went unnoticed — but a
    // dropped first scan is a real half-second of the technician standing there
    // wondering. Wait for the query to settle instead; an empty-but-loaded
    // registry still falls through to resolveCode for asset and space codes.
    if (surveysQuery.isPending) return;
    lastQrAt.current = qrHit.at;
    const code = qrHit.code;
    const reloc = relocRef.current;
    const orient = arOrientation();

    // A scanned sticker is proof of presence for an active round's stop (7.2).
    void stampStopByCode(code).catch(() => undefined);

    const duplicates = Relocalizer.duplicatesFor(surveys, code);
    if (duplicates.length > 1) {
      setHint('That code is enrolled on more than one standpoint — fix it in Surveys');
      return;
    }
    // Δ anchors to where the QR ACTUALLY IS: the decoder's corner geometry
    // gives its angular offset from the camera axis, so the sticker being
    // off-centre in the frame no longer skews every marker. Mid-pan the
    // decode-to-pose pairing goes stale (≈3° at 30°/s) — then presence is
    // still confirmed, just without rewriting Δ from this one hit.
    const calm = poseSpeedDegS() < 20;
    const qrBearing =
      orient.ok && calm ? (orient.heading + (qrHit.offYaw ?? 0) + 360) % 360 : undefined;
    const standpoint = reloc.confirmByQr(surveys, code, qrBearing);
    if (standpoint) {
      resetPdr();
      setWalk(NO_WALK);
      setPresence({ surveyId: standpoint.id, delta: reloc.current?.delta ?? 0, via: 'qr', at: Date.now() });
      setHint(`Standpoint confirmed — ${standpoint.name}`);
      return;
    }

    void (async () => {
      const res = await resolveCode(code);
      if (res.kind === 'target' && res.entry.type === 'asset' && res.entry.assetId) {
        setFocusAssetId(res.entry.assetId);
        return;
      }
      if (res.kind === 'target' && res.entry.type === 'survey' && res.entry.surveyId) {
        const hit = surveys.find((s) => s.id === res.entry.surveyId);
        if (hit) {
          // registered against a survey but with no enrolled heading: no Δ
          // source, so presence is forced (explicit intent) and never decays
          reloc.current = { surveyId: hit.id, delta: 0, score: 1 };
          reloc.lastMatchAt = Date.now();
          setPresence({ surveyId: hit.id, delta: 0, via: 'qr', forced: true });
          setHint(`Standpoint confirmed — ${hit.name}`);
          return;
        }
      }
      if (res.kind === 'target') {
        setHint(`Code points at ${describeEntry(res.entry)}`);
        return;
      }
      setCodeSheet(code); // unknown / conflict → the registry sheets
    })();
    // isPending is a dep so a hit deferred above is retried the moment the
    // registry settles — including the error case, where `surveys` keeps its
    // EMPTY_SURVEYS identity and would not re-trigger this on its own.
  }, [scan.qrHit, surveys, surveysQuery.isPending]);

  // asset lock from the vision lane focuses the asset panel
  useEffect(() => {
    if (scan.locked) setFocusAssetId(scan.locked.assetId);
  }, [scan.locked]);

  // ---- visual relocalization lane (real camera only) ----
  // Each tick also feeds two accuracy loops that want exactly this data:
  // the frame's column profile refines Δ WITHIN the matched sweep frame
  // (±14° frame-grid error → a degree or two), and consecutive
  // (profile, heading) pairs self-calibrate the device's true FOV.
  useEffect(() => {
    if (!arOn || camera.state !== 'live' || surveys.length === 0) return;
    let busy = false;
    const profileCanvas = document.createElement('canvas');
    let lastCal: { profile: Float32Array; heading: number; pitch: number } | null = null;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const fc = camera.frameCanvasRef.current;
          const video = camera.videoRef.current;
          const src: CanvasImageSource | null =
            fc && fc.width
              ? fc
              : video && video.readyState >= 2 && video.videoWidth
                ? video
                : null;
          const orient = arOrientation();
          if (!src || !orient.ok) return;
          const w = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLCanvasElement).width;
          const h = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLCanvasElement).height;

          let live: { profile: Float32Array; hFovDeg: number } | undefined;
          if (w && h) {
            try {
              const profile = columnProfile(src, w, h, profileCanvas);
              const fov = captureFov(w, h, longAxisFovDeg(CAMERA_LONG_AXIS_FOV_DEG));
              live = { profile, hFovDeg: (2 * Math.atan(fov.halfTanX) * 180) / Math.PI };
              if (lastCal) {
                observeCalSample({
                  prev: lastCal.profile,
                  next: profile,
                  dHeadingDeg: ((orient.heading - lastCal.heading + 540) % 360) - 180,
                  dPitchDeg: orient.pitch - lastCal.pitch,
                  frameW: w,
                  frameH: h,
                });
              }
              lastCal = { profile, heading: orient.heading, pitch: orient.pitch };
            } catch {
              /* no 2d canvas — coarse matching still works */
            }
          }

          const quant = await getEmbedFn()(src);
          const cur = relocRef.current.observe(l2Normalize(dequantize(quant)), orient.heading, live);
          if (!cur) return;
          // A fresh match means the view still looks like the standpoint —
          // whatever the step counter accumulated was shuffling, not leaving.
          resetPdr();
          setWalk(NO_WALK);
          // refreshedPresence owns the rule that keeps pins STILL: a visual
          // match refreshes the clock but may not stomp an exact QR Δ, and a
          // visual-only Δ only moves past the quantization hysteresis.
          setPresence((prev) => refreshedPresence(prev, cur, Date.now()));
        } catch {
          /* a missed frame is not an error */
        } finally {
          busy = false;
        }
      })();
    }, 1500);
    return () => clearInterval(timer);
  }, [arOn, camera.state, camera.frameCanvasRef, camera.videoRef, surveys.length]);

  // ---- walking: dead-reckon the offset and RECALCULATE, then be honest ----
  // Steps + heading give the viewer's position off the standpoint (PDR).
  // Within trust range the markers are REPROJECTED from where the viewer
  // actually stands (parallaxCorrected — a bearing is only true FROM the
  // standpoint, but with a range it becomes a point, and a point can be
  // looked at from anywhere). Past the trust radius PDR error rivals the
  // correction, so pins fade and the banner asks for a rescan.
  const [walk, setWalk] = useState<PdrOffset>(NO_WALK);
  useEffect(() => {
    if (!presence) {
      setWalk(NO_WALK);
      return;
    }
    installPdr();
    resetPdr();
    const timer = setInterval(() => {
      const off = pdrOffset();
      setWalk((prev) =>
        Math.abs(prev.x - off.x) < 0.05 && Math.abs(prev.y - off.y) < 0.05 ? prev : off,
      );
    }, 500);
    return () => clearInterval(timer);
  }, [presence]);
  const walkState: 'at' | 'adjusted' | 'lost' =
    !presence || walk.dist < 0.6 ? 'at' : walk.dist > TRUST_RADIUS_M ? 'lost' : 'adjusted';

  // While localized, the compass may not steer the frame: Δ was measured in
  // THIS frame, so any later compass correction slides every marker by the
  // correction amount (up to the full 1°/s slew) while the phone sits still.
  // Held ⇒ the gyro-fused relative lane carries the pose alone; the QR
  // re-scan (forced by decay at the latest) re-roots exactly.
  useEffect(() => {
    holdYawOffset(presence != null);
    return () => holdYawOffset(false);
  }, [presence]);

  // ---- presence decay watchdog ----
  useEffect(() => {
    if (!presence) return;
    const timer = setInterval(() => {
      const verdict = presenceDecayCheck({
        presence,
        survey: surveys.find((s) => s.id === presence.surveyId),
        fix: getFix(),
        lastMatchAt: relocRef.current.lastMatchAt,
        now: Date.now(),
      });
      if (!verdict.decayed) return;
      relocRef.current.reset();
      setPresence(null);
      setGuide(null);
      setHint(
        verdict.reason === 'left-area'
          ? 'You have left this area — markers hidden'
          : 'Presence went stale — rescan the standpoint code',
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [presence, surveys, getFix]);

  // ---- actions ----

  // iOS gates motion sensors behind a user gesture. The camera does not need
  // one, so rather than holding the whole stage hostage to a tap, we arm the
  // sensors on the FIRST touch anywhere in the stage — by which time the user
  // is already looking at a live camera.
  useEffect(() => {
    if (!arOn) return;
    let done = false;
    const arm = () => {
      if (done) return;
      done = true;
      void enableArOrientation();
    };
    window.addEventListener('pointerdown', arm, { once: true, passive: true });
    window.addEventListener('touchstart', arm, { once: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('touchstart', arm);
    };
  }, [arOn]);

  const toggleAr = () => {
    const next = !arOn;
    setArOn(next);
    if (next) void enableArOrientation();
    if (!next) {
      setGuide(null);
      setSheet(null);
    }
  };

  /**
   * Compass-only fallback: no code to scan and no visual match, so the user
   * names the standpoint. Same forced presence the "registered against a
   * survey but no enrolled heading" QR branch already produces — Δ is 0, so
   * bearings are raw compass bearings and presence never decays.
   */
  const standAt = (survey: Survey) => {
    const reloc = relocRef.current;
    reloc.current = { surveyId: survey.id, delta: 0, score: 1 };
    reloc.lastMatchAt = Date.now();
    setPresence({ surveyId: survey.id, delta: 0, via: 'qr', forced: true });
    setSheet(null);
    setHint(`Compass-only at ${survey.name} — bearings are uncorrected`);
  };

  const startGuide = (heading: number, name: string) => {
    setGuide({ heading, name });
    setSheet(null);
  };

  const guideToMarker = (marker: SurveyMarker) => {
    if (!activeSurvey || !presence) return;
    startGuide(markerAbsBearing(activeSurvey, marker, presence.delta), marker.label);
  };

  /**
   * "Pin here" — freeze the aim NOW, then ask what it is.
   *
   * The median-of-recent reading is used rather than one instant, because a
   * marker is written once and lives forever (see placementOrientation).
   */
  const [pinAsset, setPinAsset] = useState<Asset | null>(null);

  const startPin = () => {
    if (!activeSurvey) {
      setHint('Stand at a standpoint first — a pin belongs to a survey');
      return;
    }
    const aim = placementOrientation();
    if (!aim) {
      // Typing a bearing into a box was never placement — it was a guess,
      // saved with the same authority as a real reading and then drawn as
      // fact. Ask for the sensor instead.
      void enableArOrientation();
      setHint('No orientation yet — allow Motion & Orientation Access, then point and pin');
      return;
    }
    const base = activeSurvey.sweep[0]?.heading ?? 0;
    const delta = presence?.delta ?? 0;
    setPinPoint({
      rel: ((aim.heading - delta - base) % 360 + 360) % 360,
      pitch: aim.pitch,
      known: true,
    });
    setNoteText('');
    setPinAsset(null);
    setSheet('pin');
  };

  const addMarkerToSurvey = async (marker: SurveyMarker) => {
    if (!activeSurvey) return;
    const next: Survey = { ...activeSurvey, markers: [...activeSurvey.markers, marker] };
    await appStore.kvPut('surveys', `survey.${activeSurvey.id}`, next);
    await queryClient.invalidateQueries({ queryKey: ['surveys'] });
  };

  const newMarkerId = () =>
    `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;

  /** Commits the pin as the chosen module, at the FROZEN point. */
  const commitPin = async (asset?: Asset) => {
    const text = noteText.trim();
    if (!activeSurvey || !pinPoint || pinBusy) return;
    if (pinKind !== 'asset' && !text) return;
    setPinBusy(true);
    try {
      const base: Pick<SurveyMarker, 'heading' | 'pitch'> = {
        heading: pinPoint.rel,
        pitch: pinPoint.pitch,
      };

      if (pinKind === 'asset' && asset) {
        await addMarkerToSurvey({ ...base, id: newMarkerId(), label: asset.name, assetId: asset.id });
        setHint(`${asset.name} placed here`);
      } else if (pinKind === 'workorder') {
        // A work-order pin creates the REAL record, then anchors to it — a pin
        // that only looked like a work order would be a lie.
        const id = await provider.createWorkOrder({
          subject: text.slice(0, 80),
          description: text,
          siteId: activeSurvey.siteId ?? scope.siteId,
          resourceId: focusAssetId ?? undefined,
          spaceId:
            focusAsset.data?.spaceId ??
            activeSurvey.floorId ??
            activeSurvey.buildingId ??
            scope.floorId ??
            scope.buildingId,
        });
        await addMarkerToSurvey({
          ...base,
          id: newMarkerId(),
          label: text.slice(0, 60),
          note: text,
          workOrderId: id,
        });
        await queryClient.invalidateQueries({ queryKey: ['workorders'] });
        setHint(`Work order #${id} raised and pinned here`);
      } else {
        const label = pinKind === 'finding' ? `Finding: ${text}` : text;
        await addMarkerToSurvey({ ...base, id: newMarkerId(), label: label.slice(0, 60), note: text });
        setHint(pinKind === 'finding' ? 'Finding pinned here' : 'Note pinned here');
      }

      setNoteText('');
      setPinPoint(null);
      setSheet(null);
    } catch (err) {
      setHint(err instanceof Error ? err.message : 'Could not pin that');
    } finally {
      setPinBusy(false);
    }
  };

  const openFault = () => {
    setSheet('fault');
    setFault({ subject: '', description: '', busy: true, fromPhoto: false });
    void (async () => {
      try {
        const blob = await camera.snap();
        if (blob) {
          const fileId = await appStore.uploadPhoto(blob, `fault-${Date.now()}.jpg`);
          const context = [
            focusAsset.data?.name ? `Asset: ${focusAsset.data.name}` : '',
            activeSurvey ? `Standpoint: ${activeSurvey.name}` : '',
            names.site ? `Site: ${names.site}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const draft = await draftWorkOrder(fileId, context || 'Field fault report');
          setFault({
            subject: draft.subject,
            description: draft.description,
            busy: false,
            fromPhoto: true,
          });
          return;
        }
      } catch {
        /* no frame / agent unavailable → the plain form below */
      }
      setFault((f) => ({ ...f, busy: false }));
    })();
  };

  const submitFault = async () => {
    const subject = fault.subject.trim();
    if (!subject) return;
    setFault((f) => ({ ...f, busy: true }));
    try {
      await provider.createWorkOrder({
        subject,
        description: fault.description.trim() || undefined,
        siteId: activeSurvey?.siteId ?? scope.siteId,
        resourceId: focusAssetId ?? undefined,
        spaceId:
          focusAsset.data?.spaceId ??
          activeSurvey?.floorId ??
          activeSurvey?.buildingId ??
          scope.floorId ??
          scope.buildingId,
      });
      await queryClient.invalidateQueries({ queryKey: ['workorders'] });
      setSheet(null);
      setFault({ subject: '', description: '', busy: false, fromPhoto: false });
      setHint('Work order raised');
    } catch (err) {
      setFault((f) => ({ ...f, busy: false }));
      setHint(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- derived chrome ----

  const stateChip = !arOn
    ? { cls: 'ar-state idle', text: 'AR paused' }
    : presence
      ? {
          cls: 'ar-state locked',
          text: `Localized · ${activeSurvey?.name ?? presence.surveyId}${presence.via === 'qr' ? ' · QR' : ''}`,
        }
      : camera.state === 'unavailable'
        ? { cls: 'ar-state failed', text: 'Camera unavailable' }
        : scan.hint
          ? { cls: 'ar-state verifying', text: HINT_COPY[scan.hint] ?? scan.hint }
          : { cls: 'ar-state verifying', text: 'Looking for a standpoint…' };


  const markerCount = arOn && !minimized ? markers.length : 0;

  return (
    <div className="ar-stage">
      {/* The real camera, full-bleed inside the stage. Its unavailable/paused
          states render here as centred cards, never as a whole-screen error. */}
      <div className="ar-camera-slot">
        {arOn && (
          <CameraView
            videoRef={camera.videoRef}
            frameCanvasRef={camera.frameCanvasRef}
            state={camera.state}
            onResume={() => void camera.resume()}
          />
        )}
      </div>
      <div className="ar-scrim" />

      {/* top band: site chip left, action rail right, both clear of the notch */}
      <div className="ar-top">
        <button className="ar-chip-site" onClick={() => setSheet('site')}>
          <span className="txt">{names.site ?? 'All sites'}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ opacity: 0.75 }} aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {/* the rail is down to the one control the orb does not own: AR
            itself. Voice and AI-create live in Effi's visual-intelligence
            menu now — two buttons duplicating it were just chrome. */}
        <div className="ar-rail">
          <button
            className={arOn ? 'ar-rail-btn on' : 'ar-rail-btn'}
            aria-label={arOn ? 'AR on' : 'AR off'}
            aria-pressed={arOn}
            onClick={toggleAr}
          >
            <ArIcon />
          </button>
        </div>
      </div>

      {/* exactly ONE state chip, top-centre */}
      <div className="ar-state-row">
        <span className={stateChip.cls}>
          <span className="ar-state-dot" />
          <span className="txt">{stateChip.text}</span>
        </span>
      </div>

      {/* Standpoint banner — outranks floor/site once we know where we are */}
      {arOn && activeSurvey && (
        <div className="ar-standpoint">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
          </svg>
          {activeSurvey.name} · {markers.length} marker{markers.length === 1 ? '' : 's'}
        </div>
      )}

      {/* No pose = markers hidden. Say it, and offer the only fix there is. */}
      {arOn && activeSurvey && presence && markers.length > 0 && !pose.ok && (
        <div className="ar-nocompass">
          <Icon name="compass" size={16} />
          <span>Markers need the compass — allow Motion &amp; Orientation Access</span>
          <button className="btn-quiet" onClick={() => void enableArOrientation()}>
            Enable
          </button>
        </div>
      )}

      {/* markers, positioned by the ArSpace node registry */}
      {arOn && !minimized && (
        <div className={walkState === 'lost' ? 'ar-marker-layer ar-displaced' : 'ar-marker-layer'}>
        <ArSpace active={arOn}>
          {activeSurvey &&
            presence &&
            markers.map((marker) => {
              const abs = markerAbsBearing(activeSurvey, marker, presence.delta);
              const shown =
                walkState === 'at'
                  ? { bearing: abs, pitch: marker.pitch }
                  : parallaxCorrected(
                      abs,
                      marker.pitch,
                      marker.rangeM ?? DEFAULT_MARKER_RANGE_M,
                      walk,
                    );
              const summary = summarize(
                marker.assetId ? (byAsset.get(marker.assetId) ?? []) : [],
              );
              const isDotted = dotted.has(marker.id);
              const isWindow =
                !isDotted && marker.assetId != null && focusAssetId === marker.assetId;
              return (
                <ArCard
                  key={marker.id}
                  heading={shown.bearing}
                  pitch={shown.pitch}
                  edgeLabel={marker.label}
                  onEdgeClick={() => startGuide(shown.bearing, marker.label)}
                  lift={isWindow}
                >
                  {isDotted ? (
                    // minimized: a status dot + label, tap to restore
                    <MinimizedDot
                      label={marker.label}
                      status={summary.status}
                      onClick={() => {
                        setDotted((prev) => {
                          const next = new Set(prev);
                          next.delete(marker.id);
                          return next;
                        });
                        if (marker.assetId != null) setFocusAssetId(marker.assetId);
                      }}
                    />
                  ) : isWindow && focusAsset.data ? (
                    // the full work surface, anchored where the asset is
                    <ArWindow
                      asset={focusAsset.data}
                      openCount={summary.open}
                      plannedCount={summary.planned}
                      woUrl={(id) => fillLink(links.wo, id)}
                      assetUrl={(id) => fillLink(links.asset, id)}
                      onMinimize={() => {
                        setDotted((prev) => new Set(prev).add(marker.id));
                        setFocusAssetId(null);
                      }}
                      onVoice={() => setSheet('voice')}
                      onFault={openFault}
                    />
                  ) : marker.assetId ? (
                    <AssetTag
                      name={marker.label}
                      sub={activeSurvey.spaceName}
                      status={summary.status}
                      openCount={summary.open}
                      plannedCount={summary.planned}
                      selected={focusAssetId === marker.assetId}
                      onClick={() => setFocusAssetId(marker.assetId ?? null)}
                    />
                  ) : (
                    <NoteTag text={marker.label} onClick={() => startGuide(abs, marker.label)} />
                  )}
                </ArCard>
              );
            })}
        </ArSpace>
        </div>
      )}

      {arOn && walkState === 'adjusted' && activeSurvey && (
        <div className="ar-nocompass ar-walkchip" role="status">
          <Icon name="pin" size={16} />
          <span>Pins adjusted for your position (~{walk.dist.toFixed(1)}m from the standpoint)</span>
        </div>
      )}
      {arOn && walkState === 'lost' && activeSurvey && (
        <div className="ar-nocompass" role="status">
          <Icon name="pin" size={16} />
          <span>
            Too far from the standpoint to keep pins accurate — walk back or rescan its code.
          </span>
        </div>
      )}

      {arOn && activeSurvey && !minimized && (
        <StandpointMarker
          label={activeSurvey.name}
          relocalizing={presence?.via !== 'qr'}
          style={{ left: '50%', top: '72%', transform: 'translateX(-50%)' }}
        />
      )}

      {arOn && guide && (
        <ArGuide
          heading={guide.heading}
          name={guide.name}
          onClear={() => setGuide(null)}
          onArrive={() => {
            const arrived = `${guide.name} is in front of you`;
            speak(arrived);
            setHint(arrived);
            setGuide(null);
          }}
        />
      )}

      <div className="ar-crosshair" aria-hidden="true">
        <span className="n" />
        <span className="s" />
        <span className="w" />
        <span className="e" />
      </div>

      {/* The camera is the content — chrome never sits in the middle of it.
          The state chip up top already says what we are doing ("Looking for a
          standpoint…"), so the only thing worth surfacing here is the ACTION,
          as one compact chip tucked under the top band. */}
      <div className="ar-hints">
        {arOn && minimized && (
          <button className="ar-pill ar-pill-action" onClick={() => setBoardMinimized(false)}>
            Restore markers ({markers.length})
          </button>
        )}
        {arOn && !presence && (
          <button className="ar-pill ar-pill-action" onClick={() => setSheet('stand')}>
            {camera.state === 'unavailable' ? 'Pick a standpoint' : 'Show markers anyway'}
          </button>
        )}
      </div>

      {/* bottom band: candidates, the toast, then the 52px action row */}
      <div className="ar-bottom">
        {arOn && scan.candidates.length > 0 && (
          <div className="ar-candidates">
            {scan.candidates.slice(0, 3).map((candidate, index) => {
              const summary = summarize(byAsset.get(candidate.assetId) ?? []);
              return (
                <button
                  key={candidate.assetId}
                  className={index === 0 ? 'ar-candidate top' : 'ar-candidate'}
                  onClick={() => setFocusAssetId(candidate.assetId)}
                >
                  <span className={`dot ${dotClass(summary.status)}`} />
                  {assetName(candidate.assetId)}
                  <span className="score">{Math.round(candidate.score * 100)}%</span>
                </button>
              );
            })}
          </div>
        )}

        {hint && (
          <div className="ar-toast" role="status">
            {hint}
          </div>
        )}

        <div className="ar-actions">
          <button
            className="ar-action ar-action-primary"
            onClick={() => activeSurvey ? startPin() : setSheet('stand')}
          >
            <Icon name="pin" /> Pin here
          </button>
          <button
            className={sheet === 'markers' ? 'ar-action ar-action-secondary active' : 'ar-action ar-action-secondary'}
            onClick={() => setSheet(sheet === 'markers' ? null : 'markers')}
          >
            Markers
            <span className="ar-dock-badge">{markerCount}</span>
          </button>
        </div>
      </div>

      {/* ---- sheets: they scroll internally, the stage never does ---- */}

      <ArSheet
        label="Site"
        open={sheet === 'site'}
        title="Where are you working?"
        onClose={() => setSheet(null)}
        size="tall"
      >
        <LocationPicker />
      </ArSheet>

      <ArSheet
        label="Pick a standpoint"
        open={sheet === 'stand'}
        title="Pick a standpoint"
        onClose={() => setSheet(null)}
      >
        <p className="ar-sheet-note">
          Compass-only: markers are placed on raw compass bearings, so they drift until you
          scan the standpoint code.
        </p>
        {surveys.length === 0 && (
          <p className="empty-card">No surveys yet — capture one from the Surveys tab.</p>
        )}
        {surveys.map((survey) => (
          <button key={survey.id} className="row-card" onClick={() => standAt(survey)}>
            <span>
              <span className="row-card-title">{survey.name}</span>
              <span className="row-card-meta">
                {survey.spaceName ?? 'No space'} · {survey.markers.length} marker
                {survey.markers.length === 1 ? '' : 's'}
              </span>
            </span>
            <span className="row-badge">Stand here</span>
          </button>
        ))}
      </ArSheet>

      {/* marker index — one row per marker, each with a GUIDE action */}
      <ArSheet
        label="Marker index"
        open={sheet === 'markers'}
        title="Markers"
        onClose={() => setSheet(null)}
        size="tall"
        footer={
          activeSurvey ? (
            <button className="btn-quiet grow" onClick={() => setBoardMinimized(!minimized)}>
              {minimized ? 'Restore marker board' : 'Minimize marker board'}
            </button>
          ) : (
            <button className="btn-cta" onClick={() => setSheet('stand')}>
              Pick a standpoint
            </button>
          )
        }
      >
        {!activeSurvey && (
          <p className="ar-sheet-note">
            Scan a standpoint code (or let the camera recognize the spot) to load its markers.
          </p>
        )}
        {activeSurvey && (
          <>
            <p className="mi-group">{activeSurvey.name}</p>
            {markers.map((marker) => (
              <div key={marker.id} className="mi-row">
                <span className="lbl">
                  <span className="txt">{marker.label}</span>
                  <span className="meta">
                    <span className="kind">
                      {marker.assetId ? 'asset' : marker.note ? 'note' : 'label'}
                    </span>
                    <span className="deg">
                      {Math.round(markerAbsBearing(activeSurvey, marker, presence?.delta ?? 0))}°
                    </span>
                  </span>
                </span>
                <button className="btn-quiet" onClick={() => guideToMarker(marker)}>
                  Guide
                </button>
              </div>
            ))}
          </>
        )}
      </ArSheet>

      <ArSheet
        label="Pin here"
        open={sheet === 'pin'}
        title="What are you pinning here?"
        onClose={() => {
          setPinPoint(null);
          setSheet(null);
        }}
      >
        <p className="sv-help" style={{ marginTop: 0 }}>
Aim captured — lower the phone to type, the pin stays where you pointed.
        </p>
        <div className="ar-pin-kinds">
          {(
            [
              { kind: 'workorder' as const, icon: 'clipboard' as const, label: 'Work order', hint: 'Raises a real work order and pins it' },
              { kind: 'finding' as const, icon: 'alert' as const, label: 'Finding', hint: 'Something worth recording, no job yet' },
              { kind: 'note' as const, icon: 'note' as const, label: 'Note', hint: 'For the next technician' },
              ...(canPlaceAsset
                ? [{ kind: 'asset' as const, icon: 'wrench' as const, label: 'Place asset', hint: 'Says where this asset physically is' }]
                : []),
            ]
          ).map((option) => (
            <button
              key={option.kind}
              className="ar-pin-kind"
              onClick={() => {
                setPinKind(option.kind);
                setSheet('pin-form');
              }}
            >
              <Icon name={option.icon === 'clipboard' ? 'list' : option.icon} size={20} />
              <span className="ar-pin-kind-main">
                <span className="ar-pin-kind-label">{option.label}</span>
                <span className="ar-pin-kind-hint">{option.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </ArSheet>

      <ArSheet
        label="Pin details"
        open={sheet === 'pin-form'}
        title={
          pinKind === 'workorder'
            ? 'New work order here'
            : pinKind === 'finding'
              ? 'Record a finding here'
              : pinKind === 'asset'
                ? 'Place an asset here'
                : 'Pin a note here'
        }
        onClose={() => setSheet('pin')}
        footer={
          pinKind === 'asset' ? (
            <button
              className="btn-cta"
              disabled={!pinAsset || pinBusy}
              onClick={() => pinAsset && void commitPin(pinAsset)}
            >
              {pinBusy ? 'Placing…' : pinAsset ? `Place ${pinAsset.name} here` : 'Place asset here'}
            </button>
          ) : (
            <button
              className="btn-cta"
              disabled={!noteText.trim() || pinBusy}
              onClick={() => void commitPin()}
            >
              {pinBusy
                ? 'Saving…'
                : pinKind === 'workorder'
                  ? 'Raise and pin'
                  : pinKind === 'finding'
                    ? 'Pin finding'
                    : 'Pin note'}
            </button>
          )
        }
      >
        {pinKind === 'asset' ? (
          <div className="ar-pin-asset">
            <AssetSelect value={pinAsset} scopeSiteId={scope.siteId} onPick={setPinAsset} />
          </div>
        ) : (
          <label className="field">
            <span>
              {pinKind === 'workorder'
                ? 'What needs doing'
                : pinKind === 'finding'
                  ? 'What you found'
                  : 'Note'}
            </span>
            <textarea
              rows={4}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={
                pinKind === 'workorder'
                  ? 'e.g. Replace the filter on this AHU'
                  : pinKind === 'finding'
                    ? 'e.g. Belt showing wear, not urgent'
                    : 'What should the next technician know?'
              }
            />
          </label>
        )}
      </ArSheet>

      <ArSheet
        label="Create work order"
        open={sheet === 'fault'}
        title="Create work order"
        onClose={() => setSheet(null)}
        footer={
          <button
            className="btn-cta"
            disabled={fault.busy || !fault.subject.trim()}
            onClick={() => void submitFault()}
          >
            Create work order
          </button>
        }
      >
        {fault.busy && <p className="ar-sheet-note">Reading the frame…</p>}
        {!fault.busy && !fault.fromPhoto && (
          <p className="ar-sheet-note">No camera frame available — describe the fault yourself.</p>
        )}
        {fault.fromPhoto && <p className="ar-sheet-note">Drafted from the current camera frame.</p>}
        <label className="field">
          <span>Subject</span>
          <input
            value={fault.subject}
            onChange={(e) => setFault((f) => ({ ...f, subject: e.target.value }))}
            placeholder="What is wrong?"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            rows={4}
            value={fault.description}
            onChange={(e) => setFault((f) => ({ ...f, description: e.target.value }))}
          />
        </label>
      </ArSheet>

      {/* Effi — the voice agent lives ON the stage (orb → panel), per the
          Vision AR Voice Agent design. The rail mic and the window's Voice
          action both open the same panel. */}
      {arOn && (
        <EffiOverlay
          open={sheet === 'voice'}
          onOpenChange={(next) => setSheet(next ? 'voice' : null)}
          hideOrb={focusAssetId != null}
          assetInView={
            focusAsset.data ? { id: focusAsset.data.id, name: focusAsset.data.name } : undefined
          }
          captureFrame={() => camera.snap()}
          woUrl={(id) => fillLink(links.wo, id)}
          onUiAction={(verb) => {
            if (verb === 'minimize') setBoardMinimized(true);
            if (verb === 'expand') setBoardMinimized(false);
            if (verb === 'clear') setGuide(null);
            if (verb === 'tasks') setSheet(null);
          }}
          onShowAsset={(assetId) => setFocusAssetId(assetId)}
          onPinFinding={async (text) => {
            // same anchoring rules as "Pin here": a finding is a marker, and
            // markers need a standpoint and a live aim
            if (!activeSurvey) {
              throw new Error('Stand at a standpoint first — a finding pins to a survey.');
            }
            const aim = placementOrientation();
            if (!aim) {
              throw new Error('No orientation yet — allow Motion & Orientation Access, then retry.');
            }
            const base = activeSurvey.sweep[0]?.heading ?? 0;
            const delta = presence?.delta ?? 0;
            await addMarkerToSurvey({
              id: newMarkerId(),
              label: `Finding: ${text}`.slice(0, 60),
              note: text,
              heading: ((aim.heading - delta - base) % 360 + 360) % 360,
              pitch: aim.pitch,
            });
            return `Finding pinned right where you're aiming — ${text}`;
          }}
        />
      )}

      {/* in-view work orders for the focused asset */}
      {/* An asset focused OUTSIDE the marker set (vision lane lock, QR on an
          unpinned asset) still gets the full window — screen-anchored at the
          bottom, since there is no marker direction to hang it on. */}
      {focusAsset.data &&
        !markers.some((m) => m.assetId === focusAssetId && !dotted.has(m.id)) && (
          <div className="ar-window-dock">
            <ArWindow
              asset={focusAsset.data}
              openCount={byAsset.get(focusAsset.data.id)?.length ?? 0}
              plannedCount={0}
              woUrl={(id) => fillLink(links.wo, id)}
              assetUrl={(id) => fillLink(links.asset, id)}
              onMinimize={() => setFocusAssetId(null)}
              onVoice={() => setSheet('voice')}
              onFault={openFault}
            />
          </div>
        )}

      {codeSheet && (
        <CodeSheet
          code={codeSheet}
          siteId={scope.siteId}
          onClose={() => setCodeSheet(null)}
          onLinked={(entry) => setHint(`QR linked: ${describeEntry(entry)}`)}
        />
      )}
    </div>
  );
}

/** Asset search for a gated "Place asset" pin. */
