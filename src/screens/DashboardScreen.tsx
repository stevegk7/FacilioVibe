import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { provider } from '../api/provider';
import { appStore, type Collection } from '../api/appStore';
import { useSites } from '../api/hooks';
import type { Survey, WorkOrder } from '../api/types';
import type { CaptureRow } from '../vision/captureStore';
import { ClipboardListIcon, LayoutGridIcon, MapPinIcon } from '../layout/icons';
import '../layout/layout.css';

/**
 * Admin dashboard — the desktop landing screen. Everything here is read-only
 * and mock-compatible: the four stats and three tables come from the provider
 * seam plus the app store, so `?mock=1` renders the whole page from fixtures.
 */

/** KV-backed queries share one key namespace so a single invalidate refreshes them all. */
export const kvKey = (collection: Collection, prefix = '') => ['kv', collection, prefix] as const;

/**
 * Status → Atom badge class. Deliberately a copy of WorkOrderPanel's private
 * mapping rather than a shared import: the panel owns its version, and coupling
 * a dashboard to a detail component's internals is how both end up frozen.
 */
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

/**
 * "Open" is a client-side judgement, not a server flag: the org's moduleState
 * catalogue is free text, so we count everything that is NOT a terminal state.
 * A status nobody anticipated therefore reads as open (visible), never as done.
 */
const TERMINAL = new Set(['closed', 'resolved', 'cancelled', 'canceled', 'rejected']);

export function isOpenStatus(status?: string): boolean {
  return !TERMINAL.has((status ?? '').trim().toLowerCase());
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function Stat({ cap, value, loading }: { cap: string; value: number | undefined; loading: boolean }) {
  return (
    <div className="stat">
      <span className="stat-cap">{cap}</span>
      <span className="stat-num">{loading || value === undefined ? '—' : value}</span>
    </div>
  );
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-tile">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

export default function DashboardScreen() {
  const workOrders = useQuery({
    queryKey: ['workorders', 'all'],
    queryFn: () => provider.listWorkOrders({ pageSize: 200 }).then((p) => p.data),
  });

  const assets = useQuery({
    queryKey: ['assets', 'search', null, null, null, ''],
    queryFn: () => provider.searchAssets({}),
  });

  const surveys = useQuery({
    queryKey: kvKey('surveys', 'survey.'),
    queryFn: () => appStore.kvList<Survey>('surveys', 'survey.', 500),
  });

  const captures = useQuery({
    queryKey: kvKey('surveys', 'capture.'),
    queryFn: () => appStore.kvList<CaptureRow>('surveys', 'capture.', 500),
  });

  const codes = useQuery({
    queryKey: kvKey('codes'),
    queryFn: () => appStore.kvList('codes', '', 500),
  });

  const sites = useSites();
  const siteName = (id?: number) =>
    id === undefined ? '—' : (sites.data?.find((s) => s.id === id)?.name ?? String(id));

  const openCount = workOrders.data?.filter((wo: WorkOrder) => isOpenStatus(wo.status)).length;

  // Newest first; createdTime is optional in the wild, so missing dates sink.
  const recent = [...(workOrders.data ?? [])]
    .sort((a, b) => (b.createdTime ?? '').localeCompare(a.createdTime ?? ''))
    .slice(0, 8);

  const surveyRows = (surveys.data ?? []).map((e) => e.value);
  const captureRows = [...(captures.data ?? [])]
    .map((e) => e.value)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 8);

  const error = [workOrders, assets, surveys, codes].find((q) => q.isError);

  return (
    <section className="screen page">
      <h2>Dashboard</h2>
      {error?.error instanceof Error && <p className="error">{error.error.message}</p>}

      <div className="stat-row">
        <Stat cap="Open WOs" value={openCount} loading={workOrders.isLoading} />
        <Stat cap="Assets" value={assets.data?.length} loading={assets.isLoading} />
        <Stat cap="Surveys" value={surveys.data?.length} loading={surveys.isLoading} />
        <Stat cap="Codes" value={codes.data?.length} loading={codes.isLoading} />
      </div>

      <div className="kit-card">
        <div className="kit-card-hd">
          <h3>Recent work orders</h3>
        </div>
        {workOrders.isLoading && <div className="kit-card-bd muted small">Loading work orders…</div>}
        {!workOrders.isLoading && recent.length === 0 && (
          <Empty icon={<ClipboardListIcon size={36} />}>No work orders in this org yet.</Empty>
        )}
        {recent.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Resource</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((wo) => (
                  <tr key={wo.id}>
                    <td>{wo.subject}</td>
                    <td>
                      <span className={badgeClass(wo.status)}>
                        <span className="dot" />
                        {wo.status ?? 'Unknown'}
                      </span>
                    </td>
                    <td>{wo.priority ?? '—'}</td>
                    <td>{wo.resourceName ?? '—'}</td>
                    <td>{fmtDate(wo.createdTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="kit-card">
        <div className="kit-card-hd">
          <h3>Surveys</h3>
        </div>
        {surveys.isLoading && <div className="kit-card-bd muted small">Loading surveys…</div>}
        {!surveys.isLoading && surveyRows.length === 0 && (
          <Empty icon={<MapPinIcon size={36} />}>
            No standpoints surveyed yet — capture one from the AR screen.
          </Empty>
        )}
        {surveyRows.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Site</th>
                  <th>Markers</th>
                  <th>QR</th>
                </tr>
              </thead>
              <tbody>
                {surveyRows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{siteName(s.siteId)}</td>
                    <td>{s.markers?.length ?? 0}</td>
                    <td>
                      <span className={s.qrCode ? 'badge b-done' : 'badge b-draft'}>
                        <span className="dot" />
                        {s.qrCode ? 'Enrolled' : 'No QR'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {captureRows.length > 0 && (
        <div className="kit-card">
          <div className="kit-card-hd">
            <h3>Recent captures</h3>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Capture</th>
                  <th>Site</th>
                  <th>Space</th>
                  <th>Markers</th>
                  <th>Embeddings</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {captureRows.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>{siteName(c.siteId)}</td>
                    <td>{c.spaceName ?? '—'}</td>
                    <td>{c.markers?.length ?? 0}</td>
                    <td>
                      <span
                        className={c.embeddingStatus === 'done' ? 'badge b-done' : 'badge b-prog'}
                      >
                        <span className="dot" />
                        {c.embeddingStatus === 'done' ? 'Indexed' : 'Pending'}
                      </span>
                    </td>
                    <td>{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!captures.isLoading && captureRows.length === 0 && (
        <div className="kit-card">
          <div className="kit-card-hd">
            <h3>Recent captures</h3>
          </div>
          <Empty icon={<LayoutGridIcon size={36} />}>
            Nothing captured yet — photos taken on the Capture screen land here.
          </Empty>
        </div>
      )}
    </section>
  );
}
