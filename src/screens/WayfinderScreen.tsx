/**
 * Wayfinder — Work Order → Asset → Location → route.
 *
 * Positioning is discrete BY DESIGN: there is no continuous indoor pose, so
 * you are where you last scanned. That is honest about the hardware and it is
 * why every step has a "scan to confirm" affordance rather than a moving dot.
 *
 * The last leg is deliberately NOT a route step. Marker bearings are rays with
 * no range, so once you reach the destination standpoint the AR arrow takes
 * over — the route can get you to the room, the arrow points at the thing.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appStore } from '../api/appStore';
import { provider } from '../api/provider';
import { useLocationScope } from '../state/LocationContext';
import { useGeoFix } from '../hooks/useGeoFix';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import DsSelect from '../components/DsSelect';
import { loadGraph, nodeForCode, nodeForSurvey, saveGraph, withSurveyNodes } from '../wayfinding/graph';
import type { EdgeKind, NodeKind, WayGraph, WayNode } from '../wayfinding/graph';
import { findRoute, nearestNode } from '../wayfinding/router';
import { mapsDirectionsUrl } from '../wayfinding/legs';
import type { Asset, SiteGeo, Survey, WorkOrder } from '../api/types';
import './wayfinder.css';

type Mode = 'route' | 'edit';

function useGraph(siteId: number | undefined, surveys: Survey[]) {
  return useQuery({
    queryKey: ['wf-graph', siteId ?? 0, surveys.length],
    queryFn: async () => withSurveyNodes(await loadGraph(siteId ?? 0), surveys),
    enabled: siteId !== undefined,
  });
}

export default function WayfinderScreen() {
  const { scope, names } = useLocationScope();
  const getFix = useGeoFix(true);
  const [mode, setMode] = useState<Mode>('route');
  const [destAssetId, setDestAssetId] = useState<number | null>(() => {
    // Arriving from a work order's "Navigate to asset".
    const asked = new URLSearchParams(window.location.search).get('asset');
    return asked ? Number(asked) : null;
  });
  const [atNodeId, setAtNodeId] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanText, setScanText] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

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

  const destination = useMemo(() => {
    if (!graph || destAssetId == null) return null;
    const host = (surveys.data ?? []).find((s) =>
      s.markers.some((m) => m.assetId === destAssetId),
    );
    if (!host) return null;
    return nodeForSurvey(graph, host.id) ?? null;
  }, [graph, destAssetId, surveys.data]);

  const route = useMemo(() => {
    if (!graph || !destination || !atNodeId) return null;
    return findRoute(graph, atNodeId, destination.id);
  }, [graph, destination, atNodeId]);

  // With no scan yet, GPS picks the entrance you are nearest to.
  useEffect(() => {
    if (atNodeId || !graph) return;
    const fix = getFix();
    if (!fix) return;
    const near = nearestNode(graph, fix, ['entrance']) ?? nearestNode(graph, fix);
    if (near) setAtNodeId(near.id);
  }, [graph, atNodeId, getFix]);

  const confirmScan = () => {
    if (!graph) return;
    const node = nodeForCode(graph, scanText);
    if (!node) {
      setHint(`No node carries the code "${scanText.trim()}"`);
      return;
    }
    setAtNodeId(node.id);
    setScanText('');
    setScanOpen(false);
    setHint(`You are at ${node.name}`);
  };

  const navigateOutdoors = async () => {
    if (scope.siteId == null) return;
    const geo = await appStore.kvGet<SiteGeo>('settings', `sitegeo.${scope.siteId}`);
    if (!geo) {
      setHint('No coordinates for this site — add them in Settings');
      return;
    }
    window.open(mapsDirectionsUrl(geo.lat, geo.lng), '_blank', 'noopener');
  };

  if (mode === 'edit' && graph) {
    return <GraphEditor graph={graph} onBack={() => setMode('route')} onSaved={() => graphQuery.refetch()} />;
  }

  const atNode = graph && atNodeId ? graph.nodes.find((n) => n.id === atNodeId) : undefined;

  return (
    <section className="screen wf-screen">
      <header className="wf-head">
        <div className="sv-head-row">
          <span className="sv-title-wrap">
            <h2 className="sv-h1">Wayfinder</h2>
            <span className="sv-org">{names.site ?? 'All sites'}</span>
          </span>
          <button className="btn-quiet wf-edit-btn" onClick={() => setMode('edit')}>
            <Icon name="route" size={18} /> Graph
          </button>
        </div>

        <div className="wf-where">
          <span className="wf-where-label">You are at</span>
          <button className="wf-where-btn" onClick={() => setScanOpen(true)}>
            {atNode ? atNode.name : 'Not set — scan a code'}
            <Icon name="qr" size={18} />
          </button>
        </div>
      </header>

      <div className="wf-body scroll-y">
        {hint && <p className="wf-hint">{hint}</p>}

        {scope.siteId == null && (
          <p className="empty-card">Pick a site on the Surveys screen to plan a route.</p>
        )}

        {scope.siteId != null && (graph?.edges.length ?? 0) === 0 && (
          <p className="empty-card">
            This site has no route map yet. Standpoints become nodes automatically — open{' '}
            <strong>Graph</strong> and connect them so the app knows what walks to what.
          </p>
        )}

        <div className="section-row">
          <span className="section-label">Where to</span>
          <button className="link-btn" onClick={() => setPickOpen(true)}>
            Choose asset
          </button>
        </div>

        {destAssetId == null && (
          <p className="empty-card">
            Pick a work order below, or choose an asset, and the route starts from wherever you
            last scanned.
          </p>
        )}

        {destAssetId != null && !destination && (
          <p className="wf-hint">
            That asset isn't pinned in any survey yet, so there's nothing to route to. Place a
            marker on it from the AR tab first.
          </p>
        )}

        {route && (
          <div className="wf-route">
            <div className="wf-route-head">
              <strong>{destination?.name}</strong>
              {route.totalMeters != null && (
                <span className="wf-total">{Math.round(route.totalMeters)}m</span>
              )}
            </div>
            {route.steps.length === 0 ? (
              <p className="wf-arrived">
                You're already there — open the AR tab and the arrow points at the asset.
              </p>
            ) : (
              <ol className="wf-steps">
                {route.steps.map((step, i) => (
                  <li key={step.edge.id + i} className="wf-step">
                    <span className="wf-step-n">{i + 1}</span>
                    <span className="wf-step-text">{step.text}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="wf-last-leg">
              The last stretch isn't a step — scan the code at {destination?.name} and the AR
              arrow takes over.
            </p>
          </div>
        )}

        {destAssetId != null && destination && !route && atNodeId && (
          <p className="wf-hint">
            No mapped path from {atNode?.name} to {destination.name}. Connect them in{' '}
            <strong>Graph</strong>.
          </p>
        )}

        <div className="section-row">
          <span className="section-label">Open work orders</span>
        </div>
        {(workOrders.data ?? [])
          .filter((w) => w.resourceId)
          .slice(0, 12)
          .map((wo: WorkOrder) => (
            <button
              key={wo.id}
              className={wo.resourceId === destAssetId ? 'row-card selected' : 'row-card'}
              onClick={() => setDestAssetId(wo.resourceId ?? null)}
            >
              <span className="sv-row-main">
                <span className="row-card-title">{wo.subject}</span>
                <span className="row-card-meta">
                  {wo.resourceName ?? `Asset ${wo.resourceId}`} · {wo.status ?? 'Open'}
                </span>
              </span>
              <Icon name="chevron-left" size={18} className="wf-row-caret" />
            </button>
          ))}

        <button className="btn-quiet wf-outdoor" onClick={() => void navigateOutdoors()}>
          <Icon name="pin" size={18} /> Directions to site
        </button>
      </div>

      <Sheet
        open={scanOpen}
        title="Where are you?"
        onClose={() => setScanOpen(false)}
        footer={
          <button className="btn-cta" onClick={confirmScan}>
            Set position
          </button>
        }
      >
        <p className="sv-help" style={{ marginTop: 0 }}>
          Scan or type the code at the standpoint you're standing at. There's no continuous
          indoor position — you are where you last scanned.
        </p>
        <label className="sv-field">
          <span className="sv-field-label">Code</span>
          <input
            className="sv-input"
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            placeholder="e.g. fv-sv-abc123"
          />
        </label>
      </Sheet>

      <AssetPicker
        open={pickOpen}
        onClose={() => setPickOpen(false)}
        onPick={(a) => {
          setDestAssetId(a.id);
          setPickOpen(false);
        }}
      />
    </section>
  );
}

function AssetPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose(): void;
  onPick(asset: Asset): void;
}) {
  const { scope } = useLocationScope();
  const [text, setText] = useState('');
  const assets = useQuery({
    queryKey: ['wf-assets', scope.siteId ?? 0, text],
    queryFn: () => provider.searchAssets({ text, scope }),
    enabled: open,
  });

  return (
    <Sheet open={open} title="Choose asset" onClose={onClose} size="tall">
      <label className="sv-field">
        <span className="sv-field-label">Search</span>
        <input
          className="sv-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Asset name"
        />
      </label>
      <div className="wf-picker-list">
        {(assets.data ?? []).slice(0, 40).map((a) => (
          <button key={a.id} className="row-card" onClick={() => onPick(a)}>
            <span className="sv-row-main">
              <span className="row-card-title">{a.name}</span>
              <span className="row-card-meta">{a.spaceName ?? a.category ?? `#${a.id}`}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** Edges are the one thing nobody can derive — this makes drawing them cheap. */
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
        },
      ],
    });
    setMeters('');
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
