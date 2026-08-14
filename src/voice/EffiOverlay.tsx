/**
 * Effi — the AR voice agent, built to the "Vision AR Voice Agent" design
 * (claude.ai/design 4a77f71a, Vision AR Voice Agent.dc.html).
 *
 * Anatomy, straight from the design:
 *  - an ORB floating at the right edge above the action row: conic ring in
 *    the four wordmark colours (35% idle, full while active), #3C229D core
 *    with the Facilio mark, breathe loop, ripple while listening, a
 *    "Tap to talk" hint pill;
 *  - tap → the camera dims to 55% and a dark panel rises from the bottom:
 *    status row (pulsing dot + LISTENING / WORKING ON IT / EFFI + ✕),
 *    the utterance as live text (confirmed words white, the tail 42% white,
 *    cyan caret), a 9-bar waveform while listening, thinking dots while the
 *    tools run;
 *  - the reply is A CARD, NOT A SENTENCE: avatar + spoken line, then the
 *    record it acted on (title, fields, actions), then suggestion chips;
 *  - a green toast confirms the side effect at the top of the frame.
 *
 * The intelligence is the existing lanes, unchanged: local intents first,
 * the fv-voice tool loop for everything else, and the photo→draft→create
 * fault flow. Colour is the only Siri borrowing — the rest is Atom dark
 * glass, 6/8px radii, 180ms decel-out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocationScope } from '../state/LocationContext';
import { defaultDeps, type VoiceDeps } from './deps';
import { matchIntent, type VoiceUiVerb } from './intents';
import { runToolLoop, type VoiceCtx } from './toolLoop';
import {
  createFaultWorkOrder,
  runReportFault,
  type FaultStage,
  type FaultResult,
} from './reportFault';
import { useVoice } from './useVoice';
import { isEmbeddedInFacilio, openRecordSummary } from '../api/nav';
import { draftWorkOrder, readNameplate } from '../api/agents';
import { appStore } from '../api/appStore';
import Icon from '../components/Icon';
import type { Asset, WorkOrderStatus } from '../api/types';
import './effi.css';

/** Visual-intelligence actions: act on what the CAMERA sees. */
type VisualAction = 'workorder' | 'finding' | 'identify' | 'nameplate' | 'directions';

type Phase = 'idle' | 'menu' | 'listening' | 'thinking' | 'reply';

const UI_CONFIRMATION: Record<VoiceUiVerb, string> = {
  rescan: 'Rescanning.',
  minimize: 'Minimised.',
  expand: 'Expanded.',
  pin: 'Pinned here.',
  tasks: 'Showing tasks.',
  clear: 'Board cleared.',
};

const STAGE_COPY: Record<FaultStage, string> = {
  uploading: 'Uploading the photo…',
  drafting: 'Drafting the work order…',
  identifying: 'Identifying the asset…',
  confirm: 'Which asset is this?',
  creating: 'Creating the work order…',
  done: 'Done.',
};

/** The record card the reply carries — a result you can act on, not prose. */
interface ActionCard {
  title: string;
  fields: Array<[string, string]>;
  workOrderId?: number;
}

const FacilioMark = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={Math.round(size * 1.45)} viewBox="0 0 220 320" fill="none" aria-hidden="true">
    <path d="M 74 292 L 74 96 A 74 74 0 0 1 148 22 L 148 74 A 22 22 0 0 0 126 96 L 126 292 Z" fill="#fff" />
  </svg>
);

export default function EffiOverlay({
  open,
  onOpenChange,
  deps = defaultDeps,
  assetInView,
  workOrderInView,
  captureFrame,
  onUiAction,
  woUrl,
  hideOrb,
  onPinFinding,
  onShowAsset,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  deps?: VoiceDeps;
  assetInView?: { id: number; name: string };
  workOrderInView?: number;
  captureFrame?: () => Promise<Blob | null>;
  onUiAction?: (verb: VoiceUiVerb) => void;
  /** Deep-link template — puts "Open work order" on the reply card. */
  woUrl?: (id: number) => string | null;
  /** An open AR window owns that corner — the idle orb yields to it. */
  hideOrb?: boolean;
  /** Pin a FINDING at the current aim (AR screen owns markers). Resolves to
   * a confirmation line; rejects with guidance when not localized. */
  onPinFinding?: (text: string) => Promise<string>;
  /** Focus an asset window in AR (identify lane hands off to the HUD). */
  onShowAsset?: (assetId: number) => void;
}) {
  const { scope, names } = useLocationScope();
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [pendingWords, setPendingWords] = useState('');
  const [thinkText, setThinkText] = useState('');
  const [reply, setReply] = useState('');
  const [card, setCard] = useState<ActionCard | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [statuses, setStatuses] = useState<WorkOrderStatus[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<FaultResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let live = true;
    deps
      .getStatuses()
      .then((rows) => live && setStatuses(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [deps]);

  const ctx = useMemo<VoiceCtx>(
    () => ({ siteId: scope.siteId, assetInView: assetInView?.id, workOrderInView }),
    [scope.siteId, assetInView?.id, workOrderInView],
  );

  /** A created/acted-on work order becomes the reply CARD. */
  const cardFor = useCallback(
    (workOrderId: number | undefined, subject: string | undefined): ActionCard | null => {
      if (!workOrderId && !subject) return null;
      const fields: Array<[string, string]> = [];
      if (assetInView) fields.push(['Asset', assetInView.name]);
      if (names.site) fields.push(['Site', names.site]);
      const space = names.floor ?? names.building;
      if (space) fields.push(['Space', space]);
      if (subject) fields.push(['Fault', subject]);
      return {
        title: workOrderId ? `Work order #${workOrderId}` : (subject ?? 'Result'),
        fields,
        workOrderId,
      };
    },
    [assetInView, names.site, names.floor, names.building],
  );

  const answerWith = useCallback(
    (text: string, actionCard: ActionCard | null = null, toastText?: string) => {
      setReply(text);
      setCard(actionCard);
      setPhase('reply');
      if (toastText) setToast(toastText);
      deps.speak(text);
    },
    [deps],
  );

  const handleUtterance = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      setHeard(text);
      setPendingWords('');

      const action = matchIntent(text, {
        statuses,
        workOrderInView,
        assetInView: assetInView?.id,
      });

      if (action?.type === 'ui') {
        onUiAction?.(action.verb);
        answerWith(UI_CONFIRMATION[action.verb]);
        return;
      }

      busyRef.current = true;
      setPhase('thinking');
      try {
        if (action?.type === 'change_status') {
          setThinkText(`Moving #${action.workOrderId} to ${action.label}…`);
          await deps.changeStatus(action.workOrderId, action.status);
          answerWith(
            `#${action.workOrderId} is now ${action.label}.`,
            cardFor(action.workOrderId, undefined),
            `Work order #${action.workOrderId} → ${action.label}`,
          );
          return;
        }

        setThinkText(assetInView ? `Checking ${assetInView.name}…` : 'Working on it…');
        const result = await runToolLoop(text, ctx, deps, (entry) =>
          setThinkText(`${entry.tool.replaceAll('_', ' ')}…`),
        );
        const woMatch = /#(\d{3,})/.exec(result.answer);
        answerWith(
          result.answer,
          woMatch ? cardFor(Number(woMatch[1]), undefined) : null,
        );
      } catch (err) {
        answerWith(err instanceof Error ? err.message : 'That failed — try again.');
      } finally {
        busyRef.current = false;
      }
    },
    [statuses, workOrderInView, assetInView, onUiAction, deps, ctx, answerWith, cardFor],
  );

  const voice = useVoice(
    (text) => void handleUtterance(text),
    (finalText, pending) => {
      setHeard(finalText);
      setPendingWords(pending);
    },
  );

  const analyze = useCallback(
    async (photo: Blob) => {
      busyRef.current = true;
      setPhase('thinking');
      setPendingConfirm(null);
      try {
        const result = await runReportFault(
          photo,
          { scope, assetInView, names: { site: names.site, space: names.floor ?? names.building } },
          deps,
          (next) => setThinkText(STAGE_COPY[next]),
        );
        if (result.needsConfirm) {
          setPendingConfirm(result);
          answerWith(`"${result.draft.subject}" — which asset is this?`);
        } else {
          answerWith(
            `Done. Work order #${result.workOrderId} is open — ${result.draft.subject}.`,
            cardFor(result.workOrderId, result.draft.subject),
            `Work order #${result.workOrderId} created`,
          );
        }
      } catch (err) {
        answerWith(`Report failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      } finally {
        busyRef.current = false;
      }
    },
    [scope, assetInView, names.site, names.floor, names.building, deps, answerWith, cardFor],
  );

  const confirmAsset = useCallback(
    async (asset: Asset) => {
      if (!pendingConfirm) return;
      busyRef.current = true;
      setPhase('thinking');
      setThinkText(`Creating on ${asset.name}…`);
      try {
        const id = await createFaultWorkOrder(pendingConfirm.draft, asset.id, { scope }, deps);
        setPendingConfirm(null);
        answerWith(
          `Work order #${id} is open on ${asset.name}.`,
          cardFor(id, pendingConfirm.draft.subject),
          `Work order #${id} created`,
        );
      } catch (err) {
        answerWith(`Create failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      } finally {
        busyRef.current = false;
      }
    },
    [pendingConfirm, scope, deps, answerWith, cardFor],
  );

  const startListening = () => {
    setHeard('');
    setPendingWords('');
    setReply('');
    setCard(null);
    setPendingConfirm(null);
    if (voice.supported) {
      setPhase('listening');
      if (!voice.listening) voice.toggle();
    } else {
      setPhase('listening'); // typed fallback — same panel, keyboard instead
    }
  };

  /** One visual-intelligence action: SNAP the frame, run the lane, reply as
   * a card. Every lane degrades to guidance, never to a dead end. */
  const runVisual = useCallback(
    async (action: VisualAction) => {
      if (action === 'directions') {
        // directions are conversational — the loop has find/navigate tools
        startListening();
        setHeard('');
        setReply('');
        return;
      }
      if (action === 'identify') {
        // the HUD's recognition loop IS the identifier — hand off to it
        if (assetInView) {
          onShowAsset?.(assetInView.id);
          answerWith(`That's ${assetInView.name} — opening it in AR.`);
          onOpenChange(false);
          setPhase('idle');
        } else {
          answerWith(
            'Point the camera straight at the asset and hold — the moment I recognise it, its window opens on screen.',
          );
        }
        return;
      }

      busyRef.current = true;
      setPhase('thinking');
      try {
        const photo = captureFrame ? await captureFrame() : null;
        if (!photo) {
          answerWith('I could not grab a frame — is the camera running?');
          return;
        }

        if (action === 'workorder') {
          busyRef.current = false;
          await analyze(photo); // existing photo→draft→create lane
          return;
        }

        if (action === 'nameplate') {
          setThinkText('Reading the nameplate…');
          const fileId = await appStore.uploadPhoto(photo, `effi-plate-${Date.now()}.jpg`);
          const plate = await readNameplate(fileId);
          const fields: Array<[string, string]> = [];
          for (const [label, value] of [
            ['Manufacturer', plate.manufacturer],
            ['Model', plate.model],
            ['Serial', plate.serial],
          ] as const) {
            if (value && value !== 'none') fields.push([label, value]);
          }
          if (fields.length === 0) {
            answerWith('I could not read a nameplate in this frame — get closer and square-on.');
          } else {
            answerWith('Here is what the nameplate says.', { title: 'Nameplate', fields });
          }
          return;
        }

        // finding: AI drafts what it sees, the AR screen pins it at the aim
        setThinkText('Describing what I see…');
        const fileId = await appStore.uploadPhoto(photo, `effi-find-${Date.now()}.jpg`);
        const draft = await draftWorkOrder(
          fileId,
          `Field finding${assetInView ? ` near ${assetInView.name}` : ''}${names.site ? ` at ${names.site}` : ''} — describe the observation, no job needed yet`,
        );
        if (!onPinFinding) {
          answerWith(`Finding noted: ${draft.subject}`);
          return;
        }
        setThinkText('Pinning the finding here…');
        const confirmation = await onPinFinding(draft.subject);
        answerWith(confirmation, { title: 'Finding', fields: [['Observation', draft.subject]] }, 'Finding pinned');
      } catch (err) {
        answerWith(err instanceof Error ? err.message : 'That failed — try again.');
      } finally {
        busyRef.current = false;
      }
    },
    [assetInView, names.site, captureFrame, analyze, answerWith, onPinFinding, onShowAsset, onOpenChange],
  );

  const close = () => {
    if (voice.listening) voice.toggle();
    setPhase('idle');
    onOpenChange(false);
  };

  // the surface (rail button / window action) asked for Effi
  useEffect(() => {
    if (open && phase === 'idle') setPhase('menu');
    if (!open && phase !== 'idle') {
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openWoLink = card?.workOrderId ? woUrl?.(card.workOrderId) : null;

  return (
    <>
      {/* toast: the side effect, confirmed at the top of the frame */}
      {toast && (
        <div className="ef-toast" role="status">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {toast}
        </div>
      )}

      {/* the orb — floats above every AR surface, clear of the marker field */}
      {phase === 'idle' && !hideOrb && (
        <div className="ef-orb-slot">
          <span className="ef-hint">Tap to talk</span>
          <button
            type="button"
            className="ef-orb"
            aria-label="Talk to Effi"
            onClick={() => onOpenChange(true)}
          >
            <span className="ef-core" aria-hidden="true">
              <span className="ef-swirl" />
              <span className="ef-specular" />
              <Icon name="sparkle" size={26} />
            </span>
          </button>
        </div>
      )}

      {phase !== 'idle' && (
        <>
          <div className="ef-dim" onClick={close} />
          <section className="ef-panel" aria-label="Effi voice agent">
            <div className="ef-status">
              <span className="ef-status-left">
                <span
                  className="ef-status-dot"
                  style={{
                    background:
                      phase === 'listening'
                        ? '#2ED1FF'
                        : phase === 'thinking'
                          ? '#FFD405'
                          : phase === 'menu'
                            ? '#7D63DC'
                            : '#29A01E',
                  }}
                />
                {phase === 'listening'
                  ? 'Listening'
                  : phase === 'thinking'
                    ? 'Working on it'
                    : phase === 'menu'
                      ? 'Visual intelligence'
                      : 'Effi'}
              </span>
              <button type="button" className="ef-x" aria-label="Close Effi" onClick={close}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {phase === 'menu' && (
              <div className="ef-menu">
                <p className="ef-menu-lead">
                  What do you see?{assetInView ? ` Looking at ${assetInView.name}.` : ''}
                </p>
                <div className="ef-vi-grid">
                  <button type="button" className="ef-vi" onClick={() => void runVisual('workorder')}>
                    <Icon name="list" size={20} />
                    Create work order
                  </button>
                  <button type="button" className="ef-vi" onClick={() => void runVisual('finding')}>
                    <Icon name="note" size={20} />
                    Record a finding
                  </button>
                  <button type="button" className="ef-vi" onClick={() => void runVisual('identify')}>
                    <Icon name="search" size={20} />
                    Find the asset
                  </button>
                  <button type="button" className="ef-vi" onClick={() => void runVisual('nameplate')}>
                    <Icon name="qr" size={20} />
                    Read nameplate
                  </button>
                  <button type="button" className="ef-vi" onClick={() => void runVisual('directions')}>
                    <Icon name="route" size={20} />
                    Directions
                  </button>
                  <button type="button" className="ef-vi ef-vi-ask" onClick={startListening}>
                    <Icon name="mic" size={20} />
                    Ask anything
                  </button>
                </div>
              </div>
            )}

            {phase !== 'menu' && (
            <p className="ef-heard">
              {heard}
              {pendingWords && <span className="ef-pending"> {pendingWords}</span>}
              {phase === 'listening' && <span className="ef-caret">|</span>}
              {!heard && !pendingWords && phase === 'listening' && (
                <span className="ef-pending">
                  {voice.supported ? 'Say it — “log a work order for this asset”…' : 'Type it below…'}
                </span>
              )}
            </p>
            )}

            {phase === 'listening' && voice.supported && (
              <div className="ef-wave" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <span key={i} className={`ef-bar b${i % 3}`} style={{ animationDelay: `${i * 60}ms` }} />
                ))}
                <span className="ef-wave-hint">Pause to send</span>
              </div>
            )}

            {phase === 'listening' && !voice.supported && (
              <form
                className="ef-typed"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = typed;
                  setTyped('');
                  void handleUtterance(text);
                }}
              >
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Type a command"
                  aria-label="Voice command"
                />
                <button type="submit" disabled={!typed.trim()}>
                  Send
                </button>
              </form>
            )}

            {phase === 'thinking' && (
              <div className="ef-think">
                <span className="ef-think-dots" aria-hidden="true">
                  <span />
                  <span style={{ animationDelay: '140ms' }} />
                  <span style={{ animationDelay: '280ms' }} />
                </span>
                {thinkText || 'Working on it…'}
              </div>
            )}

            {phase === 'reply' && (
              <div className="ef-reply">
                <div className="ef-reply-row">
                  <span className="ef-avatar">
                    <FacilioMark />
                  </span>
                  <p className="ef-reply-text">{reply}</p>
                </div>

                {pendingConfirm?.needsConfirm && (
                  <div className="ef-card">
                    <span className="ef-card-title">Confirm the asset — nothing is created until you pick</span>
                    {pendingConfirm.needsConfirm.map((asset) => (
                      <button key={asset.id} type="button" className="ef-chip" onClick={() => void confirmAsset(asset)}>
                        {asset.name}
                        {asset.spaceName ? ` · ${asset.spaceName}` : ''}
                      </button>
                    ))}
                  </div>
                )}

                {card && (
                  <div className="ef-card">
                    <div className="ef-card-head">
                      <span className="ef-card-title">{card.title}</span>
                    </div>
                    {card.fields.length > 0 && (
                      <div className="ef-card-grid">
                        {card.fields.map(([k, v]) => (
                          <span key={k} className="ef-card-cell">
                            <span className="k">{k}</span>
                            <span className="v">{v}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="ef-card-actions">
                      {card.workOrderId != null && isEmbeddedInFacilio() ? (
                        <button
                          type="button"
                          className="ef-btn-primary"
                          onClick={() => void openRecordSummary('workorder', card.workOrderId as number)}
                        >
                          Open work order
                        </button>
                      ) : openWoLink ? (
                        <a className="ef-btn-primary" href={openWoLink} target="_blank" rel="noopener noreferrer">
                          Open work order
                        </a>
                      ) : null}
                      {card.workOrderId != null && (
                        <button
                          type="button"
                          className="ef-btn-quiet"
                          onClick={() => {
                            onUiAction?.('tasks');
                            close();
                          }}
                        >
                          Show in AR
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="ef-suggest">
                  <button type="button" className="ef-chip" onClick={() => setPhase('menu')}>
                    Actions
                  </button>
                  <button type="button" className="ef-chip" onClick={startListening}>
                    Ask again
                  </button>
                  <button
                    type="button"
                    className="ef-chip"
                    onClick={() => {
                      if (captureFrame) {
                        void captureFrame().then((photo) => photo && analyze(photo));
                      } else {
                        fileRef.current?.click();
                      }
                    }}
                  >
                    Add a photo → work order
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <input
        ref={fileRef}
        className="ef-file"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Fault photo"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void analyze(file);
        }}
      />
    </>
  );
}
