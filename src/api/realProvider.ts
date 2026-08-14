import { vibe } from './vibe';
import { cmms, chunk, fetchAllPages, inFilter, rowsOf } from './facilioHelpers';
import { callFn } from './scriptFns';
import { visibleRows } from './recordPolicy';
import { loadEstateRaw } from './estate';
import type { DataProvider } from './dataProvider';
import type {
  Asset,
  AssetSearch,
  Building,
  Floor,
  ListQuery,
  LocationScope,
  PageResult,
  Site,
  Space,
  WorkOrder,
  WorkOrderDraft,
  WorkOrderStatus,
  WorkOrderTask,
} from './types';

// Payload keys verified against the action input schemas
// (`facilio connections schemas facilio-cmms.list-sites ...`, 2026-08-13).
function toPayload(query: ListQuery = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (query.page !== undefined) payload.page = query.page;
  if (query.pageSize !== undefined) payload.page_size = query.pageSize;
  if (query.filters !== undefined) payload.filters = query.filters;
  if (query.sortBy !== undefined) payload.sort_by = query.sortBy;
  if (query.sortOrder !== undefined) payload.sort_order = query.sortOrder;
  if (query.select !== undefined) payload.select = query.select;
  if (query.expand !== undefined) payload.expand = query.expand;
  if (query.includeCount !== undefined) payload.include_count = query.includeCount;
  return payload;
}

async function list<T>(actionSlug: string, query?: ListQuery): Promise<PageResult<T>> {
  const res = await cmms<T[]>(actionSlug, toPayload(query));
  return {
    data: rowsOf<T>(res.data),
    page: res.pagination?.page ?? query?.page ?? 1,
    pageSize: res.pagination?.pageSize ?? query?.pageSize ?? 50,
    ...(query?.includeCount && typeof res.count === 'number' ? { totalCount: res.count } : {}),
  };
}

// ---- raw row shapes (lookups expanded to nested {id,name} records) ----

interface RawBuilding {
  id: number;
  name: string;
  site?: { id?: number };
}

interface RawFloor {
  id: number;
  name: string;
  floorlevel?: number;
  building?: { id?: number };
  site?: { id?: number };
}

interface RawSpace {
  id: number;
  name: string;
  site?: { id?: number };
  building?: { id?: number };
  floor?: { id?: number };
  spaceType?: string;
}

interface RawAsset {
  id: number;
  name: string;
  category?: { id?: number; name?: string } | string;
  space?: { id?: number; name?: string };
  qrVal?: string;
}

// Verified row shape (list-work-orders against org #2915): moduleState and
// priority come back as plain strings; resource is a lookup.
interface RawWorkOrder {
  id: number;
  subject: string;
  description?: string;
  moduleState?: string | { name?: string; displayName?: string };
  priority?: string | { name?: string };
  resource?: { id?: number; name?: string };
  assignedTo?: { id?: number; name?: string } | string;
  dueDate?: string;
  createdTime?: string;
}

// Task row shape is org-dependent; map defensively. `status`/closed flags vary
// so treat "Closed"/"closed"/true as closed.
interface RawTask {
  id: number;
  subject?: string;
  name?: string;
  status?: string | { name?: string };
  statusNew?: string;
}

const WO_SELECT = 'id,subject,description,moduleState,priority,resource,assignedTo,dueDate,createdTime';

function lookupName(v: string | { name?: string; displayName?: string } | undefined): string | undefined {
  if (typeof v === 'string') return v;
  return v?.displayName ?? v?.name;
}

function toWorkOrder(row: RawWorkOrder): WorkOrder {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: lookupName(row.moduleState),
    priority: lookupName(row.priority),
    resourceId: row.resource?.id,
    resourceName: row.resource?.name,
    assignedTo: typeof row.assignedTo === 'string' ? row.assignedTo : row.assignedTo?.name,
    dueDate: row.dueDate,
    createdTime: row.createdTime,
  };
}

function toTask(row: RawTask): WorkOrderTask {
  const status = lookupName(row.status) ?? row.statusNew;
  return {
    id: row.id,
    subject: row.subject ?? row.name ?? `Task ${row.id}`,
    closed: typeof status === 'string' ? status.toLowerCase() === 'closed' : false,
  };
}

function toAsset(row: RawAsset): Asset {
  return {
    id: row.id,
    name: row.name,
    category: typeof row.category === 'string' ? row.category : row.category?.name,
    spaceId: row.space?.id,
    spaceName: row.space?.name,
    qrVal: row.qrVal,
  };
}

const ASSET_SELECT = 'id,name,category,space,qrVal';

// Scope resolution needs the whole space tree; memoize briefly so typing in
// the asset search box doesn't refetch the org's spaces per keystroke.
// (react-query also caches at the searchAssets level.)
let spacesMemo: { at: number; promise: Promise<Space[]> } | null = null;
const SPACES_MEMO_MS = 60_000;

function allSpacesCached(): Promise<Space[]> {
  if (!spacesMemo || Date.now() - spacesMemo.at > SPACES_MEMO_MS) {
    const promise = realProvider.listAllSpaces();
    spacesMemo = { at: Date.now(), promise };
    promise.catch(() => {
      // Never cache a failure.
      if (spacesMemo?.promise === promise) spacesMemo = null;
    });
  }
  return spacesMemo.promise;
}

/**
 * Assets attach to the location tree through `space` ONLY — there is no site
 * field on assets, and an asset's space pointer can target ANY BaseSpace level
 * (many orgs parent assets directly to the site). Scoping therefore means:
 * take the scope roots themselves plus every space under them, and filter
 * assets by `space` IN that id set. (Pattern lifted from ppm-asset-tagging.)
 */
async function resolveScopeSpaceIds(scope: LocationScope | undefined): Promise<number[] | undefined> {
  if (!scope || (!scope.siteId && !scope.buildingId && !scope.floorId)) return undefined;

  const spaces = await allSpacesCached();
  const ids = new Set<number>();

  // Narrower scopes win: floor > building > site.
  if (scope.floorId) {
    ids.add(scope.floorId);
    for (const s of spaces) if (s.floorId === scope.floorId) ids.add(s.id);
  } else if (scope.buildingId) {
    ids.add(scope.buildingId);
    for (const s of spaces) {
      if (s.buildingId === scope.buildingId) {
        ids.add(s.id);
        if (s.floorId) ids.add(s.floorId);
      }
    }
  } else if (scope.siteId) {
    ids.add(scope.siteId);
    for (const s of spaces) {
      if (s.siteId === scope.siteId) {
        ids.add(s.id);
        if (s.buildingId) ids.add(s.buildingId);
        if (s.floorId) ids.add(s.floorId);
      }
    }
  }
  return [...ids];
}

export const realProvider: DataProvider = {
  getCurrentUser: () => vibe.getCurrentUser(),
  login: () => vibe.login(),
  logout: () => vibe.logout(),

  listSites: (q) => list<Site>('list-sites', q),

  async listBuildings(): Promise<Building[]> {
    const rows = await fetchAllPages<RawBuilding>('list-buildings', {
      select: 'id,name,site',
      expand: 'site',
    });
    // Retired/test records are filtered HERE, in the data layer, so the asset
    // list and the 3D estate can never report different counts for the same org.
    return visibleRows(rows).map((b) => ({ id: b.id, name: b.name, siteId: b.site?.id }));
  },

  async listFloors(): Promise<Floor[]> {
    const rows = await fetchAllPages<RawFloor>('list-floors', {
      select: 'id,name,building,site,floorlevel',
      expand: 'building,site',
    });
    return visibleRows(rows).map((f) => ({
      id: f.id,
      name: f.name,
      floorLevel: typeof f.floorlevel === 'number' ? f.floorlevel : undefined,
      buildingId: f.building?.id,
      siteId: f.site?.id,
    }));
  },

  async listAllSpaces(): Promise<Space[]> {
    const rows = await fetchAllPages<RawSpace>('list-spaces', {
      select: 'id,name,site,building,floor',
      expand: 'site,building,floor',
    });
    return visibleRows(rows).map((s) => ({
      id: s.id,
      name: s.name,
      siteId: s.site?.id,
      buildingId: s.building?.id,
      floorId: s.floor?.id,
      spaceType: s.spaceType,
    }));
  },

  async searchAssets(search: AssetSearch = {}): Promise<Asset[]> {
    const spaceIds = await resolveScopeSpaceIds(search.scope);
    const filters: string[] = [];
    if (search.text?.trim()) filters.push(`name(contains)=${search.text.trim()}`);

    // Unscoped: one paged fetch.
    if (!spaceIds) {
      const rows = await fetchAllPages<RawAsset>('list-assets', {
        select: ASSET_SELECT,
        expand: 'space',
        ...(filters.length ? { filters: filters.join('&') } : {}),
      });
      return visibleRows(rows).map(toAsset);
    }

    if (!spaceIds.length) return [];

    // Scoped: the filters string is a URL parameter — keep each IN list short.
    const parts = await Promise.all(
      chunk(spaceIds, 50).map((part) =>
        fetchAllPages<RawAsset>('list-assets', {
          select: ASSET_SELECT,
          expand: 'space',
          filters: [...filters, inFilter('space', part)].join('&'),
        }),
      ),
    );
    return visibleRows(parts.flat()).map(toAsset);
  },

  async getAsset(id: number): Promise<Asset | null> {
    const res = await cmms<RawAsset[]>('list-assets', {
      select: ASSET_SELECT,
      expand: 'space',
      filters: inFilter('id', [id]),
    });
    const row = rowsOf<RawAsset>(res.data)[0];
    return row ? toAsset(row) : null;
  },

  listWorkOrders: (q) => list<WorkOrder>('list-work-orders', q),

  async listWorkOrdersForAssets(assetIds: number[]): Promise<WorkOrder[]> {
    if (!assetIds.length) return [];
    const parts = await Promise.all(
      chunk(assetIds, 50).map((part) =>
        fetchAllPages<RawWorkOrder>('list-work-orders', {
          select: WO_SELECT,
          expand: 'resource',
          filters: inFilter('resource', part),
        }),
      ),
    );
    return parts.flat().map(toWorkOrder);
  },

  async getWorkOrder(id: number): Promise<WorkOrder | null> {
    const res = await cmms<RawWorkOrder[]>('list-work-orders', {
      select: WO_SELECT,
      expand: 'resource',
      filters: inFilter('id', [id]),
    });
    const row = rowsOf<RawWorkOrder>(res.data)[0];
    return row ? toWorkOrder(row) : null;
  },

  async listWorkOrderTasks(workOrderId: number): Promise<WorkOrderTask[]> {
    const res = await cmms<RawTask[]>('list-work-order-tasks', { id: workOrderId });
    return rowsOf<RawTask>(res.data).map(toTask);
  },

  async addWorkOrderTask(workOrderId: number, subject: string): Promise<number> {
    // Same script lane as work orders (see scriptFns.ts): the V3 task module,
    // parented to its ticket. create-work-order-task has the same broken
    // schema family as create-work-order, so it is not used.
    const out = (await callFn('createRecord', [
      'task',
      { subject, parentTicketId: workOrderId },
    ])) as { id?: number } | null;
    if (!out?.id) throw new Error('Task create returned no id — script lane failed');
    return out.id;
  },

  async setWorkOrderTaskStatus(workOrderId: number, taskId: number, closed: boolean) {
    await cmms('complete-or-reopen-work-order-task', {
      work_order_id: workOrderId,
      task_id: taskId,
      task_status: closed ? 'closed' : 'open',
    });
  },

  async getWorkOrderStatuses(): Promise<WorkOrderStatus[]> {
    // get-work-order-metadata proxies raw HTTP: the body sits in `data.response`
    // as a JSON string. Walk defensively rather than hardcoding the nesting.
    const res = await cmms<unknown>('get-work-order-metadata', {});
    let body: unknown = res.data;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          break;
        }
      }
      const obj = body as Record<string, unknown> | undefined;
      if (obj && Array.isArray(obj.fields)) break;
      body = obj?.response ?? obj?.data;
      if (body === undefined) break;
    }
    const fields = ((body as { fields?: unknown[] })?.fields ?? []) as Array<{
      name?: string;
      allowed_values?: Array<{ label?: string; value?: string }>;
    }>;
    const moduleState = fields.find((f) => f.name === 'moduleState');
    if (!moduleState?.allowed_values?.length) {
      throw new Error('Could not read the work order status catalogue from metadata');
    }
    return moduleState.allowed_values
      .filter((v): v is { label: string; value: string } => Boolean(v.label && v.value))
      .map(({ label, value }) => ({ label, value }));
  },

  async changeWorkOrderStatus(workOrderId: number, status: string) {
    await cmms('change-work-order-status', { id: workOrderId, status });
  },

  async createWorkOrder(draft: WorkOrderDraft): Promise<number> {
    // The script lane, not create-work-order — see scriptFns.ts for why.
    const record: Record<string, unknown> = { subject: draft.subject };
    if (draft.description) record.description = draft.description;
    if (draft.siteId) record.siteId = draft.siteId;
    if (draft.resourceId) record.resource = { id: draft.resourceId };
    // location lands via the space lookup — site alone leaves building/space blank
    if (draft.spaceId) record.space = { id: draft.spaceId };
    const out = (await callFn('createRecord', ['workorder', record])) as { id?: number } | null;
    if (!out?.id) {
      throw new Error('Work order create returned no id — script lane failed, not created');
    }
    return out.id;
  },

  loadEstate: (showRetired) => loadEstateRaw(showRetired),
};
