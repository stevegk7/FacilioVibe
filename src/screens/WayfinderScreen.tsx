/**
 * Wayfinder — Work Order → Asset → Location → route, rebuilt on the wayfinding
 * research in docs/WAYFINDING.md. The load-bearing decisions:
 *
 * - POSITION IS DISCRETE AND HONEST. There is no continuous indoor pose; you
 *   are where you last scanned, and the anchor card SAYS how it knows and how
 *   old that knowledge is. No blue dot is ever faked.
 * - PREVIEW FIRST, GUIDED OPT-IN. Technicians are repeat users of the same
 *   buildings; the field data says they prefer a full route preview over
 *   forced turn-by-turn. "Guide me" is one tap away, never mandatory.
 * - STEPS NEVER SELF-ADVANCE. A tap says "done", a scan PROVES "here" — and a
 *   scan of ANY code quietly re-anchors and recomputes ("Route updated from
 *   <node>"), because being lost is a re-anchor, not an error state.
 * - FLOOR CHANGES ARE INTERSTITIALS. The highest-error moment indoors gets a
 *   dedicated card, not another list row.
 * - THE ASSISTANT IS A GROUNDED RESOLVER. Plain search answers plain names;
 *   the fv-voice tool loop answers language ("the pump that needs a filter
 *   change") — and either way the terminal act is SETTING THE ROUTE, never
 *   composing prose directions.
 * - THE LAST LEG BELONGS TO AR. Marker bearings are rays with no range; the
 *   route ends at the destination standpoint and the arrival card hands off
 *   to the AR arrow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { appStore } from '../api/appStore';
import { provider } from '../api/provider';
import { seedMockDemoData } from '../api/seedDemoData';
import { loadEditGraphPolicy, policyAllows } from '../api/permissions';
import { resolveDestination } from '../api/agents';
import { useLocationScope } from '../state/LocationContext';
import { useGeoFix } from '../hooks/useGeoFix';
import { useHeading } from '../hooks/useHeading';
import { useVoice } from '../voice/useVoice';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import DsSelect from '../components/DsSelect';
import LocationPicker from '../components/LocationPicker';
import ScanCodeSheet from '../components/ScanCodeSheet';
import FacingCone from '../components/FacingCone';
import FloorPlate from '../components/FloorPlate';
import { loadGraph, nodeForCode, nodeForSurvey, saveGraph, withSurveyNodes, nodeById } from '../wayfinding/graph';
import type { EdgeKind, NodeKind, WayGraph, WayNode } from '../wayfinding/graph';
import { anchorFromFix, findRoute } from '../wayfinding/router';
import type { Route, RouteStep } from '../wayfinding/router';
import { mapsDirectionsUrl } from '../wayfinding/legs';
import { surveyForAsset, surveyForPlace } from '../wayfinding/resolve';
import { canShowFacing, relativeBearing, turnPhrase } from '../wayfinding/facing';
import type { PlateGeometry, PlateRect } from '../wayfinding/plate';
import { useEstate } from '../estate/useEstate';
import { buildAutoGraph, findNode, legEdge, routeOnGraph } from '../wayfinding/autoGraph';
import type { AutoGraph, AutoNode, AutoRoute } from '../wayfinding/autoGraph';
import {
  OverlayConflictError,
  applyOverlay,
  loadOverlay,
  saveEdgeNote,
} from '../wayfinding/autoGraphStore';
import { legsToRouteSpec } from '../wayfinding/routeDraw';
import { computeOutdoorRoute, type OutdoorRoute } from '../api/outdoor';
import {
  fallbackGuidance,
  handoffPayload,
  loadChat,
  nodeWhere,
  resolvePortfolio,
  routeText,
  storeChat,
  type WfChip,
  type WfMessage,
} from '../wayfinding/conversation';
import {
  anchorAgeText,
  anchorIsStale,
  arrivalPhase,
  estimateSeconds,
  floorPhases,
  isFloorChange,
  minutesText,
  type Anchor,
  type Destination,
  type JourneyPhase,
} from '../wayfinding/journey';
import { currentTab, onNavigate, navParamId, setNavParams, goToTab } from '../shell/router';
import { stampStopByCode } from '../rounds/roundsStore';
import { runToolLoop } from '../voice/toolLoop';
import { defaultDeps, type VoiceDeps } from '../voice/deps';
import type { Asset, SiteGeo, Survey, WorkOrder } from '../api/types';
import './wayfinder.css';

type Mode = 'route' | 'edit';

/** Session-sticky anchor — a tab switch must not forget where you scanned. */
const ANCHOR_KEY = 'fv.wayfinder.anchor';

function loadAnchor(): Anchor | null {
  try {
    const raw = sessionStorage.getItem(ANCHOR_KEY);
    const parsed = raw ? (JSON.parse(raw) as Anchor) : null;
    return parsed && typeof parsed.nodeId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function storeAnchor(anchor: Anchor | null): void {
  try {
    if (anchor) sessionStorage.setItem(ANCHOR_KEY, JSON.stringify(anchor));
    else sessionStorage.removeItem(ANCHOR_KEY);
  } catch {
    /* private mode — the in-memory state still works */
  }
}

/** The outdoor leg's endpoint geo — only when it genuinely crosses two sites
    that both have coordinates. An intra-site hop has no two points to route
    between, and pretending otherwise would draw a confident wrong walk. */
function outdoorGeoEnds(
  graph: AutoGraph,
  nodeIds: string[],
): { from: { lat: number; lng: number }; to: { lat: number; lng: number } } | null {
  const sites = nodeIds
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is AutoNode => !!n && n.kind === 'site' && !!n.geo);
  if (sites.length < 2) return null;
  return { from: sites[0].geo!, to: sites[sites.length - 1].geo! };
}

/** Browse order for the pickers: the containment hierarchy, coarse to fine. */
function defaultPickList(graph: AutoGraph | null): AutoNode[] {
  if (!graph) return [];
  const order: Record<string, number> = { site: 0, building: 1, floor: 2, space: 3, asset: 4, core: 9 };
  return graph.nodes
    .filter((n) => n.kind !== 'core') // stair cores are plumbing, not places
    .slice()
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.label.localeCompare(b.label));
}

function useGraph(siteId: number | undefined, surveys: Survey[], surveysReady: boolean) {
  return useQuery({
    // Keyed on the survey IDENTITIES, not their count: two different surveys
    // of the same number served a stale graph from cache, and a renamed
    // standpoint never reached the node list.
    queryKey: ['wf-graph', siteId ?? 0, surveys.map((s) => s.id).sort().join(',')],
    queryFn: async () => withSurveyNodes(await loadGraph(siteId ?? 0), surveys),
    // Waiting for the surveys read is what keeps a half-built graph — one with
    // edges pointing at sv: nodes that do not exist yet — out of the hands of
    // destination resolution, which would call a pinned asset unpinned.
    enabled: siteId !== undefined && surveysReady,
  });
}

const OPEN_WO = /open|submitted|assigned|progress|yet to start|on hold/i;

export default function WayfinderScreen() {
  const { scope, names } = useLocationScope();
  const queryClient = useQueryClient();
  const getFix = useGeoFix(true);
  const [mode, setMode] = useState<Mode>('route');
  const [anchor, setAnchor] = useState<Anchor | null>(loadAnchor);
  const [dest, setDest] = useState<Destination | null>(null);
  const [journey, setJourney] = useState<JourneyPhase>('preview');
  const [stepIdx, setStepIdx] = useState(0);
  const [scanOpen, setScanOpen] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  /** Assistant lane: last reply + disambiguation candidates. */
  const [assistText, setAssistText] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const [candidates, setCandidates] = useState<Asset[]>([]);
  /** The conversation IS the navigator now — one thread, persisted per session. */
  const [thread, setThread] = useState<WfMessage[]>(loadChat);
  const spokeRef = useRef(false);
  /** Landmark authoring: which derived edge is being written, and its text. */
  const [noteFor, setNoteFor] = useState<{ edgeId: string; current: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // The whole mock app is walkable with zero setup — wayfinding included.
  useEffect(() => {
    void seedMockDemoData().then(() =>
      queryClient.invalidateQueries({ queryKey: ['surveys'] }),
    );
  }, [queryClient]);

  const surveys = useQuery({
    queryKey: ['surveys'],
    queryFn: () =>
      appStore
        .kvList<Survey>('surveys', 'survey.', 200)
        .then((rows) => rows.map((r) => r.value).filter((s) => s && Array.isArray(s.markers))),
  });

  // The KV holds every site's standpoints in one collection. Without this
  // filter another site's standpoints became nodes in THIS site's graph, its
  // codes anchored you "here", and its assets resolved as routable.
  const siteSurveys = useMemo(
    () => (surveys.data ?? []).filter((s) => scope.siteId == null || s.siteId === scope.siteId),
    [surveys.data, scope.siteId],
  );

  const graphQuery = useGraph(scope.siteId, siteSurveys, !surveys.isPending);
  const graph = graphQuery.data;

  /* ---------------- the portfolio lane ----------------
     Survey standpoints route you to a PIN with AR precision; the auto graph
     routes you to ANY record — every site, building, floor, space and asset
     is a node, derived from the same estate geometry the 3D screen draws,
     plus whatever refinements the overlay carries. */
  const estate = useEstate();
  const siteGeos = useQuery({
    queryKey: ['wf-sitegeos'],
    queryFn: async () => {
      const rows = await appStore.kvList<SiteGeo>('settings', 'sitegeo.', 50);
      const map: Record<string, { lat: number; lng: number }> = {};
      for (const row of rows) {
        if (row.value && Number.isFinite(row.value.lat)) {
          map[row.key.slice('sitegeo.'.length)] = { lat: row.value.lat, lng: row.value.lng };
        }
      }
      return map;
    },
  });
  const overlayQuery = useQuery({
    queryKey: ['wf-autograph-overlay', scope.siteId ?? 0],
    queryFn: () => loadOverlay(scope.siteId ?? 0),
  });

  /* Authoring the route graph is gated for the same reason placing an asset
     marker is: every later route trusts it, a wrong landmark is followed by
     everyone who reads it, and preview and production share one database — so an
     edit made while testing lands under a technician in the field. Same policy
     shape and the same open-by-default as the asset gate. */
  const mayEditGraphQuery = useQuery({
    queryKey: ['wf-may-edit-graph'],
    queryFn: async () => {
      const [policy, me] = await Promise.all([
        loadEditGraphPolicy(),
        provider.getCurrentUser().catch(() => null),
      ]);
      return policyAllows(policy, me?.user.email);
    },
  });
  const mayEditGraph = mayEditGraphQuery.data ?? false;
  // buildEstate + buildAutoGraph are the estate geometry pipeline — they live
  // in the 3D chunk, and importing them statically here dragged them into the
  // entry bundle (the budget guard caught it, 1,087 B over). Dynamic import
  // keeps the AR cold path lean; the query caches the built graph.
  const autoGraphQuery = useQuery({
    queryKey: [
      'wf-autograph',
      scope.siteId ?? 0,
      estate.dataUpdatedAt,
      siteGeos.dataUpdatedAt,
      overlayQuery.data?.version ?? 0,
    ],
    enabled: !!estate.data,
    queryFn: async (): Promise<{ graph: AutoGraph; plates: Record<number, PlateGeometry> }> => {
      // Only buildEstate is deferred: the graph module itself is small and its
      // route/find functions run in render paths, but the geometry builder is
      // the heavy half and already lives in the lazy 3D chunk.
      const { buildEstate } = await import('../estate/buildEstate');
      const built = buildEstate(estate.data!, { sampleHealth: false });
      /* Site coordinates now come from the CMMS itself (the `location` lookup on
         the site record), with the Settings-typed KV kept as an OVERRIDE rather
         than the source. Before this the KV was the only lane, so a site nobody
         had hand-geotagged could never take part in a site-to-site route — and
         the screen's own advice to "add site coordinates in Settings" could not
         work anyway, because the graph keyed sites by name and the KV by id. */
      const fromCmms: Record<string, { lat: number; lng: number }> = {};
      for (const s of built.sites) {
        if (typeof s.lat === 'number' && typeof s.lng === 'number') {
          fromCmms[String(s.recordId)] = { lat: s.lat, lng: s.lng };
        }
      }
      const siteGeo = { ...fromCmms, ...(siteGeos.data ?? {}) };
      /* Per-floor geometry for the 2D plate, harvested from the SAME build that
         produced the graph. The estate is the expensive thing here (seven paged
         reads plus the CAD plans); building it twice to draw a floor plan would
         be the whole cost again for data already in hand. Floor-local metres, so
         it shares the frame with the route legs and needs no projection. */
      const plates: Record<number, PlateGeometry> = {};
      for (const b of built.buildings) {
        for (const f of b.floors) {
          const plan = f.plan as
            | { layers?: { walls?: number[][][] }; rooms?: PlateRect[] }
            | null
            | undefined;
          plates[f.recordId] = {
            ...(plan?.layers?.walls ? { walls: plan.layers.walls } : {}),
            ...(plan?.rooms ? { rooms: plan.rooms } : {}),
            // A floor with no bound plan still has its synthesised space
            // outlines, which is enough to show a route in context.
            spaces: (f.spaces ?? [])
              .map((sp) => sp.polygon)
              .filter((poly): poly is number[][] => Array.isArray(poly) && poly.length > 2),
          };
        }
      }
      return {
        graph: applyOverlay(buildAutoGraph(built, { siteGeo }), overlayQuery.data ?? null),
        plates,
      };
    },
  });
  const autoGraph: AutoGraph | null = autoGraphQuery.data?.graph ?? null;
  const plates = autoGraphQuery.data?.plates ?? null;

  const [autoFrom, setAutoFrom] = useState<AutoNode | null>(null);
  const [autoTo, setAutoTo] = useState<AutoNode | null>(null);
  const [pickerFor, setPickerFor] = useState<'from' | 'to' | null>(null);
  const [pickerQ, setPickerQ] = useState('');
  const [outdoorInfo, setOutdoorInfo] = useState<OutdoorRoute | null>(null);
  const [autoArrived, setAutoArrived] = useState(false);

  /** "Current location", resolved honestly and in trust order: a scan proves,
      the 3D view's live selection shows, the location scope suggests. */
  const currentAutoNode = useMemo((): AutoNode | null => {
    if (!autoGraph) return null;
    if (anchor && graph) {
      const at = nodeById(graph, anchor.nodeId);
      if (at) {
        /* Bridge by RECORD ID, most specific first.
           This used to match the standpoint's display NAME against auto-graph
           labels — "Tower B — Main Entrance" against a graph that only holds
           "Tower B" — so it returned nothing for every standpoint this app can
           create. A scan or a GPS fix therefore set the header's origin and left
           this lane, the one that routes to ANY record, saying "Pick a start".
           WayNode already carries the ids, so the join needs no names at all.
           Floor granularity is the honest ceiling until standpoints themselves
           become auto-graph nodes: the route starts from the floor's circulation
           point rather than the exact standpoint, which is a real position
           instead of no position. */
        for (const id of [
          at.floorId != null ? `floor:${at.floorId}` : null,
          at.buildingId != null ? `building:${at.buildingId}` : null,
        ]) {
          if (!id) continue;
          const node = autoGraph.nodes.find((n) => n.id === id);
          if (node) return node;
        }
        /* Last resort, kept because it costs nothing: a standpoint named after
           the space it stands in ("Plant Room B") still resolves by name. */
        const hit = findNode(autoGraph, at.name)[0];
        if (hit) return hit;
      }
    }
    // What the user last looked at in the 3D estate (shared nav context).
    try {
      const ctx = JSON.parse(sessionStorage.getItem('fv.navContext') ?? '{}') as {
        assetId?: number; spaceId?: number; floorId?: number; at?: number;
      };
      if (ctx.at && Date.now() - ctx.at < 15 * 60_000) {
        for (const id of [
          ctx.assetId != null ? `asset:${ctx.assetId}` : null,
          ctx.spaceId != null ? `space:${ctx.spaceId}` : null,
          ctx.floorId != null ? `floor:${ctx.floorId}` : null,
        ]) {
          if (!id) continue;
          const node = autoGraph.nodes.find((n) => n.id === id);
          if (node) return node;
        }
      }
    } catch {
      /* unreadable context — fall through to the scope */
    }
    const scoped = [
      scope.floorId != null ? `floor:${scope.floorId}` : null,
      scope.buildingId != null ? `building:${scope.buildingId}` : null,
      scope.siteId != null ? `site:${scope.siteId}` : null,
    ];
    for (const id of scoped) {
      if (!id) continue;
      const node = autoGraph.nodes.find((n) => n.id === id);
      if (node) return node;
    }
    return null;
  }, [autoGraph, anchor, graph, scope]);

  const fromNode = autoFrom ?? currentAutoNode;
  const autoRoute: AutoRoute | null = useMemo(
    () =>
      autoGraph && fromNode && autoTo && fromNode.id !== autoTo.id
        ? routeOnGraph(autoGraph, fromNode.id, autoTo.id)
        : null,
    [autoGraph, fromNode, autoTo],
  );

  // Real distance/duration for the outdoor leg once google-maps-routes is
  // linked. The deep link below never waits for this — it is an enrichment.
  useEffect(() => {
    setOutdoorInfo(null);
    if (!autoRoute || autoRoute.unroutable || !autoGraph) return;
    const outdoor = autoRoute.legs.find((leg) => leg.kind === 'outdoor');
    const ends = outdoor ? outdoorGeoEnds(autoGraph, outdoor.nodes) : null;
    if (!ends) return;
    let live = true;
    void computeOutdoorRoute(ends.from, ends.to).then((r) => {
      if (live) setOutdoorInfo(r);
    });
    return () => {
      live = false;
    };
  }, [autoRoute, autoGraph]);

  useEffect(() => setAutoArrived(false), [autoTo?.id]);

  /**
   * Write a landmark against the derived edge a leg arrives on.
   *
   * The version the author was LOOKING AT goes with the write, so a second
   * author who has been editing the same site since this copy was read is
   * detected rather than silently overwritten. On success the overlay query is
   * invalidated, which rebuilds the graph and re-phrases the route — the author
   * reads their own sentence back immediately.
   */
  const saveLandmark = async (instruction: string) => {
    if (!noteFor || scope.siteId == null) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const me = await provider.getCurrentUser().catch(() => null);
      await saveEdgeNote(
        scope.siteId,
        noteFor.edgeId,
        { instruction, at: new Date().toISOString(), by: me?.user.email },
        overlayQuery.data?.version ?? 0,
      );
      await queryClient.invalidateQueries({ queryKey: ['wf-autograph-overlay', scope.siteId] });
      setNoteFor(null);
    } catch (err) {
      setNoteError(
        err instanceof OverlayConflictError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that landmark.',
      );
      // A conflict means this screen is holding a stale overlay; pull the
      // current one so a retry is written against what is actually stored.
      if (err instanceof OverlayConflictError) {
        await queryClient.invalidateQueries({ queryKey: ['wf-autograph-overlay', scope.siteId] });
      }
    } finally {
      setNoteBusy(false);
    }
  };

  const showRouteIn3d = () => {
    // The estate screen consumes this after its engine mounts — a route drawn
    // before the floor exists would be a ribbon in the void. The destination
    // rides along so the 3D view highlights it, route or no route.
    const legs = autoRoute && !autoRoute.unroutable ? legsToRouteSpec(autoRoute.legs) : [];
    if (legs.length === 0 && !autoTo) return;
    sessionStorage.setItem('fv.pendingRoute', JSON.stringify(handoffPayload(legs, autoTo)));
    goToTab('estate');
  };

  /* ---------------- the conversation ---------------- */

  useEffect(() => storeChat(thread), [thread]);

  const say = useCallback((text: string, chips?: WfChip[]) => {
    setThread((t) => [...t, { role: 'ai', text, chips, at: Date.now() }]);
  }, []);

  /** Set a portfolio destination and answer in the thread — route, or honest
      fallback guidance composed from the hierarchy, never an empty state. */
  const applyPortfolioDest = useCallback(
    (node: AutoNode) => {
      setAutoTo(node);
      setAutoArrived(false);
      if (!autoGraph) return;
      const from = autoFrom ?? currentAutoNode;
      if (!from) {
        say(`Destination set — ${node.label} (${nodeWhere(autoGraph, node)}). Pick a start above, or scan a standpoint, and I'll route you.`, [
          { label: 'Show in 3D', action: { kind: 'show-3d' } },
        ]);
        return;
      }
      const r = routeOnGraph(autoGraph, from.id, node.id);
      if (r.unroutable) {
        say(fallbackGuidance(autoGraph, node), [{ label: 'Show in 3D', action: { kind: 'show-3d' } }]);
        return;
      }
      const chips: WfChip[] = [];
      if (r.legs.some((l) => l.kind === 'outdoor')) {
        chips.push({ label: 'Guide me there', action: { kind: 'guide-outdoor' } });
      }
      chips.push({ label: 'Show in 3D', action: { kind: 'show-3d' } });
      chips.push({ label: 'I’ve arrived', action: { kind: 'arrived' } });
      say(routeText(r, node.label), chips);
    },
    [autoGraph, autoFrom, currentAutoNode, say],
  );

  const onChip = (chip: WfChip) => {
    const action = chip.action;
    if (action.kind === 'pick-node') {
      const node = autoGraph?.nodes.find((n) => n.id === action.nodeId);
      if (node) {
        setThread((t) => [...t, { role: 'user', text: chip.label, at: Date.now() }]);
        applyResolvedNode(node);
      }
      return;
    }
    if (chip.action.kind === 'show-3d') return showRouteIn3d();
    if (chip.action.kind === 'guide-outdoor') return void openOutdoorLeg();
    setAutoArrived(true);
    say(`You're at ${autoTo?.label ?? 'your destination'}. Ask me anything about this place — open work orders, details — or name the next stop.`);
  };

  const openOutdoorLeg = async () => {
    if (!autoRoute || autoRoute.unroutable || !autoGraph) return;
    const leg = autoRoute.legs.find((l) => l.kind === 'outdoor');
    const ends = leg ? outdoorGeoEnds(autoGraph, leg.nodes) : null;
    if (ends) {
      window.open(
        `https://www.google.com/maps/dir/?api=1&origin=${ends.from.lat},${ends.from.lng}&destination=${ends.to.lat},${ends.to.lng}&travelmode=walking`,
        '_blank',
        'noopener',
      );
      return;
    }
    await navigateOutdoors(); // intra-site outdoor hop: the site pin is the honest fallback
  };

  // Open work orders are the reason anyone opens this screen.
  const workOrders = useQuery({
    queryKey: ['wf-workorders'],
    queryFn: () => provider.listWorkOrders({ pageSize: 50 }).then((p) => p.data),
  });

  /** Asset → its standpoint node, or null with an honest hint. */
  const destinationForAsset = useCallback(
    (asset: { id: number; name: string }, workOrderId?: number): boolean => {
      if (!graph) {
        // Silence here made work-order rows look dead. Say which of the two
        // reasons it is, because they need different actions from the user.
        setHint(
          scope.siteId == null
            ? 'Pick a site first — routes are per site.'
            : 'Still loading this site’s route map — try again in a moment.',
        );
        return false;
      }
      const host = surveyForAsset(siteSurveys, asset.id);
      const node = host ? nodeForSurvey(graph, host.id) : undefined;
      if (!node) {
        setHint(
          `${asset.name} isn't pinned in any survey yet, so there's nothing to route to. Pin it from the AR tab first.`,
        );
        return false;
      }
      setDest({ nodeId: node.id, label: asset.name, assetId: asset.id, workOrderId });
      setJourney('preview');
      setStepIdx(0);
      setHint(null);
      return true;
    },
    [graph, siteSurveys, scope.siteId],
  );

  // Handoffs land as ?asset= — react while MOUNTED, not only at mount (the
  // pre-merge screen read it once in a useState initialiser, so pushing a new
  // asset at an open Wayfinder did nothing — the exact bug router.ts names).
  const consumeAssetParam = useCallback(() => {
    // Only OUR tab's params are ours to take. popstate fires for every
    // navigation, including the one carrying an asset TO the 3D estate while
    // this screen is still mounted — consuming that would steal it.
    if (currentTab() !== 'wayfinder') return;
    const assetId = navParamId('asset');
    if (assetId == null || !graph) return;
    if (dest?.assetId === assetId) return;
    void provider.getAsset(assetId).then((asset) => {
      // Re-check: an async hop later the user may have navigated away, and
      // the param now belongs to whoever they navigated to.
      if (currentTab() !== 'wayfinder' || navParamId('asset') !== assetId) return;
      // Clear ONLY on success. Clearing after a failed resolve (surveys not
      // loaded yet, asset unpinned) burned the handoff permanently.
      if (asset && destinationForAsset(asset)) setNavParams({ asset: null });
    });
  }, [graph, dest, destinationForAsset]);

  useEffect(() => {
    consumeAssetParam();
    return onNavigate(consumeAssetParam);
  }, [consumeAssetParam]);

  // With no scan yet, GPS picks the nearest entrance — labelled as the guess
  // it is, never dressed up as a scan.
  //
  // POLLED, not sampled once: useGeoFix deliberately keeps the fix in a REF
  // (a fix arriving must not re-render the AR stage), so nothing re-runs this
  // effect when the first fix lands seconds after the graph settles. Sampling
  // once meant the auto-anchor only ever worked in mock mode, where the
  // fixture is returned synchronously. The interval stops on the first fix.
  useEffect(() => {
    if (anchor || !graph) return;
    const tryAnchor = (): boolean => {
      const fix = getFix();
      if (!fix) return false;
      // anchorFromFix applies the policy the old call had none of: an accuracy
      // ceiling, a distance bound, and entrances only. It used to fall back to
      // the nearest geotagged node of ANY kind at ANY distance, which could
      // start a route from a plant room on Level 9, or from a site entrance
      // while the technician was still at the depot.
      const near = anchorFromFix(graph, fix);
      if (!near) return false;
      setAnchor({ nodeId: near.id, via: 'gps', at: Date.now() });
      return true;
    };
    if (tryAnchor()) return;
    const timer = setInterval(() => {
      if (tryAnchor()) clearInterval(timer);
    }, 2000);
    return () => clearInterval(timer);
  }, [graph, anchor, getFix]);

  // An anchor is a claim about a PLACE; when the loaded graph has no such
  // node the claim is meaningless — a leftover from another site, or a node
  // deleted in the editor. Drop it rather than route from a phantom.
  useEffect(() => {
    if (!graph || !anchor) return;
    if (!nodeById(graph, anchor.nodeId)) setAnchor(null);
  }, [graph, anchor]);

  useEffect(() => storeAnchor(anchor), [anchor]);

  /**
   * The closed set the assistant resolves against: every asset pinned at a
   * standpoint of THIS site, with where it is and how much work is open on
   * it. A destination that is not in here cannot be routed to, so offering it
   * to the model would only invite a confident wrong answer.
   */
  const pinnedDestinations = useMemo(() => {
    const woByAsset = new Map<number, number>();
    for (const wo of workOrders.data ?? []) {
      if (!wo.resourceId || !OPEN_WO.test(wo.status ?? 'open')) continue;
      woByAsset.set(wo.resourceId, (woByAsset.get(wo.resourceId) ?? 0) + 1);
    }
    const out: Array<{
      assetId: number;
      label: string;
      where: string;
      openCount: number;
      asset: Asset;
    }> = [];
    for (const survey of siteSurveys) {
      for (const marker of survey.markers) {
        if (marker.assetId == null) continue;
        if (out.some((o) => o.assetId === marker.assetId)) continue;
        out.push({
          assetId: marker.assetId,
          label: marker.label,
          where: survey.spaceName ?? survey.name,
          openCount: woByAsset.get(marker.assetId) ?? 0,
          asset: { id: marker.assetId, name: marker.label, spaceName: survey.spaceName },
        });
      }
    }
    return out;
  }, [siteSurveys, workOrders.data]);

  /** Name of the node we are anchored at — the assistant's "HERE" line. */
  const anchoredNodeName = useMemo(
    () => (graph && anchor ? nodeById(graph, anchor.nodeId)?.name : undefined),
    [graph, anchor],
  );

  /** A survey-pinned asset keeps the scan-anchored guided lane — that is the
      AR-precise path and it must not be displaced by the portfolio route.
      Everything else (spaces, floors, buildings, unpinned assets) routes on
      the graph. Declared here, AFTER pinnedDestinations/destinationForAsset:
      a useCallback dep list evaluates at render, so hoisting this above them
      was a TDZ crash on mount. */
  const applyResolvedNode = useCallback(
    (node: AutoNode) => {
      if (node.kind === 'asset' && node.recordId != null) {
        const pinned = pinnedDestinations.find((p) => p.assetId === node.recordId);
        if (pinned && destinationForAsset(pinned.asset)) {
          say(`Route set — ${pinned.label}. Preview below; scan any standpoint to anchor exactly.`);
          return;
        }
      }
      applyPortfolioDest(node);
    },
    [pinnedDestinations, destinationForAsset, applyPortfolioDest, say],
  );

  const route: Route | null = useMemo(() => {
    if (!graph || !dest || !anchor) return null;
    return findRoute(graph, anchor.nodeId, dest.nodeId);
  }, [graph, dest, anchor]);

  // Arrival is a state, not an inference: route says "zero steps left". It
  // must also UN-arrive — re-anchoring away from the destination used to
  // leave "You've arrived" on screen while the user walked off.
  useEffect(() => {
    if (!dest) return;
    // Exhaustive on purpose. This used to handle only the two branches where a
    // route EXISTS, so `findRoute` returning null left the phase untouched — and
    // null is the NORMAL answer for a standpoint with no authored edges, which is
    // every standpoint created in the AR tab. Arriving at the plant room and then
    // scanning any un-connected standpoint left "You've arrived — <asset> is at
    // this standpoint" on screen at a place the asset is not, with the AR handoff
    // still offered. No route means "not arrived" just as loudly as a long one.
    setJourney((phase) => arrivalPhase(route, phase));
  }, [route, dest]);

  // Any change of start or destination invalidates guided progress — the
  // recomputed route's step 1 is wherever you now are.
  useEffect(() => {
    setStepIdx(0);
  }, [anchor?.nodeId, dest?.nodeId]);

  /**
   * A scanned code is the strongest fact this screen ever receives: it
   * re-anchors, proves round presence, snaps guided progress, and detects
   * arrival — all silently. Off-route is a re-anchor, never an alarm.
   */
  const applyScan = (code: string) => {
    if (!graph) return;
    const node = nodeForCode(graph, code);
    if (!node) {
      setHint(`No node carries the code "${code.trim()}" — link it in the graph editor, or scan another.`);
      return;
    }
    setScanOpen(false);
    // Stamp with the code as ENROLLED, not as typed: rounds compare exactly,
    // while node lookup is case/space-insensitive, so a hand-typed
    // "FV-SV-DEMO-PLANT" anchored here but silently failed to stamp the stop.
    void stampStopByCode(node.code ?? code).catch(() => undefined);
    setAnchor({ nodeId: node.id, via: 'scan', at: Date.now() });
    if (dest && node.id === dest.nodeId) {
      setJourney('arrived');
      setHint(null);
      return;
    }
    // The route recomputes from the scanned node, so its first remaining step
    // is index 0 — the anchor effect resets progress for us, on or off the
    // old path. Off-route is a re-anchor, never an alarm.
    setHint(dest ? `Route updated from ${node.name}` : `You are at ${node.name}`);
  };

  /* ---------------- assistant lane ---------------- */

  /**
   * Grounded resolution, cheapest lane first: plain name search against the
   * org's assets answers instantly and offline; only language that search
   * can't hold ("the pump that needs a filter change") pays for the agent
   * loop. Either lane ends the same way: the route is SET, not described.
   */
  const assistDeps: VoiceDeps = useMemo(
    () => ({
      ...defaultDeps,
      speak: (text) => {
        if (spokeRef.current) defaultDeps.speak(text);
      },
      routeToAsset: async (assetId) => {
        const result = await defaultDeps.routeToAsset(assetId);
        if (result) {
          const asset = await provider.getAsset(assetId);
          if (asset) destinationForAsset(asset);
        }
        return result;
      },
      routeToPlace: async (place) => {
        const result = await defaultDeps.routeToPlace(place);
        if (result && graph) {
          const host = surveyForPlace(surveys.data ?? [], place);
          const node = host ? nodeForSurvey(graph, host.id) : undefined;
          if (node) {
            setDest({ nodeId: node.id, label: node.name });
            setJourney('preview');
            setStepIdx(0);
          }
        }
        return result;
      },
      // Asked from the Wayfinder itself, "take me to X" means "set my route",
      // not "yank me to another tab" — override the view-mover to stay put.
      showOnSite: async (assetId) => {
        const asset = await provider.getAsset(assetId);
        if (asset && destinationForAsset(asset)) {
          return `Route set — ${asset.name}.`;
        }
        return defaultDeps.showOnSite(assetId);
      },
    }),
    [destinationForAsset, graph, surveys.data],
  );

  const runAssist = async (text: string, viaMic: boolean) => {
    const query = text.trim();
    if (!query || assistBusy) return;
    spokeRef.current = viaMic;
    setAssistBusy(true);
    setCandidates([]);
    setThread((t) => [...t, { role: 'user', text: query, at: Date.now() }]);
    try {
      // Lane 0: the portfolio graph. "AHU on the 9th floor" resolves against
      // real nodes — floor references filter, twins become a question with
      // the actual options, and nothing that isn't a node can be offered.
      const resolved = resolvePortfolio(autoGraph, query);
      if (resolved.kind === 'one') {
        applyResolvedNode(resolved.node);
        return;
      }
      if (resolved.kind === 'many') {
        say(
          resolved.question,
          resolved.candidates.map((n) => ({
            label: `${n.label} — ${nodeWhere(autoGraph!, n)}`,
            action: { kind: 'pick-node' as const, nodeId: n.id },
          })),
        );
        return;
      }
      // Lane 1: the query is a name. One hit routes; several become chips.
      const hits = (await provider.searchAssets({ text: query, scope })).slice(0, 6);
      if (hits.length === 1) {
        destinationForAsset(hits[0]);
        return;
      }
      if (hits.length > 1) {
        setCandidates(hits);
        return;
      }
      // Lane 2: fv-wayfinder resolves language against the destinations that
      // actually EXIST here — the pinned assets of this site's standpoints.
      // It picks a list position, never an id, so it cannot invent a place.
      const routable = pinnedDestinations;
      if (routable.length > 0) {
        const pick = await resolveDestination(
          query,
          routable.map((r) => ({
            name: r.label,
            where: r.where,
            openWorkOrders: r.openCount,
          })),
          { siteName: names.site, standpointName: anchoredNodeName },
        );
        if (pick.index != null && routable[pick.index]) {
          const chosen = routable[pick.index];
          destinationForAsset({ id: chosen.assetId, name: chosen.label });
          return;
        }
        if (pick.ask) {
          say(pick.ask);
          setCandidates(routable.slice(0, 4).map((r) => r.asset));
          return;
        }
      }
      // Lane 3: not a destination at all ("what's open on the chiller") —
      // the same tool loop Effi runs, with deps that set the route here
      // instead of describing it or switching tabs.
      const result = await runToolLoop(query, { siteId: scope.siteId }, assistDeps);
      say(result.answer);
    } catch (err) {
      say(err instanceof Error ? err.message : 'Something went wrong — try again.');
    } finally {
      setAssistBusy(false);
      setAssistText('');
    }
  };

  const voice = useVoice((text) => void runAssist(text, true));

  /* ---------------- outdoor fallback ---------------- */

  const navigateOutdoors = async () => {
    if (scope.siteId == null) return;
    const geo = await appStore.kvGet<SiteGeo>('settings', `sitegeo.${scope.siteId}`);
    if (!geo) {
      setHint('No coordinates for this site — add them in Settings');
      return;
    }
    window.open(mapsDirectionsUrl(geo.lat, geo.lng), '_blank', 'noopener');
  };

  /* ---------------- render ---------------- */

  if (mode === 'edit' && graph) {
    return <GraphEditor graph={graph} onBack={() => setMode('route')} onSaved={() => graphQuery.refetch()} />;
  }

  const atNode = graph && anchor ? nodeById(graph, anchor.nodeId) : undefined;
  const openWos = (workOrders.data ?? []).filter(
    (w) => w.resourceId && OPEN_WO.test(w.status ?? 'open'),
  );
  const startable = graph?.nodes.filter((n) => n.code || n.kind === 'entrance') ?? [];

  return (
    <section className="screen wf-screen">
      <header className="wf-head">
        <div className="sv-head-row">
          <span className="sv-title-wrap">
            <h2 className="sv-h1">Wayfinder</h2>
            <span className="sv-org">{names.site ?? 'All sites'}</span>
          </span>
          <button className="sv-chip" onClick={() => setSiteOpen(true)}>
            {names.site ?? 'Pick site'}
            <Icon name="chevron-down" size={16} />
          </button>
        </div>

        {/* The assistant row: names route instantly, language goes to Effi. */}
        <div className="wf-assist" role="search">
          <Icon name="search" size={18} className="wf-assist-icon" />
          <input
            className="wf-assist-input"
            value={assistText}
            onChange={(e) => setAssistText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runAssist(assistText, false);
            }}
            placeholder="Where to? Name an asset, or ask"
            aria-label="Destination"
            disabled={assistBusy}
          />
          {voice.supported && (
            <button
              className={voice.listening ? 'wf-mic live' : 'wf-mic'}
              onClick={voice.toggle}
              aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
            >
              <Icon name="mic" size={18} />
            </button>
          )}
        </div>

        <div className="wf-where">
          <span className="wf-where-label">From</span>
          <button className="wf-where-btn" onClick={() => setStartOpen(true)}>
            <span className="wf-where-name">
              {atNode ? atNode.name : 'Not set'}
              {anchor && atNode && (
                <span className={anchorIsStale(anchor) ? 'wf-where-age stale' : 'wf-where-age'}>
                  {anchorAgeText(anchor)}
                </span>
              )}
            </span>
            <Icon name="chevron-down" size={16} />
          </button>
          <button className="btn-quiet wf-scan-btn" onClick={() => setScanOpen(true)}>
            <Icon name="qr" size={18} /> Scan
          </button>
        </div>
      </header>

      <div className="wf-body scroll-y">
        {(thread.length > 0 || assistBusy) && (
          <div className="wf-thread" role="log" aria-label="Navigation conversation">
            {thread.map((m, i) => (
              <div key={`${m.at}-${i}`} className={m.role === 'user' ? 'wf-msg wf-msg--user' : 'wf-msg wf-msg--ai'}>
                <p className="wf-msg-text">{m.text}</p>
                {m.chips && m.chips.length > 0 && (
                  <div className="wf-msg-chips">
                    {m.chips.map((c, j) => (
                      <button key={j} className="wf-chip-btn" onClick={() => onChip(c)}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {assistBusy && (
              <div className="wf-msg wf-msg--ai">
                <p className="wf-msg-text">Thinking…</p>
              </div>
            )}
          </div>
        )}
        {hint && <p className="wf-hint">{hint}</p>}

        {candidates.length > 0 && (
          <div className="wf-candidates" role="group" aria-label="Did you mean">
            <span className="section-label">Did you mean</span>
            <div className="wf-candidate-chips">
              {candidates.map((asset) => (
                <button
                  key={asset.id}
                  className="wf-candidate-chip"
                  onClick={() => {
                    setCandidates([]);
                    destinationForAsset(asset);
                  }}
                >
                  <span className="wf-candidate-name">{asset.name}</span>
                  {asset.spaceName && <span className="wf-candidate-meta">{asset.spaceName}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ---------------- portfolio route lane ---------------- */}
        <div className="wf-auto" role="group" aria-label="Route anywhere">
          <span className="section-label">Route anywhere in the portfolio</span>
          <div className="wf-auto-ends">
            <button className="wf-where-btn" onClick={() => { setPickerFor('from'); setPickerQ(''); }}>
              <span className="wf-where-name">
                <span className="wf-auto-endlabel">From</span>
                {autoFrom?.label ?? (currentAutoNode ? `${currentAutoNode.label} · current` : 'Pick a start')}
              </span>
              <Icon name="chevron-down" size={16} />
            </button>
            <button className="wf-where-btn" onClick={() => { setPickerFor('to'); setPickerQ(''); }}>
              <span className="wf-where-name">
                <span className="wf-auto-endlabel">To</span>
                {autoTo?.label ?? 'Any site, building, floor, space or asset'}
              </span>
              <Icon name="chevron-down" size={16} />
            </button>
          </div>

          {autoTo && !fromNode && (
            <p className="wf-hint">
              Destination set — pick a start above (or scan a standpoint, or choose a site) so the
              route has somewhere to begin.
            </p>
          )}

          {autoRoute && 'unroutable' in autoRoute && autoRoute.unroutable && (
            <p className="wf-hint">
              {autoRoute.reason}
              {/geo|coordinat/i.test(autoRoute.reason) && (
                <>
                  {' — '}
                  <button className="wf-link" onClick={() => goToTab('settings')}>
                    add site coordinates in Settings
                  </button>
                </>
              )}
            </p>
          )}

          {autoRoute && !autoRoute.unroutable && !autoArrived && (
            <div className="wf-auto-route">
              {autoRoute.legs.map((leg, i) => {
                const edge = autoGraph ? legEdge(autoGraph, leg) : undefined;
                const authored = Boolean(edge?.instruction);
                /* A plate only for INDOOR legs: those points are floor-local, and
                   the geometry they would be drawn over is the same floor's. An
                   outdoor leg's points are world metres — drawing them on a floor
                   plan would be a confident lie in the wrong frame. A vertical leg
                   has nothing to draw at all; the step narrates the climb. */
                const plate =
                  leg.kind === 'indoor' && leg.floorId != null ? plates?.[leg.floorId] : null;
                const floorLabel =
                  leg.floorId != null && autoGraph
                    ? autoGraph.nodes.find((n) => n.kind === 'floor' && n.recordId === leg.floorId)
                        ?.label
                    : undefined;
                return (
                  <div key={i} className="wf-auto-legwrap">
                    <div className="wf-auto-leg">
                      <span className={`wf-auto-legkind wf-auto-legkind--${leg.kind}`}>{leg.kind}</span>
                      <span className="wf-auto-leginstr">{leg.instruction}</span>
                      {/* Distance is derived from schematic geometry on any floor
                          without a bound plan, so it stays secondary to the words. */}
                      <span className="wf-auto-legdist">{Math.round(leg.distanceM)} m</span>
                      {mayEditGraph && edge && (
                        <button
                          className={authored ? 'wf-landmark-btn is-set' : 'wf-landmark-btn'}
                          onClick={() => {
                            setNoteFor({ edgeId: edge.id, current: edge.instruction ?? '' });
                            setNoteText(edge.instruction ?? '');
                            setNoteError(null);
                          }}
                          aria-label={
                            authored ? `Edit the landmark for: ${leg.instruction}` : `Add a landmark for: ${leg.instruction}`
                          }
                          title={authored ? 'Edit this landmark' : 'Add a landmark'}
                        >
                          <Icon name={authored ? 'note' : 'plus'} size={14} />
                        </button>
                      )}
                    </div>
                    {plate && (
                      <FloorPlate geometry={plate} route={leg.points} label={floorLabel} />
                    )}
                  </div>
                );
              })}
              {outdoorInfo && (
                <p className="wf-hint" style={{ margin: 0 }}>
                  Outdoor leg: {Math.round(outdoorInfo.distanceM)} m · about{' '}
                  {Math.max(1, Math.round(outdoorInfo.durationS / 60))} min on foot (Google)
                </p>
              )}
              <div className="wf-route-actions">
                {autoRoute.legs.some((l) => l.kind === 'outdoor') && (
                  <button className="btn-cta" onClick={() => void openOutdoorLeg()}>
                    <Icon name="pin" size={18} /> Guide me there
                  </button>
                )}
                <button className="btn-quiet" onClick={showRouteIn3d}>
                  <Icon name="cube" size={18} /> Show in 3D
                </button>
                <button
                  className="btn-quiet"
                  onClick={() => {
                    setAutoArrived(true);
                    setHint(
                      `You're at ${autoTo?.label}. Ask below — "open work orders here", or route on to the next stop.`,
                    );
                  }}
                >
                  I’ve arrived
                </button>
              </div>
            </div>
          )}

          {autoArrived && autoTo && (
            <p className="wf-hint">
              At {autoTo.label}. The assistant above knows this place — ask it anything, or pick the
              next destination.
            </p>
          )}
        </div>

        {scope.siteId == null && (
          <p className="empty-card">Pick a site above to plan a route.</p>
        )}

        {/* A failed READ is not an empty site. Without this branch a 5xx, an
            expired session or an unpromoted fvApi rendered "no route map yet"
            and sent the technician off to author a graph that already exists. */}
        {scope.siteId != null && (graphQuery.isError || surveys.isError) && (
          <p className="empty-card wf-empty-error" role="alert">
            Couldn&apos;t load this site&apos;s route map
            {graphQuery.error instanceof Error ? ` — ${graphQuery.error.message}` : ''}.{' '}
            <button
              className="wf-retry"
              onClick={() => {
                void graphQuery.refetch();
                void surveys.refetch();
              }}
            >
              Try again
            </button>
          </p>
        )}

        {scope.siteId != null &&
          !graphQuery.isError &&
          !surveys.isError &&
          !graphQuery.isPending &&
          (graph?.edges.length ?? 0) === 0 && (
            <p className="empty-card">
              This site has no route map yet. Standpoints become nodes automatically — open{' '}
              <strong>Graph</strong> below and connect what walks to what.
            </p>
          )}

        {dest && !route && anchor && journey !== 'arrived' && (
          <p className="wf-hint">
            No mapped path from {atNode?.name ?? 'here'} to {dest.label}. Connect them in the graph
            editor.
          </p>
        )}

        {dest && !anchor && (
          <p className="wf-hint">
            Destination set — now scan any standpoint code (or pick a start) so the route has
            somewhere to begin.
          </p>
        )}

        {journey === 'arrived' && dest && (
          <ArrivedCard
            dest={dest}
            onOpenAr={() => goToTab('ar', dest.assetId ? { asset: dest.assetId } : {})}
            onDone={() => {
              setDest(null);
              setJourney('preview');
              setHint(null);
            }}
          />
        )}

        {journey !== 'arrived' && route && dest && journey === 'preview' && (
          <RoutePreview
            route={route}
            dest={dest}
            onGuide={() => {
              setJourney('guided');
              setStepIdx(0);
            }}
            onClear={() => setDest(null)}
          />
        )}

        {journey === 'guided' && route && dest && route.steps.length > 0 && (
          <GuidedCard
            route={route}
            // Clamped everywhere it is USED, not only where it is rendered: a
            // recomputed shorter route left onAdvance/onBack working from a
            // step index that no longer existed.
            stepIdx={Math.min(stepIdx, route.steps.length - 1)}
            onAdvance={() => {
              const current = Math.min(stepIdx, route.steps.length - 1);
              if (current + 1 >= route.steps.length) setJourney('arrived');
              else setStepIdx(current + 1);
            }}
            onBack={() => setStepIdx(Math.max(0, Math.min(stepIdx, route.steps.length - 1) - 1))}
            onScan={() => setScanOpen(true)}
            onExit={() => setJourney('preview')}
          />
        )}

        {/* Guided mode with no route to guide — the graph lost its path (an
            edge removed, a re-anchor onto an unconnected standpoint). Offer
            the two ways out rather than stranding the user in a blank mode. */}
        {journey === 'guided' && (!route || route.steps.length === 0) && dest && (
          <div className="wf-route">
            <p className="wf-hint" style={{ margin: 0 }}>
              No mapped path from {atNode?.name ?? 'here'} to {dest.label} right now.
            </p>
            <div className="wf-route-actions">
              <button className="btn-cta" onClick={() => setScanOpen(true)}>
                <Icon name="qr" size={18} /> Scan to re-anchor
              </button>
              <button className="btn-quiet" onClick={() => setJourney('preview')}>
                Exit guide
              </button>
            </div>
          </div>
        )}

        {journey !== 'guided' && (
          <>
            <div className="section-row">
              <span className="section-label">Open work orders</span>
            </div>
            {workOrders.isError && (
              <p className="empty-card wf-empty-error" role="alert">
                Couldn&apos;t load work orders
                {workOrders.error instanceof Error ? ` — ${workOrders.error.message}` : ''}.{' '}
                <button className="wf-retry" onClick={() => void workOrders.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {openWos.length === 0 && !workOrders.isLoading && !workOrders.isError && (
              <p className="empty-card">No open work orders with an asset to route to.</p>
            )}
            {openWos.slice(0, 12).map((wo: WorkOrder) => (
              <button
                key={wo.id}
                className={wo.resourceId === dest?.assetId ? 'row-card selected' : 'row-card'}
                onClick={() =>
                  destinationForAsset(
                    { id: wo.resourceId as number, name: wo.resourceName ?? `Asset ${wo.resourceId}` },
                    wo.id,
                  )
                }
              >
                <span className="sv-row-main">
                  <span className="row-card-title">{wo.subject}</span>
                  <span className="row-card-meta">
                    {wo.resourceName ?? `Asset ${wo.resourceId}`} · {wo.status ?? 'Open'}
                  </span>
                </span>
                <Icon name="chevron-right" size={18} className="wf-row-caret" />
              </button>
            ))}

            <div className="wf-foot-actions">
              <button className="btn-quiet" onClick={() => void navigateOutdoors()}>
                <Icon name="pin" size={18} /> Directions to site
              </button>
              <button className="btn-quiet" onClick={() => setMode('edit')}>
                <Icon name="route" size={18} /> Graph
              </button>
            </div>
          </>
        )}
      </div>

      <ScanCodeSheet
        open={scanOpen}
        help="Scan the QR at the standpoint you're standing at — position updates from wherever you scan, on or off the route."
        onClose={() => setScanOpen(false)}
        onCode={applyScan}
      />

      {/* Landmark authoring — the loop that lets the derived graph be taught.
          The overlay has been able to hold corrections since it was written and
          nothing ever wrote one, so every portfolio route was stuck with
          "Walk to X" forever. Whoever is standing in the corridor is the person
          who knows what you pass. */}
      <Sheet
        open={noteFor !== null}
        title="What do you pass?"
        onClose={() => {
          setNoteFor(null);
          setNoteError(null);
        }}
      >
        <p className="sv-help" style={{ marginTop: 0 }}>
          One line, phrased the way you would say it out loud — “past the red fire-hose cabinet,
          then left”. A landmark beats a distance: it also tells the next person they are still on
          the right path.
        </p>
        <input
          className="wf-assist-input wf-picker-q"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Past the red fire-hose cabinet, then left"
          aria-label="Landmark for this step"
          maxLength={140}
        />
        {noteError && (
          <p className="empty-card wf-empty-error" role="alert">
            {noteError}
          </p>
        )}
        <div className="wf-route-actions">
          <button className="btn-cta" onClick={() => void saveLandmark(noteText)} disabled={noteBusy}>
            {noteBusy ? 'Saving…' : 'Save landmark'}
          </button>
          {noteFor?.current && (
            <button
              className="btn-quiet"
              disabled={noteBusy}
              onClick={() => {
                // Empty text is how a note is removed — a wrong landmark has to
                // be as easy to take back as it was to write. Passed explicitly
                // rather than via state, which would not have updated yet.
                setNoteText('');
                void saveLandmark('');
              }}
            >
              Remove
            </button>
          )}
        </div>
      </Sheet>

      <Sheet open={siteOpen} title="Where are you working?" onClose={() => setSiteOpen(false)}>
        <LocationPicker />
      </Sheet>

      <Sheet open={startOpen} title="Start from" onClose={() => setStartOpen(false)}>
        <p className="sv-help" style={{ marginTop: 0 }}>
          A scan is always the surest start — this list is for planning ahead.
        </p>
        <div className="wf-picker-list">
          {startable.map((node) => (
            <button
              key={node.id}
              className="row-card"
              onClick={() => {
                setAnchor({ nodeId: node.id, via: 'pick', at: Date.now() });
                setStartOpen(false);
                setHint(null);
              }}
            >
              <span className="sv-row-main">
                <span className="row-card-title">{node.name}</span>
                <span className="row-card-meta">{node.kind}</span>
              </span>
            </button>
          ))}
          {startable.length === 0 && <p className="empty-card">No named starting points yet.</p>}
        </div>
      </Sheet>

      <Sheet
        open={pickerFor !== null}
        title={pickerFor === 'from' ? 'Start from' : 'Go to'}
        onClose={() => setPickerFor(null)}
      >
        <input
          className="wf-assist-input wf-picker-q"
          value={pickerQ}
          onChange={(e) => setPickerQ(e.target.value)}
          placeholder="Search sites, buildings, floors, spaces, assets"
          aria-label="Search the portfolio"
        />
        <div className="wf-picker-list">
          {pickerFor === 'from' && currentAutoNode && !pickerQ && (
            <button
              className="row-card"
              onClick={() => {
                setAutoFrom(null); // null means "follow the current location"
                setPickerFor(null);
              }}
            >
              <span className="sv-row-main">
                <span className="row-card-title">Current location</span>
                <span className="row-card-meta">{currentAutoNode.label}</span>
              </span>
            </button>
          )}
          {autoGraph &&
            (pickerQ ? findNode(autoGraph, pickerQ) : defaultPickList(autoGraph)).slice(0, 30).map((n) => (
              <button
                key={n.id}
                className="row-card"
                onClick={() => {
                  (pickerFor === 'from' ? setAutoFrom : setAutoTo)(n);
                  setPickerFor(null);
                }}
              >
                <span className="sv-row-main">
                  <span className="row-card-title">{n.label}</span>
                  <span className="row-card-meta">{n.kind}</span>
                </span>
              </button>
            ))}
          {/* An unbounded "Reading the portfolio…" was the only feedback for a
              failed estate read or a thrown graph build — the picker simply span
              forever with no way to retry. */}
          {!autoGraph && (autoGraphQuery.isError || estate.isError) && (
            <p className="empty-card wf-empty-error" role="alert">
              Couldn&apos;t read the portfolio
              {autoGraphQuery.error instanceof Error ? ` — ${autoGraphQuery.error.message}` : ''}.{' '}
              <button
                className="wf-retry"
                onClick={() => {
                  void estate.refetch();
                  void autoGraphQuery.refetch();
                }}
              >
                Try again
              </button>
            </p>
          )}
          {!autoGraph && !autoGraphQuery.isError && !estate.isError && (
            <p className="empty-card">Reading the portfolio…</p>
          )}
        </div>
      </Sheet>
    </section>
  );
}

/* ---------------- route cards ---------------- */

function StepRow({ step, index, state }: { step: RouteStep; index: number; state: 'done' | 'now' | 'todo' }) {
  const interstitial = isFloorChange(step);
  return (
    <li className={`wf-step ${state}${interstitial ? ' floor-change' : ''}`}>
      <span className="wf-step-n">{state === 'done' ? <Icon name="check" size={13} /> : index + 1}</span>
      <span className="wf-step-body">
        {interstitial && (
          <span className="wf-floor-badge">
            <Icon name={step.edge.kind === 'lift' ? 'grid' : 'chevron-down'} size={14} />
            {step.edge.kind === 'lift' ? 'Lift' : 'Stairs'}
            {step.to.floorLevel != null && ` → Level ${step.to.floorLevel}`}
          </span>
        )}
        <span className="wf-step-text">{step.text}</span>
        {step.meters != null && !interstitial && (
          <span className="wf-step-meta">{Math.round(step.meters)}m</span>
        )}
      </span>
    </li>
  );
}

function RoutePreview({
  route,
  dest,
  onGuide,
  onClear,
}: {
  route: Route;
  dest: Destination;
  onGuide(): void;
  onClear(): void;
}) {
  const seconds = estimateSeconds(route.steps);
  const phases = floorPhases(route.steps);
  return (
    <div className="wf-route">
      <div className="wf-route-head">
        <strong>{dest.label}</strong>
        <span className="wf-total">
          {route.totalMeters != null && `${Math.round(route.totalMeters)}m · `}
          {minutesText(seconds)}
          {phases.length > 1 && ` · ${phases.length} floors`}
        </span>
      </div>
      {/* Chunked per floor rather than one flat list. floorPhases has existed,
          tested, since the rebuild — the design is documented on it (working
          memory tops out around four segments, and a floor change is the
          highest-error moment indoors) but nothing ever rendered it. A single
          phase stays unlabelled, so a same-floor route reads exactly as before. */}
      {phases.length > 1 ? (
        phases.map((phase) => (
          <div className="wf-phase" key={`${phase.label ?? 'floor'}-${phase.startIndex}`}>
            {phase.label && (
              <p className="wf-phase-label">
                <Icon name="location" size={13} />
                {phase.label}
              </p>
            )}
            <ol className="wf-steps" start={phase.startIndex + 1}>
              {route.steps
                .slice(phase.startIndex, phase.startIndex + phase.count)
                .map((step, i) => (
                  <StepRow
                    key={step.edge.id + (phase.startIndex + i)}
                    step={step}
                    index={phase.startIndex + i}
                    state="todo"
                  />
                ))}
            </ol>
          </div>
        ))
      ) : (
        <ol className="wf-steps">
          {route.steps.map((step, i) => (
            <StepRow key={step.edge.id + i} step={step} index={i} state="todo" />
          ))}
        </ol>
      )}
      <p className="wf-last-leg">
        The last stretch isn't a step — at {route.destination.name}, the AR arrow points at{' '}
        {dest.label}.
      </p>
      <div className="wf-route-actions">
        <button className="btn-cta" onClick={onGuide}>
          Guide me
        </button>
        <button className="btn-quiet" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

function GuidedCard({
  route,
  stepIdx,
  onAdvance,
  onBack,
  onScan,
  onExit,
}: {
  route: Route;
  stepIdx: number;
  onAdvance(): void;
  onBack(): void;
  onScan(): void;
  onExit(): void;
}) {
  const step = route.steps[stepIdx];
  const next = route.steps[stepIdx + 1];
  /* Sampled at 400ms rather than every sensor event: this is a phrase and a
     wedge, not an AR overlay, and re-rendering the guided card at 60Hz to move a
     cone by a degree is battery spent for nothing. Hooks run before the early
     return below so their order never changes between renders. */
  const orientation = useHeading(400);
  const facing = useMemo(() => {
    if (!step || !canShowFacing(step.bearing, orientation)) return null;
    const relative = relativeBearing(step.bearing as number, orientation.heading);
    return { relative, phrase: turnPhrase(relative), accuracyDeg: orientation.accuracyDeg };
  }, [step, orientation]);
  if (!step) return null;
  return (
    <div className="wf-route wf-guided">
      <div className="wf-progress" aria-label={`Step ${stepIdx + 1} of ${route.steps.length}`}>
        <span className="wf-progress-text">
          Step {stepIdx + 1} of {route.steps.length}
        </span>
        <span className="wf-progress-bar">
          <span style={{ width: `${((stepIdx + 1) / route.steps.length) * 100}%` }} />
        </span>
      </div>

      <div className={isFloorChange(step) ? 'wf-now floor-change' : 'wf-now'}>
        {isFloorChange(step) && (
          <span className="wf-floor-badge big">
            <Icon name={step.edge.kind === 'lift' ? 'grid' : 'chevron-down'} size={16} />
            {step.edge.kind === 'lift' ? 'Take the lift' : 'Take the stairs'}
            {step.to.floorLevel != null && ` → Level ${step.to.floorLevel}`}
          </span>
        )}
        <p className="wf-now-text">{step.text}</p>
        <span className="wf-now-meta">
          {step.meters != null && <span className="wf-step-meta">{Math.round(step.meters)}m</span>}
          {/* Only where the step HAS a bearing and the compass is genuinely
              north-referenced — see canShowFacing. Most indoor edges have no
              bearing, and nothing is drawn for those rather than a guess. */}
          {facing && (
            <span className="wf-facing-wrap">
              <FacingCone relativeDeg={facing.relative} accuracyDeg={facing.accuracyDeg} />
              <span className="wf-facing-text">{facing.phrase}</span>
            </span>
          )}
        </span>
      </div>

      {next && (
        <p className="wf-next">
          <span className="wf-next-label">Then</span> {next.text}
        </p>
      )}
      {!next && (
        <p className="wf-next">
          <span className="wf-next-label">Then</span> you're there — the AR arrow takes over.
        </p>
      )}

      <div className="wf-route-actions">
        <button className="btn-cta" onClick={onAdvance}>
          {next ? "I'm here — next" : "I'm here — arrived"}
        </button>
        <button className="btn-quiet" onClick={onScan}>
          <Icon name="qr" size={18} /> Scan
        </button>
      </div>
      <div className="wf-route-actions secondary">
        {stepIdx > 0 && (
          <button className="link-btn" onClick={onBack}>
            ← Previous step
          </button>
        )}
        <button className="link-btn" onClick={onExit}>
          Exit guide
        </button>
      </div>
    </div>
  );
}

function ArrivedCard({
  dest,
  onOpenAr,
  onDone,
}: {
  dest: Destination;
  onOpenAr(): void;
  onDone(): void;
}) {
  return (
    <div className="wf-route wf-arrived-card" role="status">
      <span className="wf-arrived-badge">
        <Icon name="check" size={18} />
      </span>
      <strong className="wf-arrived-title">You've arrived</strong>
      <p className="wf-arrived-text">
        {dest.label} is at this standpoint. Open the camera and the AR arrow points straight at
        it{dest.workOrderId ? ' — the work order is one tap away there' : ''}.
      </p>
      <div className="wf-route-actions">
        <button className="btn-cta" onClick={onOpenAr}>
          <Icon name="camera" size={18} /> Open AR
        </button>
        <button className="btn-quiet" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ---------------- graph editor ---------------- */

/** Edges are the one thing nobody can derive — this makes drawing them cheap.
 * The instruction field is the research's single biggest quality lever:
 * landmark phrasing ("past the fire-hose cabinet") beats generated distance
 * text on wrong turns and confidence, and only a human can author it. */
function GraphEditor({
  graph,
  onBack,
  onSaved,
}: {
  graph: WayGraph;
  onBack(): void;
  onSaved(): void;
}) {
  const [working, setWorking] = useState<WayGraph>(graph);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<EdgeKind>('walk');
  const [meters, setMeters] = useState('');
  const [instruction, setInstruction] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [nodeKind, setNodeKind] = useState<NodeKind>('entrance');
  const [busy, setBusy] = useState(false);

  const options = working.nodes.map((n) => ({ value: n.id, label: `${n.name} (${n.kind})` }));

  const persist = async (next: WayGraph) => {
    setWorking(next);
    setBusy(true);
    try {
      // Only hand-made nodes are stored; survey nodes are re-derived on load.
      await saveGraph({ ...next, nodes: next.nodes.filter((n) => !n.surveyId) });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const addNode = () => {
    if (!nodeName.trim()) return;
    const node: WayNode = {
      id: `n-${Date.now().toString(36)}`,
      kind: nodeKind,
      name: nodeName.trim(),
    };
    void persist({ ...working, nodes: [...working.nodes, node] });
    setNodeName('');
  };

  const addEdge = () => {
    if (!from || !to || from === to) return;
    void persist({
      ...working,
      edges: [
        ...working.edges,
        {
          id: `e-${Date.now().toString(36)}`,
          from,
          to,
          kind,
          meters: meters.trim() ? Number(meters) : undefined,
          instruction: instruction.trim() || undefined,
        },
      ],
    });
    setMeters('');
    setInstruction('');
  };

  const nameOf = (id: string) => working.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <section className="screen wf-screen">
      <header className="wf-head">
        <div className="sv-head-row">
          <button className="link-btn" onClick={onBack}>
            ← Back
          </button>
          <span className="sv-org">{working.nodes.length} nodes · {working.edges.length} edges</span>
        </div>
      </header>

      <div className="wf-body scroll-y">
        <p className="sv-help" style={{ marginTop: 0 }}>
          Every survey standpoint is already a node. Add entrances and lifts, then connect what
          physically walks to what — that's the only thing the app can't work out for itself.
        </p>

        <div className="section-row">
          <span className="section-label">Add a node</span>
        </div>
        <div className="wf-form">
          <label className="sv-field">
            <span className="sv-field-label">Name</span>
            <input
              className="sv-input"
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              placeholder="South Entrance"
            />
          </label>
          <DsSelect
            label="Kind"
            value={nodeKind}
            options={[
              { value: 'entrance', label: 'Entrance' },
              { value: 'lift', label: 'Lift' },
              { value: 'stairs', label: 'Stairs' },
              { value: 'junction', label: 'Junction' },
            ]}
            onChange={(v) => setNodeKind(v as NodeKind)}
          />
          <button className="btn-quiet" disabled={busy || !nodeName.trim()} onClick={addNode}>
            Add node
          </button>
        </div>

        <div className="section-row">
          <span className="section-label">Connect two nodes</span>
        </div>
        <div className="wf-form">
          <DsSelect label="From" value={from} options={options} onChange={setFrom} />
          <DsSelect label="To" value={to} options={options} onChange={setTo} />
          <DsSelect
            label="How"
            value={kind}
            options={[
              { value: 'walk', label: 'Walk' },
              { value: 'door', label: 'Through a door' },
              { value: 'lift', label: 'Lift' },
              { value: 'stairs', label: 'Stairs' },
            ]}
            onChange={(v) => setKind(v as EdgeKind)}
          />
          <label className="sv-field">
            <span className="sv-field-label">Metres (optional)</span>
            <input
              className="sv-input"
              inputMode="numeric"
              value={meters}
              onChange={(e) => setMeters(e.target.value)}
              placeholder="40"
            />
          </label>
          <label className="sv-field">
            <span className="sv-field-label">Landmark instruction (optional — the thing people follow)</span>
            <input
              className="sv-input"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Past the red fire-hose cabinet, then left"
            />
          </label>
          <button className="btn-cta" disabled={busy || !from || !to || from === to} onClick={addEdge}>
            Connect
          </button>
        </div>

        <div className="section-row">
          <span className="section-label">Connections ({working.edges.length})</span>
        </div>
        {working.edges.length === 0 && (
          <p className="empty-card">No connections yet — a route needs at least one.</p>
        )}
        {working.edges.map((e) => (
          <div key={e.id} className="row-card wf-edge-row">
            <span className="sv-row-main">
              <span className="row-card-title">
                {nameOf(e.from)} → {nameOf(e.to)}
              </span>
              <span className="row-card-meta">
                {e.kind}
                {e.meters != null ? ` · ${e.meters}m` : ''}
                {e.instruction ? ` · “${e.instruction}”` : ''}
              </span>
            </span>
            <button
              className="link-btn"
              onClick={() =>
                void persist({ ...working, edges: working.edges.filter((x) => x.id !== e.id) })
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
