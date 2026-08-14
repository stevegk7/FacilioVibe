import { useState } from 'react';
import {
  useChangeWorkOrderStatus,
  useCreateWorkOrder,
  useSetTaskStatus,
  useWorkOrderStatuses,
  useWorkOrdersForAsset,
  useWorkOrderTasks,
} from '../api/hooks';
import DsSelect from './DsSelect';
import type { Asset, WorkOrder } from '../api/types';

// Status → Atom badge class. Unknown statuses fall back to draft-grey.
function badgeClass(status?: string): string {
  switch ((status ?? '').toLowerCase()) {
    case 'open':
    case 'submitted':
    case 'assigned':
      return 'badge b-open';
    case 'in progress':
    case 'work in progress':
    case 'processing':
      return 'badge b-prog';
    case 'resolved':
    case 'closed':
      return 'badge b-done';
    case 'on hold':
    case 'overdue':
    case 'incomplete':
      return 'badge b-over';
    default:
      return 'badge b-draft';
  }
}

function TaskList({ workOrderId }: { workOrderId: number }) {
  const tasks = useWorkOrderTasks(workOrderId);
  const setTask = useSetTaskStatus(workOrderId);

  if (tasks.isLoading) return <p className="muted small">Loading tasks…</p>;
  if (tasks.isError) return <p className="error small">{(tasks.error as Error).message}</p>;
  if (!tasks.data?.length) return <p className="muted small">No checklist on this work order.</p>;

  return (
    <div>
      {tasks.data.map((task) => (
        <div key={task.id} className={task.closed ? 'task-row closed' : 'task-row'}>
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
      {setTask.isError && <p className="error small">{(setTask.error as Error).message}</p>}
    </div>
  );
}

function WorkOrderRow({ workOrder, assetId }: { workOrder: WorkOrder; assetId: number }) {
  const [expanded, setExpanded] = useState(false);
  const statuses = useWorkOrderStatuses();
  const changeStatus = useChangeWorkOrderStatus(assetId);

  return (
    <div className="kit-card wo-row">
      <button className="wo-row-head" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        <span className="wo-subject">{workOrder.subject}</span>
        <span className={badgeClass(workOrder.status)}>
          <span className="dot" />
          {workOrder.status ?? 'Unknown'}
        </span>
      </button>
      {expanded && (
        <div className="kit-card-bd wo-row-body">
          {workOrder.description && <p className="muted small">{workOrder.description}</p>}
          <dl className="wo-meta">
            {workOrder.priority && (
              <>
                <dt>Priority</dt>
                <dd>{workOrder.priority}</dd>
              </>
            )}
            {workOrder.assignedTo && (
              <>
                <dt>Assignee</dt>
                <dd>{workOrder.assignedTo}</dd>
              </>
            )}
            {workOrder.dueDate && (
              <>
                <dt>Due</dt>
                <dd>{new Date(workOrder.dueDate).toLocaleString()}</dd>
              </>
            )}
          </dl>

          <h4 className="wo-section">Tasks</h4>
          <TaskList workOrderId={workOrder.id} />

          <h4 className="wo-section">Status</h4>
          <div className="row">
            <DsSelect
              label="Move to"
              value=""
              placeholder={workOrder.status ?? 'Select status'}
              options={(statuses.data ?? [])
                .filter((s) => s.label !== workOrder.status)
                .map((s) => ({ value: s.value, label: s.label }))}
              onChange={(status) => changeStatus.mutate({ workOrderId: workOrder.id, status })}
            />
          </div>
          {changeStatus.isPending && <p className="muted small">Updating status…</p>}
          {changeStatus.isError && (
            <p className="error small">{(changeStatus.error as Error).message}</p>
          )}
        </div>
      )}
    </div>
  );
}

function CreateWorkOrder({ asset }: { asset: Asset }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateWorkOrder(asset.id);

  if (!open) {
    return (
      <button className="btn btn-secondary" onClick={() => setOpen(true)}>
        + Create work order
      </button>
    );
  }

  return (
    <form
      className="kit-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!subject.trim()) return;
        create.mutate(
          { subject: subject.trim(), description: description.trim() || undefined, resourceId: asset.id },
          {
            onSuccess: () => {
              setOpen(false);
              setSubject('');
              setDescription('');
            },
          },
        );
      }}
    >
      <div className="kit-card-hd">
        <h3>New work order — {asset.name}</h3>
      </div>
      <div className="kit-card-bd wo-create">
        <label className="field">
          <span>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What needs doing?"
            required
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Optional details for the technician"
          />
        </label>
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {create.isError && <p className="error small">{(create.error as Error).message}</p>}
      </div>
    </form>
  );
}

export default function WorkOrderPanel({ asset }: { asset: Asset }) {
  const workOrders = useWorkOrdersForAsset(asset.id);

  return (
    <section className="wo-panel">
      <div className="wo-panel-head">
        <h3>Work orders</h3>
        {workOrders.data && <span className="muted small">{workOrders.data.length} linked</span>}
      </div>

      {/* Work Order -> Asset -> Location -> Wayfinder. Hand the asset to the
          Wayfinder tab rather than duplicating routing UI here. */}
      <button
        className="btn btn-secondary wo-navigate"
        onClick={() => {
          const url = new URL(window.location.href);
          url.searchParams.set('tab', 'wayfinder');
          url.searchParams.set('asset', String(asset.id));
          window.history.pushState({}, '', url);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }}
      >
        Navigate to asset
      </button>
      {workOrders.isLoading && <p className="muted">Loading work orders…</p>}
      {workOrders.isError && <p className="error">{(workOrders.error as Error).message}</p>}
      {workOrders.data && workOrders.data.length === 0 && (
        <p className="muted">Nothing raised against this asset yet.</p>
      )}
      {workOrders.data?.map((wo) => (
        <WorkOrderRow key={wo.id} workOrder={wo} assetId={asset.id} />
      ))}
      <CreateWorkOrder asset={asset} />
    </section>
  );
}
