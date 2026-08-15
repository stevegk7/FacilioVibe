import { vibe } from './vibe';
import { cmms, chunk, execute, fetchAllPages, inFilter, rowsOf } from './facilioHelpers';
import { callFn } from './scriptFns';
import { visibleRows } from './recordPolicy';
import {
  allowedPlaces,
  assetIdsFrom,
  canReadWorkOrder,
  scopeGeneration,
  sessionScope,
  visibleWorkOrders,
  type AllowedPlaces,
} from './scope';
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
  RecordAction,
  RecordActions,
  Worker,
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
  // A bare number when the lookup is NOT expanded — which is what every WO read
  // used to send. Handle all three shapes rather than trusting the expand.
  assignedTo?: { id?: number; name?: string; email?: string } | number | string;
  dueDate?: string;
  createdTime?: string;
}

interface RawEmployee {
  id: number;
  name?: string;
  email?: string;
}

/** get-record-actions returns these four buckets plus the current state. */
interface RawRecordActions {
  currentState?: RecordActions['currentState'];
  stateTransitions?: RecordAction[];
  approvalTransitions?: RecordAction[];
  customButtons?: RecordAction[];
  systemButtons?: RecordAction[];
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

/**
 * `assignedTo` joins `resource` in the expand because scoping needs the
 * assignee's id, and an unexpanded lookup arrives as a bare number with no name
 * or email on it. Two of five expand slots used (the CMMS caps it at five).
 */
const WO_EXPAND = 'resource,assignedTo';

function lookupName(v: string | { name?: string; displayName?: string } | undefined): string | undefined {
  if (typeof v === 'string') return v;
  return v?.displayName ?? v?.name;
}

function toWorkOrder(row: RawWorkOrder): WorkOrder {
  const assignee = row.assignedTo;
  const assigneeObject = typeof assignee === 'object' && assignee !== null ? assignee : undefined;
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: lookupName(row.moduleState),
    priority: lookupName(row.priority),
    resourceId: row.resource?.id,
    resourceName: row.resource?.name,
    assignedTo: typeof assignee === 'string' ? assignee : assigneeObject?.name,
    // Keep the id whatever shape it arrived in. Dropping it here was what made
    // "work orders assigned to me" impossible to answer.
    assignedToId: typeof assignee === 'number' ? assignee : assigneeObject?.id,
    assignedToEmail: assigneeObject?.email,
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

/** The space tree, unscoped. Shared by listAllSpaces and the scoping memo below. */
async function fetchSpaces(): Promise<Space[]> {
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
}

/**
 * A technician's world: the assets their own work orders are raised against,
 * and the places containing them.
 *
 * Memoised per session for the same reason `spacesMemo` is — every screen asks,
 * and the answer cannot change without the session changing. It deliberately
 * fetches through the raw helpers rather than the provider's own methods, which
 * are themselves scoped by this result and would recurse forever.
 *
 * Returns null for an admin, meaning "no narrowing", which keeps the admin path
 * exactly as fast as it was before this feature existed.
 */
let worldMemo: { gen: number; value: Promise<{ assetIds: Set<number>; places: AllowedPlaces }> } | null =
  null;

/** Narrow an asset list to the technician's own; a no-op for an admin. */
async function scopeAssets(assets: Asset[]): Promise<Asset[]> {
  const world = await myWorld();
  return world ? assets.filter((a) => world.assetIds.has(a.id)) : assets;
}

async function myWorld(): Promise<{ assetIds: Set<number>; places: AllowedPlaces } | null> {
  if (sessionScope().role === 'admin') return null;
  const gen = scopeGeneration();
  if (!worldMemo || worldMemo.gen !== gen) {
    const entry: { gen: number; value: Promise<{ assetIds: Set<number>; places: AllowedPlaces }> } = {
      gen,
      value: (async () => {
        const rows = await fetchAllPages<RawWorkOrder>('list-work-orders', {
          select: WO_SELECT,
          expand: WO_EXPAND,
        });
        const assetIds = assetIdsFrom(visibleWorkOrders(rows.map(toWorkOrder)));
        if (!assetIds.size) {
          return { assetIds, places: allowedPlaces([], [], assetIds) };
        }
        // Only the assets actually referenced, not the whole org.
        const assetRows = await Promise.all(
          chunk([...assetIds], 50).map((part) =>
            fetchAllPages<RawAsset>('list-assets', {
              select: ASSET_SELECT,
              expand: 'space',
              filters: inFilter('id', part),
            }),
          ),
        );
        const assets = visibleRows(assetRows.flat()).map(toAsset);
        return { assetIds, places: allowedPlaces(assets, await fetchSpaces(), assetIds) };
      })(),
    };
    // Never cache a REJECTION. spacesMemo clears itself the same way, and for a
    // sharper reason here: this memo decides what a technician can see, so one
    // transient list-work-orders failure would otherwise blank their buildings,
    // floors, spaces and assets for the rest of the session with no way back.
    entry.value.catch(() => {
      if (worldMemo === entry) worldMemo = null;
    });
    worldMemo = entry;
  }
  return worldMemo.value;
}

export const realProvider: DataProvider = {
  getCurrentUser: () => vibe.getCurrentUser(),
  login: () => vibe.login(),
  logout: () => vibe.logout(),

  /**
   * Verified quirk, and the reason this is not a one-line exact-match filter:
   * a '+' in an email BREAKS a CMMS filter. Against org #2915,
   * `email(contains)=yaaminy.sk` returns both plus-addressed accounts, while
   * `email(contains)=yaaminy.sk+technician` and `email(is)=<full address>`
   * both return nothing at all — no error, just an empty page.
   *
   * So filter on the part before the '+', which is always a prefix of the real
   * address, and make the exact comparison here where JavaScript can be trusted.
   */
  async resolveEmployeeId(email: string): Promise<number | null> {
    const address = email.trim().toLowerCase();
    const local = address.split('@')[0] ?? '';
    const probe = (local.split('+')[0] || local).trim();
    if (!probe) return null;
    const res = await cmms<RawEmployee[]>('list-employees', {
      select: 'id,name,email',
      filters: `email(contains)=${probe}`,
      page_size: 200,
    });
    const row = rowsOf<RawEmployee>(res.data).find(
      (r) => (r.email ?? '').trim().toLowerCase() === address,
    );
    return row?.id ?? null;
  },

  /**
   * Sites narrow like everything else. They were the one level of the tree
   * that did not, which is a leak you can SEE rather than reason about: the
   * site picker offered a technician every site in the org, and picking one
   * their work never reaches then showed an empty building list underneath —
   * the app describing a place it had already decided not to show them.
   *
   * `allowedPlaces` has computed `siteIds` all along; nothing consumed it.
   */
  async listSites(q) {
    const page = await list<Site>('list-sites', q);
    const world = await myWorld();
    if (!world) return page;
    return { ...page, data: page.data.filter((s) => world.places.siteIds.has(s.id)) };
  },

  async listBuildings(): Promise<Building[]> {
    const rows = await fetchAllPages<RawBuilding>('list-buildings', {
      select: 'id,name,site',
      expand: 'site',
    });
    // Retired/test records are filtered HERE, in the data layer, so the asset
    // list and the 3D estate can never report different counts for the same org.
    // Assignment scoping rides the same seam, one line below.
    const buildings = visibleRows(rows).map((b) => ({ id: b.id, name: b.name, siteId: b.site?.id }));
    const world = await myWorld();
    return world ? buildings.filter((b) => world.places.buildingIds.has(b.id)) : buildings;
  },

  async listFloors(): Promise<Floor[]> {
    const rows = await fetchAllPages<RawFloor>('list-floors', {
      select: 'id,name,building,site,floorlevel',
      expand: 'building,site',
    });
    const floors = visibleRows(rows).map((f) => ({
      id: f.id,
      name: f.name,
      floorLevel: typeof f.floorlevel === 'number' ? f.floorlevel : undefined,
      buildingId: f.building?.id,
      siteId: f.site?.id,
    }));
    const world = await myWorld();
    return world ? floors.filter((f) => world.places.floorIds.has(f.id)) : floors;
  },

  async listAllSpaces(): Promise<Space[]> {
    const spaces = await fetchSpaces();
    const world = await myWorld();
    return world ? spaces.filter((s) => world.places.spaceIds.has(s.id)) : spaces;
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
      return scopeAssets(visibleRows(rows).map(toAsset));
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
    return scopeAssets(visibleRows(parts.flat()).map(toAsset));
  },

  async getAsset(id: number): Promise<Asset | null> {
    const res = await cmms<RawAsset[]>('list-assets', {
      select: ASSET_SELECT,
      expand: 'space',
      filters: inFilter('id', [id]),
    });
    const row = rowsOf<RawAsset>(res.data)[0];
    // A direct id read is how a typed URL tries to walk around the list filter.
    return row ? ((await scopeAssets([toAsset(row)]))[0] ?? null) : null;
  },

  /**
   * This path used to send no projection and no expand, and cast raw rows
   * straight to WorkOrder — so `assignedTo` was whatever the server felt like
   * returning rather than the mapped string the type promised. It now goes
   * through the same select/expand/mapper as every other work-order read.
   */
  async listWorkOrders(q?: ListQuery): Promise<PageResult<WorkOrder>> {
    const res = await cmms<RawWorkOrder[]>('list-work-orders', {
      select: WO_SELECT,
      expand: WO_EXPAND,
      ...toPayload(q),
    });
    return {
      data: visibleWorkOrders(rowsOf<RawWorkOrder>(res.data).map(toWorkOrder)),
      page: res.pagination?.page ?? q?.page ?? 1,
      pageSize: res.pagination?.pageSize ?? q?.pageSize ?? 50,
      ...(q?.includeCount && typeof res.count === 'number' ? { totalCount: res.count } : {}),
    };
  },

  async listWorkOrdersForAssets(assetIds: number[]): Promise<WorkOrder[]> {
    if (!assetIds.length) return [];
    const parts = await Promise.all(
      chunk(assetIds, 50).map((part) =>
        fetchAllPages<RawWorkOrder>('list-work-orders', {
          select: WO_SELECT,
          expand: WO_EXPAND,
          filters: inFilter('resource', part),
        }),
      ),
    );
    return visibleWorkOrders(parts.flat().map(toWorkOrder));
  },

  async getWorkOrder(id: number): Promise<WorkOrder | null> {
    const res = await cmms<RawWorkOrder[]>('list-work-orders', {
      select: WO_SELECT,
      expand: WO_EXPAND,
      filters: inFilter('id', [id]),
    });
    const row = rowsOf<RawWorkOrder>(res.data)[0];
    const wo = row ? toWorkOrder(row) : null;
    return canReadWorkOrder(wo) ? wo : null;
  },

  async listWorkOrderTasks(workOrderId: number): Promise<WorkOrderTask[]> {
    const res = await cmms<RawTask[]>('list-work-order-tasks', { id: workOrderId });
    return rowsOf<RawTask>(res.data).map(toTask);
  },

  async addWorkOrderTask(workOrderId: number, subject: string): Promise<number> {
    /* The plain action, NOT the script lane.
       This used to go through `createRecord('task', {subject, parentTicketId})`,
       on the note that create-work-order-task shared create-work-order's broken
       schema family. That is no longer true, and the script lane silently did
       not work for tasks: `v3Add` writes the new id back into the map for
       workorder but not for task, so the handler always threw "Task create
       returned no id" AFTER the record may or may not have been written —
       which is what the AI-suggested-tasks button was reporting in the field.
       Verified against the live org on 2026-08-15: this action returns
       {id, subject, status, createdTime} and the task appears in
       list-work-order-tasks. */
    const res = await cmms<{ id?: number }>('create-work-order-task', {
      id: workOrderId,
      subject,
    });
    const created = rowsOf<{ id?: number }>(res.data)[0];
    if (!created?.id) throw new Error('Task create returned no id');
    return created.id;
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

  /**
   * The live action list, straight from the org's published state flow.
   *
   * Two different connections, on purpose: process-automation READS what the
   * flow offers, and record-level-button-actions RUNS it. Neither is
   * facilio-cmms, so both go through `execute` rather than the `cmms` helper.
   *
   * The reader is filtered server-side by the caller's own permissions, which
   * means a technician is offered exactly what the workflow lets them do —
   * the app never has to reimplement that rule, and cannot get it wrong.
   */
  async getWorkOrderActions(workOrderId: number): Promise<RecordActions> {
    const res = await execute<RawRecordActions>('facilio-process-automation', 'get-record-actions', {
      moduleName: 'workorder',
      recordId: workOrderId,
    });
    // The payload sits at the top level of the response, not under `data`, so
    // accept either rather than depending on which wrapper this action uses.
    const raw = (res.data ?? (res as unknown as RawRecordActions)) ?? {};
    return {
      currentState: raw.currentState,
      stateTransitions: raw.stateTransitions ?? [],
      approvalTransitions: raw.approvalTransitions ?? [],
      customButtons: raw.customButtons ?? [],
      systemButtons: raw.systemButtons ?? [],
    };
  },

  async executeWorkOrderAction(
    workOrderId: number,
    action: Pick<RecordAction, 'buttonId' | 'buttonType'>,
    formData?: Record<string, unknown>,
  ): Promise<void> {
    await execute('facilio-record-level-button-actions', 'execute-button-for-a-record', {
      moduleName: 'workorder',
      recordId: workOrderId,
      buttonId: action.buttonId,
      buttonType: action.buttonType,
      // Only buttons that declare a form accept it; sending an empty object to
      // the rest is a needless way to fail.
      ...(formData && Object.keys(formData).length ? { formData } : {}),
    });
  },

  /**
   * The people an assignment transition can name.
   *
   * The employee module is the only directory reachable from here. Note its id
   * is NOT the id space `workorder.assignedTo` reports (that is 2282340-style,
   * an org-user id, and employee has no `ouid` field to bridge the two — asking
   * for one fails INVALID_FIELD). So this sends the employee id and lets the
   * server resolve it. It replaces a free-text box that sent a display NAME and
   * earned a 502 every time, which is strictly worse than a wrong id: at least
   * an id either works or fails once, visibly.
   */
  async listWorkers(): Promise<Worker[]> {
    const rows = await fetchAllPages<RawEmployee>('list-employees', {
      select: 'id,name,email',
      page_size: 200,
    });
    return rows
      .filter((r) => r.name)
      .map((r) => ({ id: r.id, name: String(r.name), email: r.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
