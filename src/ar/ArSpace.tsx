// 3DoF AR space for mobile Safari (no WebXR on iOS): content is anchored to
// a DIRECTION (bearing + pitch) and drawn over the live camera feed at 60fps.
//
// Two things make a pin STAY on its physical spot — both were wrong before:
//
//  1. POSE: the fused gyro+compass attitude (src/hooks/useHeading) is read
//     directly each frame. There is deliberately NO smoothing here any more —
//     the old per-frame damped follower (k=0.16) added ~100ms of lag on top
//     of the sensor filter's, which is why markers dragged behind a pan and
//     "swam" back when it stopped. Smoothing belongs in the sensor filter,
//     which knows the rotation rate; the render stage just draws the truth.
//
//  2. PROJECTION: markers go through a real perspective camera model
//     (src/ar/projection) whose field of view is computed from the actual
//     video stream and its cover-crop — not the old innerWidth/60 guess,
//     which moved the overlay at roughly half the speed of the world.
//     Roll is part of the model, so tilting the phone sideways no longer
//     shears pins off their spots.
//
// Cards are plain HTML, so anything inside them (lists!) scrolls natively.
// The rAF loop writes transforms straight to the DOM; React only re-renders
// when the SET of cards changes (asset-lens lesson: re-rendering the subtree
// per frame collapsed frame rates in the Facilio webview).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { arOrientation, arQuaternionAt, setOrientationForTest } from '../hooks/useHeading';
import { bearingToCaption, wrap } from '../wayfinding/bearing';
import { CAMERA_LONG_AXIS_FOV_DEG, defaultFov, displayedFov, projectDirection, type ViewFov } from './projection';
import { longAxisFovDeg } from './fovCal';

/* ---------- displayed-FOV state ---------- */

let videoEl: HTMLVideoElement | null = null;
let fovCache: { key: string; fov: ViewFov } | null = null;

/** How old the displayed camera frame is (ms). The projection samples the
 * pose AT THAT AGE — a now-pose over an old frame smears markers during pans.
 * 0 without a live camera (mock, desktop, tests: overlay-on-nothing). */
let poseDelayMs = 0;
export function setArPoseDelay(ms: number): void {
  poseDelayMs = Math.max(0, Math.min(150, ms));
}

/** ARScreen hands over its video element so the projection can match the
 * camera's real field of view. Null = mock/desktop → the default FOV. */
export function setArVideoSource(el: HTMLVideoElement | null): void {
  videoEl = el;
  fovCache = null;
}

function currentFov(viewW: number, viewH: number): ViewFov {
  const vw = videoEl?.videoWidth ?? 0;
  const vh = videoEl?.videoHeight ?? 0;
  if (!vw || !vh) return defaultFov();
  const cal = longAxisFovDeg(CAMERA_LONG_AXIS_FOV_DEG);
  const key = `${vw}x${vh}|${viewW}x${viewH}|${cal.toFixed(1)}`;
  if (fovCache?.key !== key) fovCache = { key, fov: displayedFov(vw, vh, viewW, viewH, cal) };
  return fovCache.fov;
}

/* ---------- anchored-node registry: the hot path never touches React ---------- */

interface ArNode {
  el: HTMLElement;
  edge: HTMLElement | null;
  heading: number;
  pitch: number;
  hidden: boolean;
}
const nodes = new Map<HTMLElement, ArNode>();

/** The wayfinder: one bearing the whole view is pointing the user toward. */
interface GuideNode {
  arrow: HTMLElement;
  text: HTMLElement;
  heading: number;
  onArrive?: () => void;
  arrived: boolean;
}
let guide: GuideNode | null = null;

/** Cards never sink into the candidates row + dock: keep this many px at the
 * bottom of the viewport free of cards (zone E starts at bottom:96px). */
export const DOCK_CLEAR_PX = 104;
/** Cards project around the camera's optical axis — the middle of the frame.
 * (It was 42% once, which drew every pin 8% above where the camera actually
 * pointed — the projection must agree with the video, not with taste.) */
const CARD_BASE_Y = 0.5;
/** How far decluttering may shift a card before anchoring stops being true. */
const MAX_DECLUTTER_PX = 56;
/** ArGuide arrival threshold (deg). */
const ARRIVE_DEG = 10;

function layout() {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const pose = arQuaternionAt(Date.now() - poseDelayMs);
  const angles = arOrientation();

  if (guide) {
    // rotate the arrow toward the target and say it in words
    const d = angles.ok ? wrap(guide.heading - angles.heading) : 0;
    guide.arrow.style.transform = `rotate(${d.toFixed(1)}deg)`;
    const word = angles.ok ? bearingToCaption(d) : 'locating…';
    if (guide.text.textContent !== word) guide.text.textContent = word;
    if (angles.ok && Math.abs(d) < ARRIVE_DEG && !guide.arrived) {
      guide.arrived = true;
      guide.onArrive?.();
    }
  }

  if (!nodes.size) return;
  const fov = currentFov(viewW, viewH);

  const visible: { n: ArNode; x: number; y: number; h: number; dxDeg: number }[] = [];
  // off-screen chevrons stack in a band of their own, clear of the cards
  const edgeBase = Math.max(140, viewH * 0.17);
  let edgeL = 0;
  let edgeR = 0;
  for (const n of nodes.values()) {
    // NO POSE = NO PLACE. This used to fall back to "draw at centre", which
    // stacked every marker on the crosshair — five wrong answers rendered as
    // confidently as one right one. Hidden is the only honest output; the
    // caller shows the sensor banner instead.
    if (!pose || !angles.ok) {
      if (!n.hidden) {
        n.hidden = true;
        n.el.style.visibility = 'hidden';
      }
      if (n.edge) n.edge.style.display = 'none';
      continue;
    }
    const p = projectDirection(n.heading, n.pitch, pose, viewW, viewH, fov);
    if (p.visible !== !n.hidden) {
      n.hidden = !p.visible;
      n.el.style.visibility = p.visible ? '' : 'hidden';
      if (n.edge) n.edge.style.display = p.visible ? 'none' : 'flex';
    }
    if (!p.visible) {
      if (n.edge) {
        // park a chevron on the edge it went out of; four per side, then the
        // marker index is the place to look
        const right = p.dxDeg > 0;
        const slot = right ? edgeR++ : edgeL++;
        if (slot > 3) {
          n.edge.style.display = 'none';
        } else {
          n.edge.style.display = 'flex';
          n.edge.style.left = right ? 'auto' : '6px';
          n.edge.style.right = right ? '6px' : 'auto';
          n.edge.style.top = `${(edgeBase + slot * 30).toFixed(0)}px`;
          n.edge.style.flexDirection = right ? 'row' : 'row-reverse';
        }
      }
      continue;
    }
    visible.push({ n, x: p.x, y: p.y, h: n.el.offsetHeight || 64, dxDeg: p.dxDeg });
  }

  // Same-column cards must keep top-down order or the push-down chain can
  // start from the wrong card and hit its cap — quantize x so a float hair
  // from the projection cannot flip a tie.
  visible.sort((a, b) => Math.round(a.x) - Math.round(b.x) || a.y - b.y);
  const placed: { x: number; top: number; bottom: number }[] = [];
  for (const v of visible) {
    const w = v.n.el.offsetWidth || 200;
    // TOP-ANCHORED: the element's top-centre sits ON the projected point —
    // every marker leads with its anchor dot, so the dot is the pixel the
    // technician aimed at, and the plate hangs below it.
    // hard floor: the candidates row + dock band stays free of cards
    const maxY = viewH * (1 - CARD_BASE_Y) - DOCK_CLEAR_PX - v.h;
    const overlaps = (p: { x: number; top: number; bottom: number }, y: number) =>
      Math.abs(p.x - v.x) < w * 0.75 && y < p.bottom && y + v.h > p.top;
    // Anchoring beats tidiness: a card may be nudged clear of a neighbour, but
    // only within MAX_DECLUTTER_PX of where its projection actually puts it.
    const anchorY = v.y;
    let y = Math.min(anchorY, maxY);
    for (let guard = 0; guard < 6; guard++) {
      const clash = placed.find((p) => overlaps(p, y));
      if (!clash) break;
      const next = clash.bottom + 8;
      if (Math.abs(next - anchorY) > MAX_DECLUTTER_PX) break;
      y = next;
    }
    if (y > maxY) {
      y = maxY;
      for (let guard = 0; guard < 6; guard++) {
        const clash = placed.find((p) => overlaps(p, y));
        if (!clash) break;
        const next = clash.top - v.h - 8;
        if (Math.abs(next - anchorY) > MAX_DECLUTTER_PX) break;
        y = next;
      }
    }
    placed.push({ x: v.x, top: y, bottom: y + v.h });
    const scale = Math.max(0.7, 1 - Math.abs(v.dxDeg) / 140);
    // translate3d keeps the card on the compositor thread
    v.n.el.style.transform = `translate3d(calc(-50% + ${v.x.toFixed(1)}px), ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
  }
}

/** Degrees per pixel at the screen centre — the drag-to-re-place conversion. */
function degPerPxAtCentre(): { x: number; y: number } {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const fov = currentFov(viewW, viewH);
  const DEG = 180 / Math.PI;
  return {
    x: (fov.halfTanX / (viewW / 2)) * DEG,
    y: (fov.halfTanY / (viewH / 2)) * DEG,
  };
}

/** Full-bleed layer; runs one rAF loop for every anchored card inside it. */
export function ArSpace({ children, active }: { children: ReactNode; active: boolean }) {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      layout();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 7 }}>
      {children}
    </div>
  );
}

/** A card fixed at a direction. `onMove` enables drag-to-re-place. */
export function ArCard(props: {
  heading: number;
  pitch: number;
  children: ReactNode;
  /** shown on a screen-edge chevron while this card is out of view */
  edgeLabel?: string;
  onEdgeClick?: () => void;
  onMove?: (dHeading: number, dPitch: number) => void;
  /** An OPEN window must not be buried by sibling nameplates: each card is a
   * stacking context (transform), so the card itself carries the z-index. */
  lift?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    nodes.set(el, {
      el,
      edge: edgeRef.current,
      heading: props.heading,
      pitch: props.pitch,
      hidden: false,
    });
    layout();
    return () => {
      nodes.delete(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // drag / re-anchor / Δ correction update the registry in place
  useLayoutEffect(() => {
    const el = ref.current;
    const n = el ? nodes.get(el) : undefined;
    if (!n) return;
    n.heading = props.heading;
    n.pitch = props.pitch;
    layout();
  }, [props.heading, props.pitch]);

  const card = (
    <div
      ref={ref}
      onPointerDown={(e) => {
        if (!props.onMove) return;
        dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || !props.onMove) return;
        const mx = e.clientX - d.x;
        const my = e.clientY - d.y;
        if (!d.moved && Math.hypot(mx, my) < 6) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        const dpp = degPerPxAtCentre();
        props.onMove(mx * dpp.x, -my * dpp.y);
      }}
      onPointerUp={() => {
        const wasDrag = dragRef.current?.moved;
        dragRef.current = null;
        if (wasDrag) {
          const swallow = (ev: Event) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          window.addEventListener('click', swallow, { capture: true, once: true });
        }
      }}
      style={{
        position: 'absolute',
        left: '50%',
        top: `${CARD_BASE_Y * 100}%`,
        pointerEvents: 'auto',
        willChange: 'transform',
        touchAction: 'none',
        transformOrigin: 'top center',
        zIndex: props.lift ? 5 : undefined,
      }}
    >
      {props.children}
    </div>
  );

  if (!props.edgeLabel) return card;
  return (
    <>
      {card}
      <button ref={edgeRef} className="vs-edge" style={{ display: 'none' }} onClick={props.onEdgeClick}>
        <span className="vs-edge-label">{props.edgeLabel}</span>
        <span className="vs-edge-chev" aria-hidden>
          ›
        </span>
      </button>
    </>
  );
}

/** Wayfinder: a persistent arrow pointing at one bearing until it is reached.
 * `onArrive` fires ONCE when the walker centres the target (<10°) — the
 * caller clears the guide and announces arrival. */
export function ArGuide({
  heading,
  name,
  onClear,
  onArrive,
}: {
  heading: number;
  name: string;
  onClear: () => void;
  onArrive?: () => void;
}) {
  const arrowRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!arrowRef.current || !textRef.current) return;
    guide = { arrow: arrowRef.current, text: textRef.current, heading, onArrive, arrived: false };
    layout();
    return () => {
      guide = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heading]);
  return (
    <div className="vs-guide">
      <span ref={arrowRef} className="vs-guide-arrow" aria-hidden>
        ↑
      </span>
      <span className="vs-guide-body">
        <span className="vs-guide-name">{name}</span>
        <span ref={textRef} className="vs-guide-dir">
          locating…
        </span>
      </span>
      <button className="vs-guide-x" onClick={onClear} aria-label="Stop guiding">
        ✕
      </button>
    </div>
  );
}

// ---- test hooks (jsdom has no sensors and no real rAF cadence) ----

/** TEST ONLY: pin the pose the layout reads. Delegates to the one true pose
 * source, so both helpers stay consistent however a test combines them. */
export function __setPoseForTest(heading: number, pitch = 0): void {
  setOrientationForTest(heading, pitch);
}

/** TEST ONLY: forget the pose (back to "sensor not started"). */
export function __resetPoseForTest(): void {
  setOrientationForTest(null);
}

/** TEST ONLY: run one synchronous layout pass. */
export function __layoutForTest(): void {
  layout();
}
