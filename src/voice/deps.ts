/**
 * Voice dependency bundle (roadmap 8). Everything in src/voice takes a
 * VoiceDeps rather than importing the provider Proxy directly, so tests inject
 * fakes instead of monkey-patching a live seam.
 *
 * `defaultDeps` binds the real seam lazily — each call goes through the
 * provider/appStore Proxies, which resolve mock-vs-real per property access
 * (?mock=1). Capturing the methods at module load would pin the wrong one.
 */
import { provider } from '../api/provider';
import { goToTab } from '../shell/router';
import { planFindOnSite } from '../estate/findOnSite';
import { appStore } from '../api/appStore';
import { loadGraph, nodeForSurvey, withSurveyNodes, type WayGraph } from '../wayfinding/graph';
import { findRoute } from '../wayfinding/router';
import {
  draftWorkOrder,
  identifyAsset,
  voiceTurn,
  type IdentifyVerdict,
  type WoDraft,
} from '../api/agents';
import type {
  Asset,
  AssetSearch,
  Building,
  Floor,
  Site,
  Space,
  WorkOrder,
  WorkOrderDraft,
  WorkOrderStatus,
  WorkOrderTask,
  Survey,
} from '../api/types';

/** One row of the portfolio hierarchy, typed for the find_location tool. */
export interface LocationHit {
  kind: 'site' | 'building' | 'floor' | 'space';
  id: number;
  name: string;
  parent?: string;
}

export interface VoiceDeps {
  searchAssets(search?: AssetSearch): Promise<Asset[]>;
  listWorkOrdersForAssets(assetIds: number[]): Promise<WorkOrder[]>;
  listWorkOrderTasks(workOrderId: number): Promise<WorkOrderTask[]>;
  setTaskStatus(workOrderId: number, taskId: number, closed: boolean): Promise<void>;
  getStatuses(): Promise<WorkOrderStatus[]>;
  changeStatus(workOrderId: number, status: string): Promise<void>;
  createWorkOrder(draft: WorkOrderDraft): Promise<number>;
  uploadPhoto(blob: Blob, name: string): Promise<number>;
  draftWorkOrder(fileId: number, context: string): Promise<WoDraft>;
  identifyAsset(
    fileIds: number[],
    candidates: Array<{ id: number; name: string }>,
  ): Promise<IdentifyVerdict>;
  /** Open work orders, for "take me to the HVAC that needs a filter change". */
  listOpenWorkOrders(): Promise<WorkOrder[]>;
  /** Resolves an asset to a route destination; null when it is not mapped. */
  routeToAsset(assetId: number): Promise<{ destination: string; steps: string[] } | null>;
  /** Search the whole location hierarchy by name (or bare id). */
  findLocations(text: string): Promise<LocationHit[]>;
  /** Route to a PLACE (building/floor/space) via the wayfinder graph. */
  routeToPlace(hit: {
    kind: 'site' | 'building' | 'floor' | 'space';
    id: number;
  }): Promise<{ destination: string; steps: string[] } | null>;
  /** One work order by id — status checks and task adds start here. */
  getWorkOrder(id: number): Promise<WorkOrder | null>;
  /** Append a checklist task; resolves the new task id. */
  addWorkOrderTask(workOrderId: number, subject: string): Promise<number>;

  /* ---- the two view-driving tools ----
     Unlike everything above, these MOVE THE APP to another screen. They return
     the sentence the model then speaks, and they navigate BEFORE returning, so
     that sentence describes what is already on screen rather than promising
     something that has not happened. */

  /** Put a record on screen in the 3D estate. */
  showInEstate(target: {
    kind: 'asset' | 'space' | 'floor' | 'building';
    id: number;
  }): Promise<string>;
  /** The reverse: open the camera at an asset, or route to it when unpinned. */
  showOnSite(assetId: number): Promise<string>;
  /** Where the app is scoped, and whether AR has a fix. */
  currentPlace(): Promise<{
    siteName?: string;
    buildingName?: string;
    floorName?: string;
    localizedAt?: string;
  }>;

  voiceTurn(input: string): Promise<string>;
  speak(text: string): void;
}

/**
 * Lifted from "/Users/rajkumars/Documents/Fun projects/asset-lens/src/ar/voiceAgent.ts"
 * — cancel() before speak() so a second command interrupts the first instead of
 * queueing behind it; rate 1.05 reads as brisk without sounding clipped.
 */
export function speak(text: string): void {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    // no speech synthesis (or jsdom) — the transcript still shows the answer
  }
}

export const defaultDeps: VoiceDeps = {
  searchAssets: (search) => provider.searchAssets(search),
  listWorkOrdersForAssets: (assetIds) => provider.listWorkOrdersForAssets(assetIds),
  listWorkOrderTasks: (workOrderId) => provider.listWorkOrderTasks(workOrderId),
  setTaskStatus: (workOrderId, taskId, closed) =>
    provider.setWorkOrderTaskStatus(workOrderId, taskId, closed),
  getStatuses: () => provider.getWorkOrderStatuses(),
  changeStatus: (workOrderId, status) => provider.changeWorkOrderStatus(workOrderId, status),
  createWorkOrder: (draft) => provider.createWorkOrder(draft),
  listOpenWorkOrders: async () => {
    const page = await provider.listWorkOrders({ pageSize: 50 });
    return page.data.filter((w) => !/closed|cancelled|resolved/i.test(w.status ?? ''));
  },
  routeToAsset: async (assetId) => {
    // Resolution is the agent's job; ROUTING is the router's. This just hands
    // the destination to the same code the Wayfinder screen uses.
    const surveys = (await appStore.kvList<Survey>('surveys', 'survey.', 200))
      .map((r) => r.value)
      .filter((s) => s && Array.isArray(s.markers));
    const host = surveys.find((s) => s.markers.some((m) => m.assetId === assetId));
    if (!host?.siteId) return null;
    const graph = withSurveyNodes(await loadGraph(host.siteId), surveys);
    const destination = nodeForSurvey(graph, host.id);
    if (!destination) return null;
    // Without a scanned position we can still name the destination; a step
    // list needs a start, and inventing one would be a lie.
    const start = graph.nodes.find((n) => n.kind === 'entrance');
    const route = start ? findRoute(graph, start.id, destination.id) : null;
    return { destination: destination.name, steps: (route?.steps ?? []).map((s) => s.text) };
  },
  uploadPhoto: (blob, name) => appStore.uploadPhoto(blob, name),
  draftWorkOrder,
  identifyAsset,
  voiceTurn,
  speak,
  getWorkOrder: (id) => provider.getWorkOrder(id),
  addWorkOrderTask: (workOrderId, subject) => provider.addWorkOrderTask(workOrderId, subject),
  findLocations: async (text) => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const [sitesPage, buildings, floors, spaces] = await Promise.all([
      provider.listSites({ pageSize: 100 }).catch(() => ({ data: [] as Site[] })),
      provider.listBuildings().catch(() => [] as Building[]),
      provider.listFloors().catch(() => [] as Floor[]),
      provider.listAllSpaces().catch(() => [] as Space[]),
    ]);
    const sites = sitesPage.data;
    const idAsked = /^\d+$/.test(q) ? Number(q) : undefined;
    const hits: LocationHit[] = [];
    const match = (name: string, id: number) =>
      (idAsked !== undefined && id === idAsked) || name.toLowerCase().includes(q);
    for (const s of sites) if (match(s.name, s.id)) hits.push({ kind: 'site', id: s.id, name: s.name });
    for (const b of buildings)
      if (match(b.name, b.id))
        hits.push({
          kind: 'building',
          id: b.id,
          name: b.name,
          parent: sites.find((s) => s.id === b.siteId)?.name,
        });
    for (const f of floors)
      if (match(f.name, f.id))
        hits.push({
          kind: 'floor',
          id: f.id,
          name: f.name,
          parent: buildings.find((b) => b.id === f.buildingId)?.name,
        });
    for (const sp of spaces)
      if (match(sp.name, sp.id)) hits.push({ kind: 'space', id: sp.id, name: sp.name });
    return hits.slice(0, 8);
  },
  routeToPlace: async (hit) => {
    // A place routes like an asset does: find a survey standpoint that lives
    // in it, then let the router walk the graph. No standpoint = unmapped,
    // said plainly — inventing corridors would be worse than declining.
    const surveys = (await appStore.kvList<Survey>('surveys', 'survey.', 200))
      .map((r) => r.value)
      .filter((s) => s && Array.isArray(s.markers));
    const inPlace = surveys.find((s) =>
      hit.kind === 'building'
        ? s.buildingId === hit.id
        : hit.kind === 'floor'
          ? s.floorId === hit.id
          : hit.kind === 'site'
            ? s.siteId === hit.id
            : false,
    );
    if (!inPlace?.siteId) return null;
    const graph: WayGraph = withSurveyNodes(await loadGraph(inPlace.siteId), surveys);
    const destination = nodeForSurvey(graph, inPlace.id);
    if (!destination) return null;
    const start = graph.nodes.find((n) => n.kind === 'entrance');
    const route = start ? findRoute(graph, start.id, destination.id) : null;
    return { destination: destination.name, steps: (route?.steps ?? []).map((s) => s.text) };
  },

  showInEstate: async ({ kind, id }) => {
    // The 3D screen resolves ?asset= itself, including the case where a record
    // exists in Facilio but has no place in the model. Only assets are placeable
    // — spaces, floors and buildings are containers the camera flies to, and the
    // engine's locate() indexes markers only.
    if (kind !== 'asset') {
      goToTab('estate');
      return 'Opening the 3D estate.';
    }
    const asset = await provider.getAsset(id);
    goToTab('estate', { asset: id });
    return asset
      ? `Showing ${asset.name} in the 3D estate${asset.spaceName ? ` — ${asset.spaceName}` : ''}.`
      : `Showing asset ${id} in the 3D estate.`;
  },

  showOnSite: async (assetId) => {
    const asset = await provider.getAsset(assetId);
    const name = asset?.name ?? `asset ${assetId}`;
    const plan = await planFindOnSite({
      assetId,
      assetName: name,
      scope: {},
      placeLabel: asset?.spaceName,
    });
    // The unsurveyed case does NOT navigate — same honesty rule direction_to
    // already follows. Sending someone to a screen that cannot help is worse
    // than saying so.
    if (plan.kind !== 'unsurveyed') goToTab(plan.kind === 'ar' ? 'ar' : 'wayfinder', { asset: assetId });
    return plan.caption;
  },

  currentPlace: async () => {
    // sessionStorage is where LocationContext persists its scope; reading it
    // here keeps deps free of React.
    try {
      const raw = sessionStorage.getItem('fv.location');
      const parsed = raw ? (JSON.parse(raw) as { names?: Record<string, string> }) : null;
      return {
        siteName: parsed?.names?.site,
        buildingName: parsed?.names?.building,
        floorName: parsed?.names?.floor,
      };
    } catch {
      return {};
    }
  },
};
