import { visibleRows } from './recordPolicy';
import type { DataProvider } from './dataProvider';
import type {
  Asset,
  AssetSearch,
  ListQuery,
  PageResult,
  WorkOrder,
  WorkOrderDraft,
  WorkOrderTask,
} from './types';

// Fixtures mirror the shape (and flavor) of the real org's seeded demo data so
// switching ?mock=1 on/off doesn't change what the UI has to handle. Note the
// real-world quirk is preserved: assets parent to ANY BaseSpace level via
// spaceId (asset 3006 parents straight to site 1001).

/* `location` mirrors the live CMMS shape (an expanded lookup carrying lat/lng and
   a postal address), because the outdoor leg and every site-to-site hop are
   priced off it. Without it here, ?mock=1 would rehearse a portfolio that has no
   geo — which is exactly the blind spot that let the missing `expand: location`
   go unnoticed. The two sites that also exist in org 2915 carry its real
   coordinates so mock and live agree. */
const sites = [
  { id: 1001, name: 'Greenfield Business Park', description: 'Mixed-use office park with two towers and a central admin block.', siteType: 'Office', moduleState: 'active', qrVal: 'facilio_1001',
    location: { id: 9001, street: 'Bagillt Road', city: 'Greenfield', state: 'Wales', country: 'GB', zip: 'CH8 7HJ', lat: 53.2876619, lng: -3.2027173 } },
  { id: 1002, name: 'Lakeside Manufacturing Plant', description: 'Heavy-industry facility with a production wing and utility block.', siteType: 'Compound', moduleState: 'active', qrVal: 'facilio_1002',
    location: { id: 9002, street: 'West Electric Avenue', city: 'West Milwaukee', state: 'Wisconsin', country: 'US', zip: '53219', lat: 43.0068251, lng: -87.9759057 } },
  { id: 1003, name: 'Harborview Medical Center', description: 'Regional hospital campus, three wards and a diagnostics wing.', siteType: 'Hospital', moduleState: 'active', qrVal: 'facilio_1003',
    location: { id: 9003, street: '325 9th Avenue', city: 'Seattle', state: 'Washington', country: 'US', zip: '98104', lat: 47.6038321, lng: -122.3300624 } },
];

const buildings = [
  { id: 1501, name: 'Tower A', siteId: 1001 },
  { id: 1502, name: 'Tower B', siteId: 1001 },
  { id: 1503, name: 'Production Wing', siteId: 1002 },
  { id: 1504, name: 'Ward B', siteId: 1003 },
];

// Every building needs at least one floor for the 3D estate to have anything to
// stack — but the awkward cases below (a floorless space, a site-parented asset)
// stay exactly as they were. They are the reason these fixtures exist.
const floors = [
  { id: 1801, name: 'Floor 3', buildingId: 1501, siteId: 1001, floorLevel: 3 },
  { id: 1802, name: 'Ground Floor', buildingId: 1501, siteId: 1001, floorLevel: 0 },
  { id: 1803, name: 'Line Deck', buildingId: 1503, siteId: 1002, floorLevel: 1 },
  { id: 1804, name: 'Floor 1', buildingId: 1502, siteId: 1001, floorLevel: 1 },
  { id: 1805, name: 'Mechanical Floor', buildingId: 1502, siteId: 1001, floorLevel: 2 },
  { id: 1806, name: 'Ward Level 2', buildingId: 1504, siteId: 1003, floorLevel: 2 },
];

const spaces = [
  { id: 2001, name: 'Open Office 3F', siteId: 1001, buildingId: 1501, floorId: 1801, spaceType: 'Office' },
  { id: 2002, name: 'Server Room', siteId: 1001, buildingId: 1501, floorId: 1802, spaceType: 'Room' },
  { id: 2003, name: 'Line 1', siteId: 1002, buildingId: 1503, floorId: 1803, spaceType: 'Area' },
  // No building and no floor — an asset here must still resolve through the site.
  { id: 2004, name: 'Pump House', siteId: 1002, spaceType: 'Room' },
  // Building but no floor — dropped from the 3D model, kept in the asset list.
  { id: 2005, name: 'Ward B Corridor', siteId: 1003, buildingId: 1504, spaceType: 'Corridor' },
  { id: 2006, name: 'Meeting Room 3A', siteId: 1001, buildingId: 1501, floorId: 1801, spaceType: 'Room' },
  { id: 2007, name: 'Plant Room B', siteId: 1001, buildingId: 1502, floorId: 1805, spaceType: 'Utility' },
  { id: 2008, name: 'Reception', siteId: 1001, buildingId: 1502, floorId: 1804, spaceType: 'Common Area' },
  { id: 2009, name: 'Store 1', siteId: 1002, buildingId: 1503, floorId: 1803, spaceType: 'Room' },
  // A real room with no equipment in it — the empty-space branch.
  { id: 2010, name: 'Ward Day Room', siteId: 1003, buildingId: 1504, floorId: 1806, spaceType: 'Common Area' },
  // A retired record: recordPolicy must drop this everywhere, consistently.
  { id: 2011, name: 'OBSOLETE - old riser (safe to delete)', siteId: 1001, buildingId: 1501, floorId: 1802, spaceType: 'Room' },
];

const assets: Asset[] = [
  { id: 3001, name: 'AHU-03', category: 'HVAC', spaceId: 2001, spaceName: 'Open Office 3F', qrVal: 'facilio_3001' },
  { id: 3002, name: 'UPS-A2', category: 'Electrical', spaceId: 2002, spaceName: 'Server Room', qrVal: 'facilio_3002' },
  { id: 3003, name: 'Conveyor Motor M-114', category: 'Mechanical', spaceId: 2003, spaceName: 'Line 1', qrVal: 'facilio_3003' },
  { id: 3004, name: 'Feed Pump P-07', category: 'Plumbing', spaceId: 2004, spaceName: 'Pump House', qrVal: 'facilio_3004' },
  { id: 3005, name: 'Isolation Room AHU', category: 'HVAC', spaceId: 2005, spaceName: 'Ward B Corridor', qrVal: 'facilio_3005' },
  // Parented directly to a site — the case that breaks naive "assets by space" scoping.
  { id: 3006, name: 'Campus Chiller CH-01', category: 'HVAC', spaceId: 1001, spaceName: 'Greenfield Business Park', qrVal: 'facilio_3006' },
  { id: 3007, name: 'Chiller CH-02', category: 'Chiller', spaceId: 2007, spaceName: 'Plant Room B', qrVal: 'facilio_3007' },
  { id: 3008, name: 'Primary Pump P-01', category: 'Primary Pump', spaceId: 2007, spaceName: 'Plant Room B', qrVal: 'facilio_3008' },
  { id: 3009, name: 'Energy Meter EM-01', category: 'Energy Meter', spaceId: 2008, spaceName: 'Reception', qrVal: 'facilio_3009' },
  { id: 3010, name: 'FCU-12', category: 'FCU', spaceId: 2006, spaceName: 'Meeting Room 3A', qrVal: 'facilio_3010' },
  // Retired: must be absent from BOTH the asset list and the 3D model.
  { id: 3011, name: 'OBSOLETE (CLI test artifact - safe to delete)', category: 'HVAC', spaceId: 2002, spaceName: 'Server Room', qrVal: 'facilio_3011' },
];

// Mutable on purpose — status changes, task ticks and creates hit these arrays
// so the mock behaves like a live org within a session.
const workOrders: WorkOrder[] = [
  { id: 4001, subject: 'AHU-03 vibration above threshold', status: 'Open', priority: 'High', resourceId: 3001, resourceName: 'AHU-03', assignedTo: 'Priya', dueDate: '2026-08-15T17:00:00Z', createdTime: '2026-08-12T09:14:00Z' },
  { id: 4002, subject: 'Quarterly UPS battery inspection', status: 'Open', priority: 'Medium', resourceId: 3002, resourceName: 'UPS-A2', assignedTo: 'Arun', dueDate: '2026-08-20T12:00:00Z', createdTime: '2026-08-10T08:00:00Z' },
  { id: 4003, subject: 'Conveyor M-114 belt replacement', status: 'In Progress', priority: 'High', resourceId: 3003, resourceName: 'Conveyor Motor M-114', assignedTo: 'Raj', dueDate: '2026-08-14T10:00:00Z', createdTime: '2026-08-11T15:40:00Z' },
  { id: 4004, subject: 'Pump P-07 seal leak', status: 'On Hold', priority: 'Low', resourceId: 3004, resourceName: 'Feed Pump P-07', dueDate: '2026-08-28T09:00:00Z', createdTime: '2026-08-09T11:05:00Z' },
  { id: 4005, subject: 'Isolation room pressure check', status: 'Closed', priority: 'High', resourceId: 3005, resourceName: 'Isolation Room AHU', assignedTo: 'Priya', dueDate: '2026-08-08T16:00:00Z', createdTime: '2026-08-05T07:30:00Z' },
];

const tasksByWo = new Map<number, WorkOrderTask[]>([
  [4001, [
    { id: 5001, subject: 'Isolate the unit and lock out power', closed: true },
    { id: 5002, subject: 'Measure vibration at bearing housings', closed: false },
    { id: 5003, subject: 'Check belt tension and alignment', closed: false },
  ]],
  [4003, [
    { id: 5010, subject: 'Drain conveyor line and remove guard', closed: false },
    { id: 5011, subject: 'Replace drive belt', closed: false },
  ]],
]);

// Mirrors the real org's moduleState allowed_values (label/value pairs).
const statusCatalogue = [
  { label: 'Open', value: 'Open' },
  { label: 'In Progress', value: 'In Progress' },
  { label: 'On Hold', value: 'On Hold' },
  { label: 'Resolved', value: 'Resolved' },
  { label: 'Closed', value: 'Closed' },
  { label: 'Cancelled', value: 'Cancelled' },
];

let nextWoId = 4100;

const LATENCY_MS = 150;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function paginate<T>(rows: T[], query: ListQuery = {}): Promise<PageResult<T>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const start = (page - 1) * pageSize;
  return delay({
    data: rows.slice(start, start + pageSize),
    page,
    pageSize,
    ...(query.includeCount ? { totalCount: rows.length } : {}),
  });
}

/** Mirror of realProvider's scope resolution, over fixtures. */
function scopeSpaceIds(search: AssetSearch): number[] | undefined {
  const scope = search.scope;
  if (!scope || (!scope.siteId && !scope.buildingId && !scope.floorId)) return undefined;

  const ids = new Set<number>();
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

export const mockProvider: DataProvider = {
  async getCurrentUser() {
    return {
      user: { uid: 1, email: 'mock@facilio.com', name: 'Mock User', username: 'mock' },
      org: { orgId: 2915 },
    };
  },
  login() {
    // no-op: mock mode never leaves the page
  },
  logout() {
    // no-op
  },

  listSites: (q) => paginate(sites, q),
  // Same record policy as realProvider — mock mode must not show a set the live
  // org would hide, or ?mock=1 stops being a faithful rehearsal.
  listBuildings: () => delay(visibleRows(buildings)),
  listFloors: () => delay(visibleRows(floors)),
  listAllSpaces: () => delay(visibleRows(spaces)),

  async searchAssets(search: AssetSearch = {}) {
    const ids = scopeSpaceIds(search);
    const text = search.text?.trim().toLowerCase();
    return delay(
      visibleRows(assets).filter((a) => {
        if (ids && !ids.includes(a.spaceId ?? -1)) return false;
        if (text && !a.name.toLowerCase().includes(text)) return false;
        return true;
      }),
    );
  },

  async getAsset(id: number) {
    return delay(assets.find((a) => a.id === id) ?? null);
  },

  listWorkOrders: (q) => paginate(workOrders, q),

  async listWorkOrdersForAssets(assetIds: number[]) {
    return delay(workOrders.filter((wo) => assetIds.includes(wo.resourceId ?? -1)));
  },

  async getWorkOrder(id: number) {
    return delay(workOrders.find((wo) => wo.id === id) ?? null);
  },

  async listWorkOrderTasks(workOrderId: number) {
    return delay([...(tasksByWo.get(workOrderId) ?? [])]);
  },

  async addWorkOrderTask(workOrderId: number, subject: string) {
    const list = tasksByWo.get(workOrderId) ?? [];
    const id = 9000 + list.length + Math.floor(Math.random() * 100);
    list.push({ id, subject, closed: false });
    tasksByWo.set(workOrderId, list);
    return delay(id);
  },

  async setWorkOrderTaskStatus(workOrderId: number, taskId: number, closed: boolean) {
    const task = tasksByWo.get(workOrderId)?.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found on WO ${workOrderId}`);
    task.closed = closed;
    return delay(undefined);
  },

  async getWorkOrderStatuses() {
    return delay([...statusCatalogue]);
  },

  async changeWorkOrderStatus(workOrderId: number, status: string) {
    const wo = workOrders.find((w) => w.id === workOrderId);
    if (!wo) throw new Error(`Work order ${workOrderId} not found`);
    if (!statusCatalogue.some((s) => s.value === status)) {
      throw new Error(`"${status}" is not in the status catalogue`);
    }
    wo.status = status;
    return delay(undefined);
  },

  async createWorkOrder(draft: WorkOrderDraft) {
    const id = nextWoId++;
    const asset = draft.resourceId ? assets.find((a) => a.id === draft.resourceId) : undefined;
    workOrders.unshift({
      id,
      subject: draft.subject,
      description: draft.description,
      status: 'Open',
      priority: 'Medium',
      resourceId: draft.resourceId,
      resourceName: asset?.name,
      createdTime: new Date().toISOString(),
    });
    return delay(id);
  },

  /**
   * The 3D estate over fixtures, so ?mock=1 renders the whole app — camera
   * screens AND the model — with no org access at all.
   *
   * The fixtures are stored flat (siteId/buildingId/floorId), because that is
   * what every other provider method returns; the loader hands back RAW cmms
   * rows, where a lookup is an object. Rebuilding that shape here is what keeps
   * buildEstate identical across mock and live — it must never learn which one
   * it is talking to.
   *
   * No CAD plans in mock: the two real plans are pinned to this org's Tower A /
   * Tower B floor NAMES, and the fixtures reuse those names by coincidence, not
   * by meaning. Binding a 35 m drawing to a fixture floor would look like a
   * feature and be a lie.
   */
  async loadEstate(showRetired = false) {
    const site = (id?: number) => (id ? { id, name: sites.find((s) => s.id === id)?.name } : null);
    const raw = {
      sites: sites.map((s) => ({ ...s })),
      buildings: buildings.map((b) => ({ id: b.id, name: b.name, site: site(b.siteId) })),
      floors: floors.map((f) => ({
        id: f.id,
        name: f.name,
        floorlevel: f.floorLevel,
        building: { id: f.buildingId, name: buildings.find((b) => b.id === f.buildingId)?.name },
        site: site(f.siteId),
      })),
      spaces: spaces.map((s) => ({
        id: s.id,
        name: s.name,
        spaceCategory: s.spaceType,
        building: s.buildingId ? { id: s.buildingId } : null,
        floor: s.floorId ? { id: s.floorId } : null,
        site: site(s.siteId),
      })),
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        tagNumber: a.qrVal,
        category: a.category,
        space: a.spaceId ? { id: a.spaceId, name: a.spaceName } : null,
      })),
      workOrders: workOrders.map((w) => ({
        id: w.id,
        subject: w.subject,
        moduleState: w.status,
        priority: w.priority,
        dueDate: w.dueDate,
        resource: w.resourceId ? { id: w.resourceId, name: w.resourceName } : null,
      })),
      inspections: [],
      plans: {},
    };
    return delay({
      ...raw,
      buildings: visibleRows(raw.buildings, showRetired),
      floors: visibleRows(raw.floors, showRetired),
      spaces: visibleRows(raw.spaces, showRetired),
      assets: visibleRows(raw.assets, showRetired),
    });
  },
};
