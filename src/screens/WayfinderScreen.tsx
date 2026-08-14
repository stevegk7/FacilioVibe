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
import { useLocationScope } from '../state/LocationContext';
import { useGeoFix } from '../hooks/useGeoFix';
import { useVoice } from '../voice/useVoice';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import DsSelect from '../components/DsSelect';
import LocationPicker from '../components/LocationPicker';
import ScanCodeSheet from '../components/ScanCodeSheet';
import { loadGraph, nodeForCode, nodeForSurvey, saveGraph, withSurveyNodes, nodeById } from '../wayfinding/graph';
import type { EdgeKind, NodeKind, WayGraph, WayNode } from '../wayfinding/graph';
import { findRoute, nearestNode } from '../wayfinding/router';
import type { Route, RouteStep } from '../wayfinding/router';
import { mapsDirectionsUrl } from '../wayfinding/legs';
import { surveyForAsset, surveyForPlace } from '../wayfinding/resolve';
import {
  anchorAgeText,
  anchorIsStale,
  estimateSeconds,
  isFloorChange,
  minutesText,
  type Anchor,
  type Destination,
  type JourneyPhase,
} from '../wayfinding/journey';
import { onNavigate, navParamId, setNavParams, goToTab } from '../shell/router';
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

function useGraph(siteId: number | undefined, surveys: Survey[]) {
  return useQuery({
    queryKey: ['wf-graph', siteId ?? 0, surveys.length],
    queryFn: async () => withSurveyNodes(await loadGraph(siteId ?? 0), surveys),
    enabled: siteId !== undefined,
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
  const [assistReply, setAssistReply] = useState<string | null>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [candidates, setCandidates] = useState<Asset[]>([]);
  const spokeRef = useRef(false);

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

  const graphQuery = useGraph(scope.siteId, surveys.data ?? []);
  const graph = graphQuery.data;

  // Open work orders are the reason anyone opens this screen.
  const workOrders = useQuery({
    queryKey: ['wf-workorders'],
    queryFn: () => provider.listWorkOrders({ pageSize: 50 }).then((p) => p.data),
  });

  /** Asset → its standpoint node, or null with an honest hint. */
  const destinationForAsset = useCallback(
    (asset: { id: number; name: string }, workOrderId?: number): boolean => {
      if (!graph) return false;
      const host = surveyForAsset(surveys.data ?? [], asset.id);
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
    [graph, surveys.data],
  );

  // Handoffs land as ?asset= — react while MOUNTED, not only at mount (the
  // pre-merge screen read it once in a useState initialiser, so pushing a new
  // asset at an open Wayfinder did nothing — the exact bug router.ts names).
  const consumeAssetParam = useCallback(() => {
    const assetId = navParamId('asset');
    if (assetId == null || !graph) return;
    if (dest?.assetId === assetId) return;
    void provider.getAsset(assetId).then((asset) => {
      if (asset) destinationForAsset(asset);
      setNavParams({ asset: null }); // consumed — a stale param must not re-fire
    });
  }, [graph, dest, destinationForAsset]);

  useEffect(() => {
    consumeAssetParam();
    return onNavigate(consumeAssetParam);
  }, [consumeAssetParam]);

  // With no scan yet, GPS picks the nearest entrance — labelled as the guess
  // it is, never dressed up as a scan.
  useEffect(() => {
    if (anchor || !graph) return;
    const fix = getFix();
    if (!fix) return;
    const near = nearestNode(graph, fix, ['entrance']) ?? nearestNode(graph, fix);
    if (near) setAnchor({ nodeId: near.id, via: 'gps', at: Date.now() });
  }, [graph, anchor, getFix]);

  useEffect(() => storeAnchor(anchor), [anchor]);

  const route: Route | null = useMemo(() => {
    if (!graph || !dest || !anchor) return null;
    return findRoute(graph, anchor.nodeId, dest.nodeId);
  }, [graph, dest, anchor]);

  // Arrival is a state, not an inference: route says "zero steps left".
  useEffect(() => {
    if (route && route.steps.length === 0 && dest) setJourney('arrived');
  }, [route, dest]);

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
    void stampStopByCode(code).catch(() => undefined);
    setAnchor({ nodeId: node.id, via: 'scan', at: Date.now() });
    if (dest && node.id === dest.nodeId) {
      setJourney('arrived');
      setHint(null);
      return;
    }
    if (dest) {
      // The route recomputes from the scanned node, so its first remaining
      // step is index 0 — guided progress snaps there, on or off the old path.
      if (journey === 'guided') setStepIdx(0);
      setHint(`Route updated from ${node.name}`);
    } else {
      setHint(`You are at ${node.name}`);
    }
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
    setAssistReply(null);
    setCandidates([]);
    try {
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
      // Lane 2: language → the same tool loop Effi runs, with deps that set
      // the route here instead of describing it or switching tabs.
      const result = await runToolLoop(query, { siteId: scope.siteId }, assistDeps);
      setAssistReply(result.answer);
    } catch (err) {
      setAssistReply(err instanceof Error ? err.message : 'Something went wrong — try again.');
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
        {assistBusy && <p className="wf-hint">Thinking…</p>}
        {assistReply && !assistBusy && <p className="wf-hint">{assistReply}</p>}
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

        {scope.siteId == null && (
          <p className="empty-card">Pick a site above to plan a route.</p>
        )}

        {scope.siteId != null && (graph?.edges.length ?? 0) === 0 && (
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

        {journey === 'guided' && route && dest && (
          <GuidedCard
            route={route}
            stepIdx={Math.min(stepIdx, route.steps.length - 1)}
            onAdvance={() => {
              if (stepIdx + 1 >= route.steps.length) setJourney('arrived');
              else setStepIdx(stepIdx + 1);
            }}
            onBack={() => setStepIdx(Math.max(0, stepIdx - 1))}
            onScan={() => setScanOpen(true)}
            onExit={() => setJourney('preview')}
          />
        )}

        {journey !== 'guided' && (
          <>
            <div className="section-row">
              <span className="section-label">Open work orders</span>
            </div>
            {openWos.length === 0 && !workOrders.isLoading && (
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
  return (
    <div className="wf-route">
      <div className="wf-route-head">
        <strong>{dest.label}</strong>
        <span className="wf-total">
          {route.totalMeters != null && `${Math.round(route.totalMeters)}m · `}
          {minutesText(seconds)}
        </span>
      </div>
      <ol className="wf-steps">
        {route.steps.map((step, i) => (
          <StepRow key={step.edge.id + i} step={step} index={i} state="todo" />
        ))}
      </ol>
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
        {step.meters != null && <span className="wf-step-meta">{Math.round(step.meters)}m</span>}
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
