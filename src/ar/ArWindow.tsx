/**
 * ArWindow — a visionOS-style window ANCHORED IN SPACE at an asset marker.
 *
 * This replaces the screen-fixed side panel: the full work surface — work
 * order list, work order summary, task execution, status transitions, AI —
 * lives on the glass window that floats where the asset physically is. The
 * anatomy follows visionOS: a title bar, vibrancy-tiered text on a blurred
 * glass material, capsule actions, an ornament floating OUTSIDE the top edge
 * for the "leave AR" deep link, and a bottom grabber that drags to expand.
 *
 * Navigation is a stack INSIDE the window (home → work orders → one work
 * order), visionOS-style progressive disclosure rather than new layers.
 */
import { useRef, useState } from 'react';
import { goToTab } from '../shell/router';
import {
  useAddWorkOrderTask,
  useExecuteWorkOrderAction,
  useSetTaskStatus,
  useWorkOrderActions,
  useWorkers,
  useWorkOrdersForAsset,
  useWorkOrderTasks,
} from '../api/hooks';
import { briefAsset, suggestTasks } from '../api/agents';
import { capabilityForAction } from '../api/roles';
import { useCan } from '../state/SessionContext';
import type { Asset, RecordAction, RecordActions, WorkOrder } from '../api/types';
import Icon from '../components/Icon';
import { isEmbeddedInFacilio, openRecordSummary } from '../api/nav';
import './visionGlass.css';

type View = { kind: 'home' } | { kind: 'wos' } | { kind: 'wo'; wo: WorkOrder };

/** Status → the one colour that varies (Atom families, tuned for glass). */
function statusTone(status?: string): 'open' | 'prog' | 'done' | 'hold' {
  const s = (status ?? '').toLowerCase();
  if (['resolved', 'closed'].includes(s)) return 'done';
  if (['in progress', 'work in progress', 'processing'].includes(s)) return 'prog';
  if (['on hold', 'overdue', 'incomplete'].includes(s)) return 'hold';
  return 'open';
}

const BODY_MIN = 180;
const BODY_MAX = () => Math.round(window.innerHeight * 0.52);

const OPEN_TONES = ['open', 'submitted', 'assigned', 'in progress', 'work in progress', 'processing'];
const PLANNED_TONES = ['on hold', 'scheduled', 'pre-open', 'preopen', 'yet to start'];

export default function ArWindow({
  asset,
  openCount,
  plannedCount,
  woUrl,
  assetUrl,
  onMinimize,
  onVoice,
  onFault,
}: {
  asset: Asset;
  /** Fallbacks while the window's own query loads. */
  openCount: number;
  plannedCount: number;
  /** Deep-link template results — null hides the ornament. */
  woUrl: (id: number) => string | null;
  assetUrl: (id: number) => string | null;
  onMinimize(): void;
  onVoice(): void;
  onFault(): void;
}) {
  const [view, setView] = useState<View>({ kind: 'home' });
  const [bodyH, setBodyH] = useState(240);
  const workOrders = useWorkOrdersForAsset(asset.id);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // The chips and the list must be the SAME truth. The parent's counts come
  // from a site-wide query that can lag a just-created record; the window's
  // own per-asset query is what the list shows, so the chips follow it.
  const wos = workOrders.data;
  const open = wos
    ? wos.filter((w) => OPEN_TONES.includes((w.status ?? '').toLowerCase())).length
    : openCount;
  const planned = wos
    ? wos.filter((w) => PLANNED_TONES.includes((w.status ?? '').toLowerCase())).length
    : plannedCount;

  // The asset can be up on a wall or ceiling — the pin stays on the asset,
  // but the DIALOGUE can be pulled down to a comfortable holding position.
  // Drag the title bar; double-tap it to snap back to the anchor.
  const [winOff, setWinOff] = useState({ x: 0, y: 0 });
  const barDrag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [brief, setBrief] = useState<{ busy: boolean; text: string | null }>({
    busy: false,
    text: null,
  });
  const runBrief = () => {
    if (brief.busy) return;
    setBrief({ busy: true, text: null });
    void briefAsset(asset, workOrders.data ?? [])
      .then((text) => setBrief({ busy: false, text }))
      .catch(() => setBrief({ busy: false, text: null }));
  };

  const link =
    view.kind === 'wo' ? woUrl(view.wo.id) : assetUrl(asset.id);

  const title =
    view.kind === 'home' ? asset.name : view.kind === 'wos' ? 'Work orders' : `#${view.wo.id}`;

  return (
    <div
      className="vg-anchor"
      style={winOff.x || winOff.y ? { transform: `translate(${winOff.x}px, ${winOff.y}px)` } : undefined}
    >
      <span className="vg-anchor-dot" aria-hidden="true" />
      {/* ornament: floats OUTSIDE the window's top edge, visionOS-style.
          ALWAYS present. Preference order: the HOST's own navigation when the
          app runs embedded in Facilio (openSummary — zero config, always the
          right route), then the Settings URL template, then a walk to
          Settings — an affordance that silently vanishes reads as a bug. */}
      {isEmbeddedInFacilio() ? (
        <button
          type="button"
          className="vg-ornament"
          onClick={() =>
            void openRecordSummary(
              view.kind === 'wo' ? 'workorder' : 'asset',
              view.kind === 'wo' ? view.wo.id : asset.id,
            )
          }
        >
          <Icon name="external" size={14} />
          {view.kind === 'wo' ? 'Open summary in Facilio' : 'Open in Facilio'}
        </button>
      ) : link ? (
        <a className="vg-ornament" href={link} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={14} />
          {view.kind === 'wo' ? 'Open summary in Facilio' : 'Open in Facilio'}
        </a>
      ) : (
        <button
          type="button"
          className="vg-ornament"
          title="Set your org's summary URL in Settings"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set('tab', 'settings');
            window.history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          <Icon name="external" size={14} />
          {view.kind === 'wo' ? 'Open summary — set link in Settings' : 'Open in Facilio — set link'}
        </button>
      )}

      <aside className="vg-window" role="complementary" aria-label={asset.name}>
        <header
          className="vg-bar vg-bar-grab"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            barDrag.current = { x: e.clientX, y: e.clientY, ox: winOff.x, oy: winOff.y };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = barDrag.current;
            if (!d) return;
            setWinOff({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
          }}
          onPointerUp={() => {
            barDrag.current = null;
          }}
          onDoubleClick={() => setWinOff({ x: 0, y: 0 })}
        >
          {view.kind !== 'home' && (
            <button
              className="vg-icon-btn"
              aria-label="Back"
              onClick={() => setView(view.kind === 'wo' ? { kind: 'wos' } : { kind: 'home' })}
            >
              <Icon name="chevron-left" size={18} />
            </button>
          )}
          <h3 className="vg-title">{title}</h3>
          <button className="vg-icon-btn" aria-label={`Minimize ${asset.name}`} onClick={onMinimize}>
            <span className="vg-minus" aria-hidden="true" />
          </button>
        </header>

        <div className="vg-body scroll-y" style={{ maxHeight: bodyH }}>
          {view.kind === 'home' && (
            <>
              <div className="vg-chip-row">
                {open > 0 && <span className="vg-chip t-open">{open} open</span>}
                {planned > 0 && <span className="vg-chip t-hold">{planned} planned</span>}
                {open === 0 && planned === 0 && (
                  <span className="vg-chip t-done">No open work</span>
                )}
              </div>

              <dl className="vg-meta">
                <dt>Asset</dt>
                <dd>
                  {asset.name} · #{asset.id}
                </dd>
                {asset.category && (
                  <>
                    <dt>Category</dt>
                    <dd>{asset.category}</dd>
                  </>
                )}
                {asset.spaceName && (
                  <>
                    <dt>Location</dt>
                    <dd>{asset.spaceName}</dd>
                  </>
                )}
              </dl>

              <button className="vg-row vg-row-primary" onClick={() => setView({ kind: 'wos' })}>
                <Icon name="list" size={18} />
                <span className="vg-row-main">Work orders</span>
                <span className="vg-row-meta">
                  {workOrders.isLoading ? '…' : (workOrders.data?.length ?? 0)}
                </span>
                <Icon name="chevron-right" size={16} className="vg-row-chev" />
              </button>

              <div className="vg-action-grid">
                <button className="vg-action" onClick={onFault}>
                  <Icon name="alert" size={18} />
                  Create work order
                </button>
                <button className="vg-action" onClick={onVoice}>
                  <Icon name="mic" size={18} />
                  Voice
                </button>
                {/* The reverse handoff. Deliberately a button and not automatic:
                    a QR scan or a visual lock still just opens this window, because
                    yanking a technician out of the camera mid-task would be wrong. */}
                <button
                  className="vg-action"
                  onClick={() => goToTab('estate', { asset: asset.id })}
                >
                  <Icon name="cube" size={18} />
                  Show in 3D
                </button>
                <button className="vg-action" onClick={runBrief} disabled={brief.busy}>
                  <Icon name="sparkle" size={18} />
                  {brief.busy ? 'Briefing…' : 'AI brief'}
                </button>
              </div>

              {(brief.busy || brief.text) && (
                <div className="vg-brief" role="status">
                  {brief.busy ? 'Reading the asset’s open work…' : brief.text}
                </div>
              )}
            </>
          )}

          {view.kind === 'wos' && (
            <>
              {workOrders.isLoading && <p className="vg-dim">Loading work orders…</p>}
              {workOrders.data?.length === 0 && (
                <p className="vg-dim">Nothing raised against this asset yet.</p>
              )}
              {workOrders.data?.map((wo) => (
                <button key={wo.id} className="vg-row" onClick={() => setView({ kind: 'wo', wo })}>
                  <span className={`vg-dot t-${statusTone(wo.status)}`} />
                  <span className="vg-row-main">
                    <span className="vg-row-title">{wo.subject}</span>
                    <span className="vg-row-sub">
                      #{wo.id}
                      {wo.status ? ` · ${wo.status}` : ''}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={16} className="vg-row-chev" />
                </button>
              ))}
            </>
          )}

          {view.kind === 'wo' && <WoDetail wo={view.wo} assetId={asset.id} assetName={asset.name} />}
        </div>

        {/* the visionOS grabber: drag to give the window more room */}
        <div
          className="vg-grabber"
          role="separator"
          aria-label="Resize window"
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h: bodyH };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const next = drag.current.h + (e.clientY - drag.current.y);
            setBodyH(Math.max(BODY_MIN, Math.min(BODY_MAX(), next)));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onDoubleClick={() => setBodyH((h) => (h > 300 ? 240 : BODY_MAX()))}
        >
          <span />
        </div>
      </aside>
    </div>
  );
}

/** One work order, in place: summary, checklist execution, status actions —
 * the same moves as the Facilio summary page, without leaving the camera. */
function WoDetail({ wo, assetId, assetName }: { wo: WorkOrder; assetId: number; assetName?: string }) {
  const tasks = useWorkOrderTasks(wo.id);
  const setTask = useSetTaskStatus(wo.id);
  const addTask = useAddWorkOrderTask(wo.id);
  const actions = useWorkOrderActions(wo.id);
  const runAction = useExecuteWorkOrderAction(wo.id, assetId);
  const can = useCan();
  const done = (tasks.data ?? []).filter((t) => t.closed).length;

  /* The flow's answer, filtered through THIS app's capability matrix. The flow
     is authoritative about what the state allows; the matrix is authoritative
     about what this role may do — and for this org the flow offers "Assign
     Worker" to technicians, so without this filter the strip was tight on what
     a technician could see and wide open on what they could press. Buttons the
     matrix doesn't name pass through untouched. */
  const visibleActions = (actions.data?.stateTransitions ?? [])
    .concat(actions.data?.approvalTransitions ?? [])
    .concat(actions.data?.customButtons ?? [])
    .filter((action) => {
      const gate = capabilityForAction(action.name);
      return gate === null || can(gate);
    });

  // `wo` is a snapshot captured into the view stack when the row was tapped, so
  // it does not change when a transition lands. The flow's own answer does, and
  // it is authoritative — prefer it for the status chip.
  const status = actions.data?.currentState?.displayName ?? wo.status;

  // A transition that declares a form needs its input before it will run, so
  // the button opens the form in place rather than firing.
  const [openForm, setOpenForm] = useState<RecordAction | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  // Only fetched once a form that needs people is actually open.
  const needsPeople = (openForm?.form?.fields ?? []).some(isPersonField);
  const workers = useWorkers(needsPeople);

  // AI-proposed checklist: each proposal is a chip; tapping WRITES that task.
  // Proposals the agent already sees exist are filtered by the agent seam.
  const [proposed, setProposed] = useState<{ busy: boolean; tasks: string[] }>({
    busy: false,
    tasks: [],
  });
  const runSuggest = () => {
    if (proposed.busy) return;
    setProposed({ busy: true, tasks: [] });
    void suggestTasks(
      { subject: wo.subject, description: wo.description },
      assetName,
      (tasks.data ?? []).map((t) => t.subject),
    )
      .then((rows) => setProposed({ busy: false, tasks: rows }))
      .catch(() => setProposed({ busy: false, tasks: [] }));
  };

  return (
    <div className="vg-detail">
      <div className="vg-detail-head">
        <span className="vg-row-title">{wo.subject}</span>
        <span className={`vg-chip t-${statusTone(status)}`}>{status ?? 'Unknown'}</span>
      </div>
      {wo.description && <p className="vg-dim">{wo.description}</p>}
      <dl className="vg-meta">
        {wo.priority && (
          <>
            <dt>Priority</dt>
            <dd>{wo.priority}</dd>
          </>
        )}
        {wo.assignedTo && (
          <>
            <dt>Assignee</dt>
            <dd>{wo.assignedTo}</dd>
          </>
        )}
        {wo.dueDate && (
          <>
            <dt>Due</dt>
            <dd>{new Date(wo.dueDate).toLocaleString()}</dd>
          </>
        )}
      </dl>

      <h4 className="vg-section">
        Tasks
        {tasks.data && tasks.data.length > 0 && (
          <span className="vg-row-meta">
            {done}/{tasks.data.length}
          </span>
        )}
      </h4>
      {tasks.isLoading && <p className="vg-dim">Loading tasks…</p>}
      {tasks.data?.length === 0 && <p className="vg-dim">No checklist on this work order.</p>}
      {tasks.data?.map((task) => (
        <div key={task.id} className={task.closed ? 'vg-task closed' : 'vg-task'}>
          <button
            className={task.closed ? 'task-check on' : 'task-check'}
            aria-label={`${task.closed ? 'Reopen' : 'Complete'}: ${task.subject}`}
            disabled={setTask.isPending}
            onClick={() => setTask.mutate({ taskId: task.id, closed: !task.closed })}
          >
            {task.closed && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12l5 5L20 6" />
              </svg>
            )}
          </button>
          <span>{task.subject}</span>
        </div>
      ))}
      {setTask.isError && <p className="vg-err">{(setTask.error as Error).message}</p>}

      <div className="vg-status-row">
        <button className="vg-status-btn" disabled={proposed.busy} onClick={runSuggest}>
          <Icon name="sparkle" size={14} />
          {proposed.busy ? 'Thinking…' : 'AI: suggest tasks'}
        </button>
        {proposed.tasks.map((subject) => (
          <button
            key={subject}
            className="vg-status-btn"
            disabled={addTask.isPending}
            onClick={() => {
              addTask.mutate(subject);
              setProposed((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t !== subject) }));
            }}
          >
            + {subject}
          </button>
        ))}
      </div>
      {addTask.isError && <p className="vg-err">{(addTask.error as Error).message}</p>}

      <h4 className="vg-section">Actions</h4>
      {/*
        The org's published state flow decides what appears here — not this
        file. It replaced a strip built from the status CATALOGUE minus the
        current status, which offered moves the workflow forbids (every state
        from every other state) and knew nothing about permissions. The flow's
        own answer is already filtered for the record's state, this technician's
        permissions, the approval status and each button's criteria, so a
        transition rejected by the workflow can no longer be offered at all.

        Capsules rather than a dropdown, per the standing rule for this window:
        a select's floating list has no good home inside glass, and everything
        stays in front of a live camera.
      */}
      <div className="vg-status-row" role="group" aria-label="Actions">
        {visibleActions.map((action) => (
            <button
              key={`${action.buttonType}-${action.buttonId}`}
              className="vg-status-btn"
              disabled={runAction.isPending}
              onClick={() => {
                if (action.form?.fields?.length) {
                  setFormValues({});
                  setOpenForm(action);
                  return;
                }
                runAction.mutate({ action });
              }}
            >
              <span className={`vg-dot t-${statusTone(action.name)}`} />
              {action.name}
            </button>
          ))}
        {actions.isLoading && <p className="vg-dim">Reading the workflow…</p>}
        {actions.data && visibleActions.length === 0 && (
          <p className="vg-dim">
            {hasActions(actions.data)
              ? // The flow offered something, the matrix hid all of it. Say so —
                // silence here reads as a broken panel, not a policy.
                'The remaining actions in this state need an administrator.'
              : 'No actions available in this state.'}
          </p>
        )}
      </div>

      {/* Inline, not a Sheet: a Sheet is fixed, full-viewport and opaque, so it
          would hide the camera and every marker — leaving AR to fill in two
          fields is exactly the break this feature exists to avoid. */}
      {openForm && (
        <form
          className="vg-form"
          onSubmit={(e) => {
            e.preventDefault();
            runAction.mutate(
              { action: openForm, formData: formValues },
              { onSuccess: () => setOpenForm(null) },
            );
          }}
        >
          <h4 className="vg-section">{openForm.form?.displayName ?? openForm.name}</h4>
          {(openForm.form?.fields ?? []).map((field) => (
            <label className="vg-field" key={field.name}>
              <span>
                {field.displayName ?? field.name}
                {field.required ? ' *' : ''}
              </span>
              {isPersonField(field) ? (
                /*
                  A person is PICKED, never typed. This was a free-text box, and
                  typing a display name into it earned a 502 every time — the
                  field wants a record reference and got prose. A native select
                  rather than DsSelect: this lives inside the glass window over a
                  live camera, where a floating listbox has no good home.
                */
                <select
                  required={field.required}
                  value={formValues[field.name] ?? ''}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                >
                  <option value="">
                    {workers.isLoading ? 'Loading people…' : 'Select a person'}
                  </option>
                  {(workers.data ?? []).map((w) => (
                    <option key={w.id} value={String(w.id)}>
                      {w.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.displayType === 'number' ? 'number' : 'text'}
                  required={field.required}
                  value={formValues[field.name] ?? ''}
                  onChange={(e) =>
                    setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                />
              )}
            </label>
          ))}
          {needsPeople && workers.isError && (
            <p className="vg-err">Couldn’t load the people list.</p>
          )}
          <div className="vg-form-row">
            <button type="submit" className="vg-status-btn" disabled={runAction.isPending}>
              {openForm.name}
            </button>
            <button type="button" className="vg-status-btn" onClick={() => setOpenForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {runAction.isPending && <p className="vg-dim">Running…</p>}
      {runAction.isError && <p className="vg-err">{(runAction.error as Error).message}</p>}
      {actions.isError && (
        <p className="vg-err">Couldn’t read the workflow: {(actions.error as Error).message}</p>
      )}
    </div>
  );
}

/**
 * Fields that name a PERSON, which must be chosen from the directory rather
 * than typed. The org configures the display type, so match the known one and
 * fall back to the field's own name.
 */
function isPersonField(field: { name: string; displayType?: string }): boolean {
  const type = (field.displayType ?? '').toLowerCase();
  return (
    type.includes('assignment') ||
    type.includes('staff') ||
    type.includes('user') ||
    field.name.toLowerCase() === 'assignment'
  );
}

/** True when the flow offers anything at all — a terminal state offers nothing. */
function hasActions(a: RecordActions): boolean {
  return (
    a.stateTransitions.length + a.approvalTransitions.length + a.customButtons.length > 0
  );
}
