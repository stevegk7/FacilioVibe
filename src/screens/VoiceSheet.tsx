/**
 * Voice sheet (roadmap 8) — self-contained: push-to-talk, a transcript, the
 * local-intent fast path, the agent tool loop behind it, and the
 * voice → photo → analyze → create-WO flow.
 *
 * Self-contained on purpose. The integrator mounts this as a tab or docks it
 * into the AR screen later; nothing here reaches into another workstream's
 * surface. Everything that touches the org goes through an injected VoiceDeps,
 * and the camera is an injectable `captureFrame` — the default is the plain
 * file input with capture=environment, which is the only capture that works
 * everywhere including the in-app browsers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocationScope } from '../state/LocationContext';
import { defaultDeps, type VoiceDeps } from '../voice/deps';
import { matchIntent, type VoiceUiVerb } from '../voice/intents';
import { runToolLoop, type VoiceCtx } from '../voice/toolLoop';
import {
  createFaultWorkOrder,
  runReportFault,
  type FaultStage,
  type FaultResult,
} from '../voice/reportFault';
import { useVoice } from '../voice/useVoice';
import type { Asset, WorkOrderStatus } from '../api/types';
import '../voice/voice.css';

type LineRole = 'user' | 'assistant' | 'tool' | 'system';

interface Line {
  id: number;
  role: LineRole;
  text: string;
}

const UI_CONFIRMATION: Record<VoiceUiVerb, string> = {
  rescan: 'Rescanning.',
  minimize: 'Minimised.',
  expand: 'Expanded.',
  pin: 'Pinned here.',
  tasks: 'Showing tasks.',
  clear: 'Board cleared.',
};

const STAGE_COPY: Record<FaultStage, string> = {
  uploading: 'Uploading photo…',
  drafting: 'Drafting the work order…',
  identifying: 'Identifying the asset…',
  confirm: 'Which asset is this?',
  creating: 'Creating the work order…',
  done: 'Done.',
};

export interface VoiceSheetProps {
  deps?: VoiceDeps;
  /** The record the surrounding surface has in view, if any. */
  assetInView?: { id: number; name: string };
  workOrderInView?: number;
  /** Injectable capture — AR passes its frame grabber; default is a file input. */
  captureFrame?: () => Promise<Blob | null>;
  /** UI verbs are executed by whoever owns the surface. */
  onUiAction?: (verb: VoiceUiVerb) => void;
}

export default function VoiceSheet({
  deps = defaultDeps,
  assetInView,
  workOrderInView,
  captureFrame,
  onUiAction,
}: VoiceSheetProps) {
  const { scope, names } = useLocationScope();
  const [lines, setLines] = useState<Line[]>([]);
  const [statuses, setStatuses] = useState<WorkOrderStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [stage, setStage] = useState<FaultStage | null>(null);
  const [pending, setPending] = useState<FaultResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const say = useCallback((role: LineRole, text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, role, text }]);
  }, []);

  // The status catalogue is what makes the fast path fast — one fetch, then
  // every "on hold" is answered locally with no round trip.
  useEffect(() => {
    let live = true;
    deps
      .getStatuses()
      .then((rows) => {
        if (live) setStatuses(rows);
      })
      .catch(() => {
        if (live) say('system', 'Status catalogue unavailable — spoken statuses will go to the assistant.');
      });
    return () => {
      live = false;
    };
  }, [deps, say]);

  const ctx = useMemo<VoiceCtx>(
    () => ({
      siteId: scope.siteId,
      assetInView: assetInView?.id,
      workOrderInView,
    }),
    [scope.siteId, assetInView?.id, workOrderInView],
  );

  const handleUtterance = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      say('user', text);

      const action = matchIntent(text, {
        statuses,
        workOrderInView,
        assetInView: assetInView?.id,
      });

      if (action?.type === 'ui') {
        onUiAction?.(action.verb);
        say('assistant', UI_CONFIRMATION[action.verb]);
        deps.speak(UI_CONFIRMATION[action.verb]);
        return;
      }

      if (action?.type === 'change_status') {
        setBusy(true);
        try {
          await deps.changeStatus(action.workOrderId, action.status);
          const done = `#${action.workOrderId} is now ${action.label}.`;
          say('assistant', done);
          deps.speak(done);
        } catch (err) {
          say('system', `Could not change status: ${err instanceof Error ? err.message : 'failed'}`);
        } finally {
          setBusy(false);
        }
        return;
      }

      // Miss → the agent loop, with the tools running here.
      setBusy(true);
      try {
        const result = await runToolLoop(text, ctx, deps, (entry) =>
          say('tool', `${entry.tool} → ${entry.result}`),
        );
        say('assistant', result.answer);
      } finally {
        setBusy(false);
      }
    },
    [busy, statuses, workOrderInView, assetInView?.id, onUiAction, deps, ctx, say],
  );

  const voice = useVoice((text) => void handleUtterance(text));

  const analyze = useCallback(
    async (photo: Blob) => {
      setBusy(true);
      setPending(null);
      try {
        const result = await runReportFault(
          photo,
          {
            scope,
            assetInView,
            names: { site: names.site, space: names.floor ?? names.building },
          },
          deps,
          (next) => {
            setStage(next);
            say('system', STAGE_COPY[next]);
          },
        );
        if (result.needsConfirm) {
          setPending(result);
          say('assistant', `"${result.draft.subject}" — which asset is this?`);
        } else {
          say('assistant', `Work order #${result.workOrderId} — ${result.draft.subject}`);
        }
      } catch (err) {
        say('system', `Report failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      } finally {
        setStage(null);
        setBusy(false);
      }
    },
    [scope, assetInView, names.site, names.floor, names.building, deps, say],
  );

  const reportFault = useCallback(async () => {
    if (captureFrame) {
      const photo = await captureFrame();
      if (photo) await analyze(photo);
      return;
    }
    fileRef.current?.click();
  }, [captureFrame, analyze]);

  const confirmAsset = useCallback(
    async (asset: Asset) => {
      if (!pending) return;
      setBusy(true);
      try {
        const id = await createFaultWorkOrder(pending.draft, asset.id, { scope }, deps);
        say('assistant', `Work order #${id} on ${asset.name}.`);
        setPending(null);
      } catch (err) {
        say('system', `Create failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      } finally {
        setBusy(false);
      }
    },
    [pending, scope, deps, say],
  );

  return (
    <section className="voice-sheet" aria-label="Voice assistant">
      <header className="voice-head">
        <h2>Voice</h2>
        <div className="voice-chips">
          {names.site && <span className="voice-chip">{names.site}</span>}
          {(names.floor ?? names.building) && (
            <span className="voice-chip">{names.floor ?? names.building}</span>
          )}
          {assetInView && <span className="voice-chip">{assetInView.name}</span>}
          {workOrderInView && <span className="voice-chip">#{workOrderInView}</span>}
          {!names.site && !assetInView && !workOrderInView && (
            <span className="voice-chip muted">No context</span>
          )}
        </div>
      </header>

      <div className="voice-log" role="log" aria-live="polite">
        {lines.length === 0 && (
          <p className="voice-empty">
            Try “start work”, “rescan”, or ask for a work order on an asset.
          </p>
        )}
        {lines.map((line) => (
          <p key={line.id} className={`voice-line ${line.role}`}>
            <span className="voice-role">{line.role}</span>
            {line.text}
          </p>
        ))}
        {stage && <p className="voice-line system">{STAGE_COPY[stage]}</p>}
      </div>

      {pending?.needsConfirm && (
        <div className="voice-confirm">
          <p className="voice-confirm-title">Confirm the asset — nothing is created until you pick.</p>
          <ul>
            {pending.needsConfirm.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  className="voice-candidate"
                  disabled={busy}
                  onClick={() => void confirmAsset(asset)}
                >
                  {asset.name}
                  {asset.spaceName && <span className="muted"> · {asset.spaceName}</span>}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="voice-secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}

      <footer className="voice-controls">
        {voice.supported ? (
          <button
            type="button"
            className={voice.listening ? 'voice-ptt listening' : 'voice-ptt'}
            aria-pressed={voice.listening}
            disabled={busy}
            onClick={voice.toggle}
          >
            {voice.listening ? 'Listening…' : 'Hold to talk'}
          </button>
        ) : (
          <form
            className="voice-fallback"
            onSubmit={(e) => {
              e.preventDefault();
              const text = typed;
              setTyped('');
              void handleUtterance(text);
            }}
          >
            <input
              className="voice-input"
              type="text"
              value={typed}
              placeholder="Type a command"
              aria-label="Voice command"
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button type="submit" className="voice-send" disabled={busy || !typed.trim()}>
              Send
            </button>
          </form>
        )}
        <button type="button" className="voice-secondary" disabled={busy} onClick={() => void reportFault()}>
          Report a fault
        </button>
        <input
          ref={fileRef}
          className="voice-file"
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
      </footer>
    </section>
  );
}
