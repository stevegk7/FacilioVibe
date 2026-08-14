/**
 * The 3D estate — ported from Estate Navigator's App.jsx.
 *
 * Markup, spacing and interaction are the v5 design handoff as authored. Five
 * things changed in the port, each for a reason:
 *
 *  1. No auth block and no Splash. AuthGate owns sign-in, including the embedded
 *     no-redirect rule that a bare vibe.login() breaks inside a Facilio iframe.
 *  2. No 52px header. Its logo, avatar and back chip duplicate AppShell's topbar;
 *     search and the sample-health toggle moved into the floating toolbar so
 *     there is one bar in the app, not two stacked.
 *  3. `const C` is gone. 16 of its 23 colours were byte-identical to existing
 *     design tokens and now reference them; the three genuine strays became
 *     tokens of their own. The engine reads the same values back through
 *     setPalette(), so the scene and the panels cannot drift.
 *  4. The engine's lifetime moved out of this component (estateHost.ts). The
 *     canvas outlives the React tree, so a trip to the AR tab and back does not
 *     rebuild the scene — or leak a WebGL context per visit.
 *  5. A list fallback. `new EstateEngine()` throws when WebGL is blocked, and
 *     without a fallback that would leave the app with no way to browse assets
 *     at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEstate } from '../estate/useEstate';
import { buildEstate } from '../estate/buildEstate';
import { acquire, release, destroy } from '../estate/estateHost';
import { planFindOnSite, type FindOnSitePlan } from '../estate/findOnSite';
import { importPlanFile, PlanExtractError } from '../estate/planImport';
import { savePlanForFloor } from '../estate/planStore';
import { goToTab, navParamId, onNavigate, setNavParams } from '../shell/router';
import { useLocationScope } from '../state/LocationContext';
import { openRecordSummary, isEmbeddedInFacilio } from '../api/nav';
import { fillLink, loadLinks, EMPTY_LINKS, type LinkTemplates } from '../api/links';
import PortfolioScreen from './PortfolioScreen';
import { searchEstate, type EstateSearchHit, type SearchableEstate } from '../estate/searchEstate';
import type {
  EngineNav,
  EngineSelection,
  EngineTag,
  EstateBuilding,
  EstateData,
  EstateEngineApi,
  EstateFloor,
  EstateMarker,
  EstateSpace,
} from '../estate/types';
import '../estate/estate.css';

/* ---------- design tokens, used as values ---------- */
const C = {
  ink: 'var(--ink-900)',
  sub: 'var(--ink-600)',
  mute: 'var(--ink-500)',
  faint: 'var(--ink-400)',
  line: 'var(--ink-200)',
  hair: 'var(--ink-100)',
  white: 'var(--white)',
  blue: 'var(--blue-500)',
  blueDk: 'var(--blue-600)',
  blueBg: 'var(--blue-025)',
  blueBd: 'var(--blue-100)',
  red: 'var(--danger-500)',
  redBg: 'var(--danger-050)',
  redBd: 'var(--danger-050)',
  amber: 'var(--warning-600)',
  amberBg: 'var(--warning-050)',
  amberFg: 'var(--warning-700)',
  yellow: 'var(--warning-500)',
  green: 'var(--success-500)',
  greenBg: 'var(--success-050)',
  greenFg: 'var(--success-700)',
} as const;

const ICON_ASSET = 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z';
const ICON_SPACE = 'M4 21V6l7-3 7 3v15M9 21v-5h4v5M2 21h20';

const dash = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

function fmt(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function age(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const days = Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
  return days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
}

/**
 * Read the status ramp back out of CSS so the 3D scene is painted from the same
 * tokens as everything around it. Falls back to the engine's own defaults if a
 * token is missing rather than blanking a colour.
 */
function paletteFromTokens(): Record<string, number> {
  const css = getComputedStyle(document.documentElement);
  const hex = (name: string): number | undefined => {
    const raw = css.getPropertyValue(name).trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(raw)) return undefined;
    return parseInt(raw, 16);
  };
  const out: Record<string, number> = {};
  const map: Record<string, string> = {
    critical: '--danger-500',
    warning: '--warning-600',
    primary: '--blue-500',
    closed: '--estate-inactive',
    marker: '--blue-400',
    // Scene backdrop + ground. Slightly deeper than the old hardcoded flat
    // grey so the white panels and pins actually stand off the canvas.
    sceneBg: '--estate-scene',
    ground: '--estate-ground',
  };
  for (const [key, token] of Object.entries(map)) {
    const v = hex(token);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export default function EstateScreen() {
  const estate = useEstate();
  const { scope, setLocation } = useLocationScope();

  const slotRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<EstateEngineApi | null>(null);

  const [nav, setNav] = useState<EngineNav>({ level: 0, buildingId: null, floorId: null });
  const [selected, setSelected] = useState<EngineSelection | null>(null);
  const [spaceTags, setSpaceTags] = useState<EngineTag[]>([]);
  const [tab, setTab] = useState<'details' | 'work' | 'insp'>('details');
  const [search, setSearch] = useState('');
  const [sampleHealth, setSampleHealth] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [plan, setPlan] = useState<FindOnSitePlan | null>(null);
  const [links, setLinks] = useState<LinkTemplates>(EMPTY_LINKS);
  const [planMode, setPlanMode] = useState<'drawing' | 'solid'>('drawing');
  const [camMode, setCamMode] = useState<'orbit' | 'walk'>('orbit');
  const [importState, setImportState] = useState<
    { kind: 'idle' } | { kind: 'busy'; label: string } | { kind: 'error'; message: string } | { kind: 'done'; message: string }
  >({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Read by the acquire callback, which must not re-run when the mode changes.
  const planModeRef = useRef<'drawing' | 'solid'>('drawing');
  planModeRef.current = planMode;
  // Set by an import; consumed once by the next engine build.
  const restoreFloorRef = useRef<{ buildingId: string; floorId: number } | null>(null);

  useEffect(() => {
    loadLinks().then(setLinks).catch(() => setLinks(EMPTY_LINKS));
  }, []);

  /**
   * "Open in Facilio", region-safe.
   *
   * Estate Navigator hardcoded https://app.facilio.com/... — US-only, and wrong
   * for any other region. The app already solved this twice: the connected-app
   * bridge lets the HOST own its routes when embedded, and an admin-set link
   * template covers the standalone case. When neither is available the button is
   * hidden, per links.ts's own rule that a wrong link is worse than none.
   */
  const canOpenAsset = isEmbeddedInFacilio() || !!fillLink(links.asset, 1);
  async function openAsset(id: number) {
    if (await openRecordSummary('asset', id)) return;
    const url = fillLink(links.asset, id);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  const data: EstateData | null = useMemo(
    () => (estate.data ? buildEstate(estate.data, { sampleHealth }) : null),
    [estate.data, sampleHealth],
  );

  /* The engine's own setSearch only dims pins on a floor that is already open —
     typing at estate level looked broken. This answers "where is it?" instead:
     a ranked dropdown, and picking a hit flies there. */
  const searchHits = useMemo(
    () => searchEstate(data as unknown as SearchableEstate | null, search),
    [data, search],
  );
  const pickHit = (h: EstateSearchHit) => {
    const eng = engineRef.current;
    if (!eng) return;
    if (h.kind === 'asset') eng.flyToMarker(Number(h.recordId));
    // The select() patch recovers when the space's floor isn't open, so one
    // call is enough from any level.
    else if (h.kind === 'space') eng.select(Number(h.recordId), 'space');
    else eng.enterBuilding(String(h.recordId));
    setSearch('');
  };

  /* ---------- engine callbacks, behind a stable identity ----------
     The engine is constructed once and outlives these renders, so it must not
     capture a render's closures. The ref indirection keeps the object it holds
     identical forever while the functions inside stay current. */
  const handlers = useRef({
    onLevel: (n: EngineNav) => {
      setNav(n);
      if (n.level !== 2) setSelected(null);
    },
    onSelect: (sel: EngineSelection | null) => {
      setSelected(sel);
      setTab('details');
      setPlan(null);
      const engine = engineRef.current;
      if (!engine) return;
      if (sel?.kind === 'asset' && sel.m) engine.focusAsset(sel.m.recordId);
      else if (sel?.kind === 'space' && sel.space) engine.focusSpace(sel.space.recordId);
      else engine.clearFocus();
    },
    onTags: (_tags: EngineTag[], sTags: EngineTag[]) => setSpaceTags(sTags ?? []),
    // The engine leaves walk on its own for several reasons (Back, a level
    // change, dropping to Drawing), so the button follows the engine rather than
    // the other way round.
    onCameraMode: (mode: 'orbit' | 'walk') => setCamMode(mode),
  });
  const callbacks = useRef({
    onLevel: (n: EngineNav) => handlers.current.onLevel(n),
    onSelect: (s: EngineSelection | null) => handlers.current.onSelect(s),
    onTags: (t: EngineTag[], s: EngineTag[]) => handlers.current.onTags(t, s),
    onCameraMode: (m: 'orbit' | 'walk') => handlers.current.onCameraMode(m),
  }).current;

  /* ---------- mount / park the shared canvas ---------- */
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || !data) return;
    let alive = true;

    acquire(slot, data, callbacks)
      .then((engine) => {
        // dispose() clears its own timers, but a flight resolved between acquire
        // and unmount would still call setState on a dead component.
        if (!alive) return;
        engineRef.current = engine;
        setEngineError(null);
        engine.setPalette(paletteFromTokens());
        // A rebuilt engine starts in 'drawing'; re-apply the user's choice or the
        // toggle would say 3D while the walls sat flat.
        engine.setPlanMode(planModeRef.current);
        engine.setScope({ canSeeFloor: () => true, canSeeMarker: () => true, showSpaces: true });
        engine.setSearch(search);
        setNav(engine.getState());
        // An import rebuilt the estate under us; go back to the floor it was for.
        const restore = restoreFloorRef.current;
        restoreFloorRef.current = null;
        if (restore) engine.flyToFloor(restore.buildingId, restore.floorId);
        // Apply a pending ?asset= HERE, not only from the deep-link effect.
        // acquire() is async (it lazy-loads three and four scripts), so on a
        // cold open that effect runs while engineRef is still null and the
        // handoff would silently land on the estate view instead of the asset.
        flyToParamRef.current();
      })
      .catch((err: Error) => {
        if (!alive) return;
        engineRef.current = null;
        setEngineError(err?.message ?? String(err));
      });

    return () => {
      alive = false;
      release();
    };
    // `search` is applied imperatively below; re-acquiring on every keystroke
    // would defeat the whole point of the persistent canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, callbacks]);

  // The estate's records changed under us (a refetch, or sign-out). The scene is
  // built from the old ones, so it has to go rather than be re-parked.
  useEffect(() => () => { if (!estate.data) destroy(); }, [estate.data]);

  useEffect(() => {
    engineRef.current?.setSearch(search);
  }, [search]);

  /* ---------- deep link: ?asset= flies the camera ----------
     Both a mount read AND a popstate listener are needed. A tab switch remounts
     the screen, but firing goToTab('estate', {asset}) while already here does
     not — which is exactly the bug the pre-merge Wayfinder had. */
  // Held in a ref so the acquire() callback can call the CURRENT version without
  // taking flyToParam as an effect dependency (which would re-acquire the engine).
  const flyToParamRef = useRef<() => void>(() => {});
  const flyToParam = useCallback(() => {
    const asked = navParamId('asset');
    const engine = engineRef.current;
    if (!asked || !engine) return;
    if (!engine.locate(asked)) {
      // An asset can exist in Facilio and not in the model: its space pointer
      // resolved to nothing, or it is a retired record. flyToMarker would just
      // silently do nothing, so say what happened instead.
      setPlan(null);
      setEngineError(null);
      setNotPlaced(asked);
      return;
    }
    setNotPlaced(null);
    engine.flyToMarker(asked);
  }, []);
  const [notPlaced, setNotPlaced] = useState<number | null>(null);

  flyToParamRef.current = flyToParam;

  useEffect(() => {
    flyToParam();
    return onNavigate(flyToParam);
  }, [flyToParam, data]);

  /* ---------- scope sync: engine -> LocationContext ----------
     LocationContext is the source of truth (AR, Wayfinder, Surveys and the voice
     context all read it); the engine's nav is camera state that happens to
     correlate. Drilling into Tower A in 3D should scope the rest of the app to
     Tower A — but the engine's building id is a STRING and LocationScope's is a
     number, so every crossing is coerced or the comparison silently never matches. */
  useEffect(() => {
    if (!data) return;
    const b = data.buildings.find((x) => x.id === nav.buildingId);
    const f = b?.floors.find((x) => x.recordId === nav.floorId);

    const next = {
      // Level 0 KEEPS the current site: zooming out in 3D must not silently
      // unscope the AR tab.
      siteId: b?.siteId ?? scope.siteId,
      buildingId: b?.recordId,
      floorId: f?.recordId,
    };
    if (
      next.siteId === scope.siteId &&
      next.buildingId === scope.buildingId &&
      next.floorId === scope.floorId
    ) {
      return;
    }
    setLocation({
      scope: next,
      names: { site: b?.siteName, building: b?.name, floor: f?.tenantName ?? f?.name },
    });
    // scope/setLocation are intentionally out of the dep list: this effect writes
    // them, and reacting to its own write is the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, data]);

  useEffect(() => {
    setNavParams({ view: undefined });
  }, []);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      engineRef.current?.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- gates ---------- */
  if (estate.isLoading) {
    return (
      <section className="screen est-gate" aria-busy="true">
        <div className="est-loading" role="status">
          <div className="est-loading-stack" aria-hidden="true">
            <span /><span /><span />
          </div>
          <strong className="est-loading-title">Reading your estate from Facilio</strong>
          <span className="est-loading-sub">Sites · buildings · floors · spaces · assets</span>
          <div className="est-loading-bar" aria-hidden="true"><span /></div>
        </div>
      </section>
    );
  }
  if (estate.isError) {
    return (
      <section className="screen est-gate">
        <div className="est-loading" role="alert">
          <div className="est-loading-stack est-loading-stack--still" aria-hidden="true">
            <span /><span /><span />
          </div>
          <strong className="est-loading-title">The estate didn’t load</strong>
          <span className="est-loading-sub">{(estate.error as Error)?.message ?? 'Could not load the estate.'}</span>
        </div>
      </section>
    );
  }
  if (engineError) {
    // WebGL is blocked (remote desktop, an old webview, hardware acceleration
    // off). Falling back to the asset list keeps the app usable instead of
    // showing a dead canvas.
    return (
      <section className="screen">
        <div className="empty-card" role="status">
          <strong>The 3D view can’t start on this device.</strong>
          <p className="muted small">{engineError}</p>
          <p className="muted small">Showing the asset list instead.</p>
        </div>
        <PortfolioScreen />
      </section>
    );
  }

  const buildings: EstateBuilding[] = data?.buildings ?? [];
  const estateCounts = data?.counts ?? { buildings: 0, floors: 0, spaces: 0, assets: 0 };
  const openB = buildings.find((b) => b.id === nav.buildingId) ?? null;
  const activeF: EstateFloor | null =
    openB?.floors.find((f) => f.recordId === nav.floorId) ?? null;
  const q = search.toLowerCase();

  const openWorkOrders = (estate.data?.workOrders ?? []).filter(
    (w) => !/closed|cancel|resolved|complete/i.test(String((w as { moduleState?: string }).moduleState ?? '')),
  ).length;
  /* Status colouring activates on the sample overlay OR on genuinely open work. */
  const health = sampleHealth || openWorkOrders > 0;

  const wosOf = (f: EstateFloor): EstateMarker[] =>
    health ? f.markers.filter((m) => m.markerModuleName === 'workorder') : [];

  const spaceState = (f: EstateFloor, sp: EstateSpace) => {
    const assets = f.markers.filter((m) => m.markerModuleName === 'asset' && m.spaceId === sp.recordId);
    const jobs = wosOf(f).filter((w) => assets.some((a) => a.recordId === (w as { assetId?: number }).assetId));
    const bad =
      jobs.some((w) => (w as { priority?: number }).priority === 1 || w.status === 'overdue') ||
      assets.some((a) => a.status === 'critical');
    return { n: jobs.length, dot: bad ? C.red : jobs.length ? C.yellow : C.green };
  };

  const selAsset = selected?.kind === 'asset' ? (selected.m ?? null) : null;
  const selSpace = selected?.kind === 'space' ? (selected.space ?? null) : null;
  const focusSpaceId = selSpace ? selSpace.recordId : (selAsset?.spaceId ?? null);

  const bldRows = buildings.map((b) => {
    const nAssets = b.floors.reduce(
      (k, f) => k + f.markers.filter((m) => m.markerModuleName === 'asset').length,
      0,
    );
    const nJobs = b.floors.reduce((k, f) => k + wosOf(f).length, 0);
    const anyCrit = b.floors.some((f) =>
      wosOf(f).some((w) => (w as { priority?: number }).priority === 1 || w.status === 'overdue'),
    );
    return {
      key: b.id,
      name: b.name,
      meta: `${b.nF}${b.nF === 1 ? ' floor' : ' floors'} · ${nAssets} assets`,
      n: health && nJobs ? nJobs : false,
      pillBg: anyCrit ? C.redBg : '#f1f4f9',
      pillFg: anyCrit ? C.red : C.sub,
      onClick: () => engineRef.current?.enterBuilding(b.id),
    };
  });

  const floorRows = openB
    ? openB.floors
        .slice()
        .reverse()
        .map((f) => {
          const jobs = wosOf(f);
          const bad = jobs.some((w) => (w as { priority?: number }).priority === 1 || w.status === 'overdue');
          const fActive = nav.floorId === f.recordId;
          return {
            key: f.recordId,
            name: f.name,
            tenantName: f.tenantName,
            hasPlan: !!f.plan,
            bg: fActive ? C.blueBg : 'transparent',
            fg: fActive ? C.blueDk : C.ink,
            pip: health && jobs.length > 0,
            pipColor: bad ? C.red : C.yellow,
            onClick: () => engineRef.current?.flyToFloor(openB.id, f.recordId),
          };
        })
    : [];

  const assetRow = (a: EstateMarker) => {
    const active = selAsset?.recordId === a.recordId;
    return {
      key: a.recordId,
      code: a.code,
      category: (a as { taxonomyName?: string }).taxonomyName || a.category,
      dot: !health
        ? C.faint
        : a.status === 'critical'
          ? C.red
          : a.status === 'overdue'
            ? C.amber
            : C.green,
      bg: active ? C.blueBg : C.white,
      bd: active ? C.blueBd : C.hair,
      fg: active ? C.blueDk : C.ink,
      iconFg: active ? C.blue : C.mute,
      onClick: () => engineRef.current?.select(a.recordId),
    };
  };

  type SpaceRow = {
    key: string | number;
    name: string;
    dot: string;
    n: number | false;
    bg: string;
    fg: string;
    assets: ReturnType<typeof assetRow>[];
    onClick: () => void;
  };
  let spaceRows: SpaceRow[] = [];
  if (activeF) {
    const assets = activeF.markers
      .filter((m) => m.markerModuleName === 'asset')
      .filter(
        (m) =>
          !q ||
          `${m.code ?? ''} ${(m as { taxonomyName?: string }).taxonomyName ?? m.category ?? ''}`
            .toLowerCase()
            .includes(q),
      );
    const assetsIn = (sp: EstateSpace) => assets.filter((a) => a.spaceId === sp.recordId);
    spaceRows = activeF.spaces.map((sp) => {
      const st = spaceState(activeF, sp);
      const spActive = focusSpaceId === sp.recordId;
      const spAssets = assetsIn(sp);
      return {
        key: sp.recordId,
        name: sp.name,
        dot: health ? st.dot : ((sp as { categoryColor?: string }).categoryColor ?? C.faint),
        n: spAssets.length || (false as const),
        bg: spActive ? C.blueBg : 'transparent',
        fg: spActive ? C.blueDk : C.ink,
        assets: spActive ? spAssets.map(assetRow) : [],
        onClick: () =>
          spActive ? engineRef.current?.select(null) : engineRef.current?.select(sp.recordId, 'space'),
      };
    });
    const claimed = new Set<number>();
    activeF.spaces.forEach((sp) => assetsIn(sp).forEach((a) => claimed.add(a.recordId)));
    const corridor = focusSpaceId ? [] : assets.filter((a) => !claimed.has(a.recordId)).map(assetRow);
    if (corridor.length) {
      spaceRows.push({
        key: 'corridor',
        name: 'Corridor & plant',
        dot: C.faint,
        n: corridor.length,
        bg: 'transparent',
        fg: C.sub,
        assets: corridor,
        onClick: () => {},
      });
    }
  }

  /* ---- breadcrumb: last two of the full chain ---- */
  const chain: { label: string; onClick: () => void }[] = [
    { label: data?.name ?? 'Estate', onClick: () => engineRef.current?.reset() },
  ];
  if (openB) chain.push({ label: openB.name, onClick: () => engineRef.current?.enterBuilding(openB.id) });
  if (activeF) {
    chain.push({ label: activeF.tenantName ?? activeF.name, onClick: () => engineRef.current?.select(null) });
  }
  const spName = selSpace ? selSpace.name : (selAsset?.spaceName ?? null);
  const spId = selSpace ? selSpace.recordId : (selAsset?.spaceId ?? null);
  if (spName) chain.push({ label: spName, onClick: () => spId && engineRef.current?.select(spId, 'space') });
  if (selAsset) chain.push({ label: String(selAsset.code ?? selAsset.name ?? ''), onClick: () => {} });
  const crumbShown = chain.slice(-2);

  /* ---- room label chips ---- */
  const rect = slotRef.current?.getBoundingClientRect() ?? { width: 1200, height: 760 };
  const focusMode = !!selAsset;
  const desktop = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
  const MAX_LABELS = desktop ? 7 : 3;
  const SEP_X = 170;
  const SEP_Y = 46;
  const roomLabels: {
    recordId: number; name: string; z: number; x: number; y: number; op: number; dot: string; count: number | false;
  }[] = [];
  if (activeF) {
    const placed: { x: number; y: number }[] = [];
    for (let i = spaceTags.length - 1; i >= 0 && roomLabels.length < MAX_LABELS; i--) {
      const t = spaceTags[i] as EngineTag & { name?: string; status?: string; open?: number; progress?: number };
      const x = Math.max(90, Math.min(rect.width - 90, t.x));
      const y = Math.max(70, Math.min(rect.height - 110, t.y));
      if (!t.selected && placed.some((p) => Math.abs(p.x - x) < SEP_X && Math.abs(p.y - y) < SEP_Y)) continue;
      placed.push({ x, y });
      roomLabels.push({
        recordId: t.recordId,
        name: t.name ?? '',
        z: 5 + i,
        x,
        y,
        op: focusMode ? 0 : 1,
        dot: !health
          ? C.faint
          : t.status === 'open'
            ? C.red
            : t.status === 'progress'
              ? C.yellow
              : t.status === 'selected'
                ? C.blue
                : C.green,
        count: health ? (t.open ?? 0) + (t.progress ?? 0) || false : false,
      });
    }
  }

  /* ---- detail card ---- */
  const selWos = selAsset && activeF
    ? activeF.markers.filter(
        (m) => m.markerModuleName === 'workorder' && (m as { assetId?: number }).assetId === selAsset.recordId,
      )
    : [];
  const insp = (selAsset?.inspections as { name: string; dueOn?: number; status?: string }[] | undefined) ?? [];
  const stat: [string, string, string] | null = selAsset
    ? !health
      ? ['No health data', '#f1f4f9', C.sub]
      : selAsset.status === 'critical'
        ? ['Critical', C.redBg, C.red]
        : selAsset.status === 'overdue'
          ? ['Service overdue', C.amberBg, C.amberFg]
          : ['Healthy', C.greenBg, C.greenFg]
    : null;
  const showTabs = !!selAsset && health;

  const a = selAsset as (EstateMarker & Record<string, unknown>) | null;
  const s = selSpace as (EstateSpace & Record<string, unknown>) | null;
  const selRows: { k: string; v: string; color: string }[] = a
    ? [
        { k: 'Category', v: dash(a.taxonomyName), color: C.ink },
        { k: 'Model type', v: dash(a.modelLabel), color: C.ink },
        { k: 'Manufacturer', v: dash(a.manufacturer), color: C.ink },
        { k: 'Model', v: dash(a.model), color: C.ink },
        { k: 'Serial', v: dash(a.serial), color: C.ink },
        { k: 'Space', v: dash(a.spaceName), color: C.ink },
        { k: 'Last serviced', v: fmt(a.lastServicedOn), color: C.ink },
        {
          k: 'Next due',
          v: fmt(a.nextServiceDue),
          color: health && typeof a.nextServiceDue === 'number' && a.nextServiceDue < Date.now() ? C.red : C.ink,
        },
        {
          k: 'Condition',
          v: typeof a.condition === 'string' ? a.condition[0].toUpperCase() + a.condition.slice(1) : '—',
          color: C.ink,
        },
        { k: 'Criticality', v: dash(a.criticality), color: C.ink },
        { k: 'Run hours', v: typeof a.runHours === 'number' ? `${a.runHours.toLocaleString()} h` : '—', color: C.ink },
        { k: 'Record', v: `#${a.recordId}`, color: C.ink },
      ]
    : s
      ? [
          { k: 'Category', v: dash(s.spaceCategory), color: C.ink },
          { k: 'Group', v: dash(s.spaceGroup), color: C.ink },
          { k: 'Building', v: openB?.name ?? '—', color: C.ink },
          { k: 'Floor', v: dash(s.floorName), color: C.ink },
          {
            k: s.planArea != null ? 'Area (measured off plan)' : 'Area',
            v: s.planArea != null ? `${s.planArea} m²` : s.area ? `${s.area} m²` : '—',
            color: C.ink,
          },
          { k: 'Occupied', v: s.isOccupied == null ? '—' : s.isOccupied ? 'Yes' : 'No', color: C.ink },
          {
            k: 'Assets',
            v: String(
              activeF
                ? activeF.markers.filter((m) => m.markerModuleName === 'asset' && m.spaceId === s.recordId).length
                : 0,
            ),
            color: C.ink,
          },
          { k: 'Record', v: `#${s.recordId}`, color: C.ink },
        ]
      : [];

  const selTabs: [typeof tab, string][] = showTabs
    ? [
        ['details', 'Details'],
        ['work', `Work · ${selWos.length}`],
        ['insp', `Inspections · ${insp.length}`],
      ]
    : [];

  const tools = [
    { label: 'Zoom in', d: 'M12 5v14M5 12h14', bd: C.hair, onClick: () => engineRef.current?.zoom(-1) },
    { label: 'Zoom out', d: 'M5 12h14', bd: C.hair, onClick: () => engineRef.current?.zoom(1) },
    { label: 'Back', d: 'M19 12H5M11 18l-6-6 6-6', bd: C.hair, onClick: () => engineRef.current?.back() },
    { label: 'Reset view', d: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5', bd: 'transparent', onClick: () => engineRef.current?.reset() },
  ];

  const level = nav.level;
  const panelTitle =
    level === 0
      ? (data?.name ?? 'Estate')
      : level === 1
        ? (openB?.name ?? '')
        : activeF
          ? openB
            ? `${openB.name} · ${activeF.name}`
            : activeF.name
          : '';
  const panelSub =
    level === 0
      ? `${buildings.length} buildings`
      : level === 1
        ? openB
          ? `${openB.nF} floors — pick one to enter`
          : ''
        : activeF
          ? `${activeF.spaces.length} spaces · ${activeF.markers.filter((m) => m.markerModuleName === 'asset').length} assets`
          : '';

  const activePlan = activeF?.plan as { widthM: number; depthM: number; rooms: unknown[] } | null | undefined;
  const hint = activeF
    ? activePlan
      ? `CAD plan · ${activePlan.widthM} × ${activePlan.depthM} m · ${activePlan.rooms.length} rooms`
      : 'Click an asset to inspect'
    : openB
      ? 'Click a floor to enter'
      : 'Click a building to open';
  const legend = health
    ? [
        { c: C.green, label: 'Healthy' },
        { c: C.yellow, label: 'Attention' },
        { c: C.red, label: 'Critical' },
      ]
    : [];

  /* ---------- handoff ---------- */
  async function findOnSite() {
    if (!selAsset) return;
    const placeLabel = [openB?.name, activeF?.tenantName ?? activeF?.name].filter(Boolean).join(' · ');
    const next = await planFindOnSite({
      assetId: selAsset.recordId,
      assetName: String(selAsset.code ?? selAsset.name ?? ''),
      scope: { siteId: openB?.siteId ?? undefined, buildingId: openB?.recordId, floorId: activeF?.recordId },
      placeLabel: placeLabel || undefined,
    });
    setPlan(next);

    if (next.kind === 'unsurveyed') return; // stay put and say so
    // Scope FIRST — that is what makes this a handoff rather than a tab switch.
    setLocation({
      scope: next.scope,
      names: {
        site: openB?.siteName,
        building: openB?.name,
        floor: activeF?.tenantName ?? activeF?.name,
      },
    });
    goToTab(next.kind === 'ar' ? 'ar' : 'wayfinder', { asset: selAsset.recordId });
  }

  /**
   * Import a plan against the floor currently open.
   *
   * Bound by floor id, not by name — PLAN_ASSIGNMENTS matches building/floor
   * names and is only the default for the two plans that ship with the app, so
   * an import must not be something a later rename can silently detach.
   */
  async function onPlanFile(file: File | undefined) {
    if (!file || !activeF) return;
    setImportState({ kind: 'busy', label: `Reading ${file.name}…` });
    try {
      const { plan } = await importPlanFile(file);
      setImportState({ kind: 'busy', label: `Saving ${plan.rooms.length} rooms…` });
      await savePlanForFloor(activeF.recordId, plan);
      setImportState({
        kind: 'done',
        message: `${plan.name} — ${plan.widthM} × ${plan.depthM} m, ${plan.rooms.length} rooms.`,
      });
      // The plate size comes from the plan, so the estate has to be rebuilt from
      // records rather than re-tinted in place — and a rebuild resets the camera
      // to estate level. Remember where we were so the user lands back on the
      // floor they just imported to, looking at it.
      restoreFloorRef.current = openB ? { buildingId: openB.id, floorId: activeF.recordId } : null;
      await estate.refetch();
    } catch (err) {
      // PlanExtractError messages are written to be read by the person who
      // picked the file; anything else is a bug and says so plainly.
      const message =
        err instanceof PlanExtractError
          ? err.message
          : `Import failed: ${(err as Error)?.message ?? String(err)}`;
      setImportState({ kind: 'error', message });
    }
  }

  function walkIn() {
    // The engine refuses on a floor with no plan; trust its answer rather than
    // duplicating the rule here and letting the two disagree.
    const ok = engineRef.current?.setCameraMode('walk');
    if (!ok) setImportState({ kind: 'error', message: 'Walk-in needs a floor plan on this floor.' });
    else setPlanMode('solid');
  }

  function togglePlanMode() {
    const next = planMode === 'solid' ? 'drawing' : 'solid';
    setPlanMode(next);
    engineRef.current?.setPlanMode(next);
  }

  function copyRef() {
    const text = selAsset
      ? `${selAsset.code} — ${selAsset.name} (asset #${selAsset.recordId})`
      : selSpace
        ? `${selSpace.name} (space #${selSpace.recordId})`
        : '';
    if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <div className="estate-3d">
      <div className="estate-viewport">
        <div ref={slotRef} style={{ position: 'absolute', inset: 0 }} />

        {/* floating navigator panel */}
        {panelOpen ? (
          <div
            className="est-panel"
            style={{ position: 'absolute', left: 14, top: 14, bottom: 64, width: 264, zIndex: 24, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}
          >
            <div
              className="est-panel-in"
              style={{ display: 'flex', flexDirection: 'column', maxHeight: '100%', background: C.white, border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: 'var(--shadow-md)', overflow: 'hidden', pointerEvents: 'auto' }}
            >
              <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 11px', borderBottom: `1px solid ${C.hair}` }}>
                {level > 0 && (
                  <button className="est-tool" onClick={() => engineRef.current?.back()} aria-label="Back" style={{ width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.sub, flex: 'none', background: 'none', border: 'none', padding: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                  </button>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{panelTitle}</div>
                  <div style={{ fontSize: 11, color: C.mute, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{panelSub}</div>
                </div>
                <button className="est-tool" onClick={() => setPanelOpen(false)} aria-label="Collapse" title="Collapse" style={{ width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.sub, flex: 'none', background: 'none', border: 'none', padding: 0 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" /></svg>
                </button>
              </div>

              {/* breadcrumb, moved off the deleted 52px header */}
              <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderBottom: `1px solid ${C.hair}`, fontSize: 11.5, minWidth: 0 }}>
                {chain.length > 2 && <span style={{ color: C.faint, flex: 'none' }}>…</span>}
                {crumbShown.map((c, i) => (
                  <span key={`${c.label}-${i}`} style={{ display: 'contents' }}>
                    {(i > 0 || chain.length > 2) && <span style={{ color: C.faint, flex: 'none' }}>/</span>}
                    <button
                      className="est-crumb"
                      onClick={c.onClick}
                      style={{ cursor: 'pointer', color: i === crumbShown.length - 1 ? C.ink : C.sub, fontWeight: i === crumbShown.length - 1 ? 600 : 400, minWidth: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'none', border: 'none', padding: 0, font: 'inherit' }}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>

              <div className="scroll-y" style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
                {level === 0 && bldRows.map((b) => (
                  <div key={b.key} className="est-row" onClick={b.onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && b.onClick()} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '5px 10px', borderRadius: 6, cursor: 'pointer' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.sub} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} aria-hidden="true"><path d="M4 21V6l7-3 7 3v15" /><path d="M9 21v-5h4v5" /><path d="M2 21h20" /></svg>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                      <div style={{ fontSize: 11, color: C.mute, marginTop: 1 }}>{b.meta}</div>
                    </div>
                    {!!b.n && <span style={{ fontSize: 11, fontWeight: 500, padding: '1px 8px', borderRadius: 10, background: b.pillBg, color: b.pillFg, flex: 'none' }}>{b.n}</span>}
                  </div>
                ))}

                {level === 1 && floorRows.map((f) => (
                  <div key={f.key} className="est-row" onClick={f.onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && f.onClick()} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 34, padding: '0 10px', borderRadius: 6, cursor: 'pointer', background: f.bg }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: f.fg, width: 34, flex: 'none' }}>{f.name}</span>
                    <span style={{ fontSize: 11.5, color: C.mute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.tenantName}</span>
                    {f.hasPlan && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.3px', padding: '1px 5px', borderRadius: 4, background: C.blueBg, color: C.blueDk, flex: 'none' }}>CAD</span>}
                    {f.pip && <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: f.pipColor }} />}
                  </div>
                ))}

                {level === 2 && spaceRows.map((sp) => (
                  <div key={sp.key} style={{ display: 'contents' }}>
                    <div className="est-row" onClick={sp.onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && sp.onClick()} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 32, padding: '0 10px', borderRadius: 6, cursor: 'pointer', background: sp.bg }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: sp.dot, flex: 'none' }} />
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: sp.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{sp.name}</span>
                      {!!sp.n && <span style={{ fontSize: 11, color: C.mute, flex: 'none' }}>{sp.n}</span>}
                    </div>
                    {sp.assets.map((asset) => (
                      <div key={asset.key} className="est-asset" onClick={asset.onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && asset.onClick()} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: '0 8px 0 20px', borderRadius: 6, cursor: 'pointer', background: asset.bg, border: `1px solid ${asset.bd}`, margin: '1px 0' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={asset.iconFg} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} aria-hidden="true"><path d={ICON_ASSET} /></svg>
                        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-display)', letterSpacing: '0.2px', color: asset.fg, flex: 'none' }}>{asset.code}</span>
                        <span style={{ fontSize: 11.5, color: C.mute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{asset.category}</span>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: asset.dot, flex: 'none' }} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* ---------- top chrome ----------
            One flex column. Three clusters used to be absolutely pinned to the
            same top:14 (navigator · floor tools · search + health) and collided
            on any phone narrower than their sum. Rows lay out; pins overlap. */}
        <div className="est-chrome-top">
          <div className="est-chrome-row">
            {!panelOpen && (
              <button className="est-row est-nav-btn" onClick={() => setPanelOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.sub} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z" /><path d="M4 12l8 4.5 8-4.5" /><path d="M4 16.5L12 21l8-4.5" /></svg>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: C.ink }}>Navigator</span>
              </button>
            )}
            <span className="est-chrome-spacer" aria-hidden="true" />
            {!(selAsset || selSpace) && (
              <>
                <div className="est-search-wrap">
                  <input
                    className="est-input est-search-input"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && searchHits[0]) pickHit(searchHits[0]);
                      else if (e.key === 'Escape') setSearch('');
                    }}
                    placeholder="Find an asset"
                    aria-label="Find an asset"
                    role="combobox"
                    aria-expanded={searchHits.length > 0}
                    aria-controls="est-search-pop"
                    style={{ height: 34, border: `1px solid ${C.line}`, borderRadius: 8, padding: '0 12px', fontSize: 12.5, fontFamily: 'var(--font-sans)', color: C.ink, outline: 'none', background: C.white }}
                  />
                  {searchHits.length > 0 && (
                    <div id="est-search-pop" className="est-search-pop" role="listbox" aria-label="Matches">
                      {searchHits.map((h) => (
                        <button
                          key={`${h.kind}:${h.recordId}`}
                          role="option"
                          aria-selected={false}
                          className="est-search-hit"
                          onClick={() => pickHit(h)}
                        >
                          <span className={`est-search-kind est-search-kind--${h.kind}`}>
                            {h.kind === 'asset' ? 'Asset' : h.kind === 'space' ? 'Space' : 'Building'}
                          </span>
                          <span className="est-search-label">{h.label}</span>
                          <span className="est-search-sub">{h.sub}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  role="switch"
                  aria-checked={sampleHealth}
                  onClick={() => setSampleHealth((v) => !v)}
                  title="Overlay sample work orders and asset health on the estate. Nothing is written back to Facilio."
                  style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500, height: 34, padding: '0 12px', borderRadius: 8, cursor: 'pointer', color: sampleHealth ? C.blueDk : C.sub, background: sampleHealth ? C.blueBg : C.white, border: `1px solid ${sampleHealth ? C.blueBd : C.line}`, whiteSpace: 'nowrap' }}
                >
                  <span style={{ width: 22, height: 12, borderRadius: 7, background: sampleHealth ? C.blue : '#c6d3e4', position: 'relative', flex: 'none', transition: 'background var(--dur-base) var(--ease-standard)' }}>
                    <span style={{ position: 'absolute', top: 2, left: sampleHealth ? 12 : 2, width: 8, height: 8, borderRadius: '50%', background: C.white, transition: 'left var(--dur-base) var(--ease-standard)' }} />
                  </span>
                  <span className="est-health-label">Sample health</span>
                </button>
              </>
            )}
          </div>

          {/* walking HUD — replaces the floor tools while you are inside the plan */}
          {camMode === 'walk' && (
            <div className="est-chrome-row est-chrome-center">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: '7px 12px', boxShadow: 'var(--shadow-md)' }}>
                <span style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>
                  <span className="est-walk-hint-desk">Drag to look · W A S D or arrows to walk</span>
                  <span className="est-walk-hint-mob">Drag to look · pad to walk</span>
                </span>
                <button
                  className="est-primary"
                  onClick={() => engineRef.current?.setCameraMode('orbit')}
                  style={{ height: 26, padding: '0 11px', fontSize: 12, fontWeight: 500, color: C.white, background: C.blue, border: 'none', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  Leave
                </button>
              </div>
            </div>
          )}

          {/* floor tools: import a plan, and read it as a drawing or as a space.
              Only inside a floor — neither means anything at estate or building level. */}
          {activeF && camMode === 'orbit' && !selAsset && !selSpace && (
            <div className="est-chrome-row est-floor-tools">
              {activePlan && (
                <div role="group" aria-label="Floor view" style={{ display: 'flex', background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
                  {(['drawing', 'solid'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => mode !== planMode && togglePlanMode()}
                      aria-pressed={planMode === mode}
                      style={{ padding: '7px 14px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', border: 'none', background: planMode === mode ? C.blueBg : 'transparent', color: planMode === mode ? C.blueDk : C.sub }}
                    >
                      {mode === 'drawing' ? 'Drawing' : '3D'}
                    </button>
                  ))}
                </div>
              )}
              {activePlan && planMode === 'solid' && (
                <button
                  className="est-ghost"
                  onClick={walkIn}
                  style={{ height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500, color: C.ink, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-md)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="4" r="2" /><path d="M10 21l1.5-6-2-2 1-5 3 2 2 2" /><path d="M9.5 13L8 21" />
                  </svg>
                  Walk in
                </button>
              )}
              <button
                className="est-ghost"
                onClick={() => fileInput.current?.click()}
                disabled={importState.kind === 'busy'}
                style={{ height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500, color: C.ink, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, cursor: importState.kind === 'busy' ? 'progress' : 'pointer', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-md)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                </svg>
                {activePlan ? 'Replace floor plan' : 'Import floor plan'}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".svg,.json,image/svg+xml,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void onPlanFile(e.target.files?.[0]);
                  e.target.value = ''; // let the same file be picked twice
                }}
              />
            </div>
          )}

          {activeF && camMode === 'orbit' && !selAsset && !selSpace && importState.kind !== 'idle' && (
            <div className="est-chrome-row est-chrome-center">
              <div
                role="status"
                style={{ maxWidth: 420, textAlign: 'center', fontSize: 12, lineHeight: 1.45, padding: '7px 12px', borderRadius: 8, background: C.white, border: `1px solid ${importState.kind === 'error' ? C.redBd : C.line}`, color: importState.kind === 'error' ? C.red : C.sub, boxShadow: 'var(--shadow-md)' }}
              >
                {importState.kind === 'busy' && importState.label}
                {importState.kind === 'done' && importState.message}
                {importState.kind === 'error' && importState.message}
              </div>
            </div>
          )}
        </div>

        {/* Touch pad. A phone has no W A S D, and a virtual stick is a lot of
            machinery for four directions — these are the four directions. Pinned
            bottom-left, outside the top chrome, opposite the zoom rail. */}
        {camMode === 'walk' && (
          <div
            aria-label="Walk"
            style={{ position: 'absolute', left: 18, bottom: 18, zIndex: 26, display: 'grid', gridTemplateColumns: 'repeat(3, 44px)', gridTemplateRows: 'repeat(2, 44px)', gap: 6 }}
          >
            {([
              { label: 'Forward', d: 'M12 19V5M6 11l6-6 6 6', col: 2, row: 1, f: 1, s: 0 },
              { label: 'Left', d: 'M19 12H5M11 6l-6 6 6 6', col: 1, row: 2, f: 0, s: -1 },
              { label: 'Back', d: 'M12 5v14M6 13l6 6 6-6', col: 2, row: 2, f: -1, s: 0 },
              { label: 'Right', d: 'M5 12h14M13 6l6 6-6 6', col: 3, row: 2, f: 0, s: 1 },
            ] as const).map((btn) => (
              <button
                key={btn.label}
                aria-label={btn.label}
                // Pointer events, not click: walking is held, not tapped. The
                // cancel/leave pair is what stops a finger sliding off the pad
                // from walking forever.
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  engineRef.current?.setWalkInput(btn.f, btn.s);
                }}
                onPointerUp={() => engineRef.current?.setWalkInput(0, 0)}
                onPointerCancel={() => engineRef.current?.setWalkInput(0, 0)}
                onPointerLeave={() => engineRef.current?.setWalkInput(0, 0)}
                style={{ gridColumn: btn.col, gridRow: btn.row, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.94)', border: `1px solid ${C.line}`, borderRadius: 8, color: C.sub, cursor: 'pointer', boxShadow: 'var(--shadow-md)', touchAction: 'none' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={btn.d} />
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* room label chips */}
        {roomLabels.map((r) => (
          <button key={r.recordId} onClick={() => engineRef.current?.select(r.recordId, 'space')} style={{ position: 'absolute', left: r.x, top: r.y, transform: 'translate(-50%,-100%)', zIndex: r.z, cursor: 'pointer', opacity: r.op, transition: 'opacity 200ms var(--ease-standard)', background: 'none', border: 'none', padding: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'rgba(255,255,255,0.95)', borderRadius: 14, padding: '4px 11px', boxShadow: 'var(--shadow-md)', whiteSpace: 'nowrap' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.dot }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: C.ink }}>{r.name}</span>
              {!!r.count && <span style={{ fontSize: 11, fontWeight: 600, color: C.sub }}>{r.count}</span>}
            </div>
          </button>
        ))}

        {focusMode && (
          <div className="est-fade-in" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(circle at 50% 48%, rgba(238,242,248,0) 34%, rgba(238,242,248,0.4) 78%)' }} />
        )}

        {/* an asset handed over from AR that the model has no place for */}
        {notPlaced !== null && !selAsset && (
          <div style={{ position: 'absolute', left: '50%', top: 20, transform: 'translateX(-50%)', zIndex: 45, maxWidth: 420, background: C.white, border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: '12px 14px' }}>
            <div style={{ fontSize: 12.5, color: C.ink }}>
              Asset #{notPlaced} is in Facilio but isn’t placed in the model — its record has no space assigned.
            </div>
            {canOpenAsset && (
              <button className="est-link" onClick={() => { void openAsset(notPlaced); }} style={{ marginTop: 8, fontSize: 12.5, fontWeight: 500, color: C.blue, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                Open in Facilio
              </button>
            )}
          </div>
        )}

        {/* floating detail card */}
        {(selAsset || selSpace) && (
          <div className="est-card est-card-in" style={{ position: 'absolute', right: 14, top: 14, zIndex: 40, width: 336, maxWidth: 'calc(100% - 28px)', maxHeight: 'calc(100% - 76px)', display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.line}`, borderRadius: 12, boxShadow: 'var(--shadow-xl)', overflow: 'hidden' }}>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 11, padding: '14px 14px 12px' }}>
              <span style={{ width: 38, height: 38, borderRadius: 9, background: C.blueBg, color: C.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={selAsset ? ICON_ASSET : ICON_SPACE} /></svg>
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selAsset ? String(selAsset.code ?? selAsset.name) : selSpace?.name}
                  </span>
                  <span style={{ fontSize: 10.5, fontWeight: 500, padding: '2px 9px', borderRadius: 10, background: selAsset && stat ? stat[1] : C.blueBg, color: selAsset && stat ? stat[2] : C.blueDk, flex: 'none' }}>
                    {selAsset && stat ? stat[0] : dash(selSpace?.spaceCategory)}
                  </span>
                  {selAsset && (selAsset as { _sample?: boolean })._sample && (
                    <span style={{ fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: C.amberBg, color: C.amberFg, flex: 'none' }}>sample</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selAsset
                    ? `${(selAsset as { taxonomyName?: string }).taxonomyName ?? selAsset.category} · ${dash(selAsset.spaceName)}`
                    : `${dash((selSpace as { spaceGroup?: string } | null)?.spaceGroup)} · ${openB?.name ?? ''}`}
                </div>
              </div>
              <button className="est-close" onClick={() => engineRef.current?.select(null)} aria-label="Close" style={{ width: 26, height: 26, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.sub, flex: 'none', background: 'none', border: 'none', padding: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            </div>

            {showTabs ? (
              <div style={{ flex: 'none', display: 'flex', gap: 2, padding: '0 14px', borderBottom: `1px solid ${C.hair}` }}>
                {selTabs.map(([tid, label]) => (
                  <button key={tid} onClick={() => setTab(tid)} style={{ fontSize: 12, fontWeight: 500, padding: '7px 10px', borderBottom: `2px solid ${tab === tid ? C.blue : 'transparent'}`, color: tab === tid ? C.ink : C.sub, cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap', background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}>
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ flex: 'none', height: 1, background: C.hair, margin: '0 14px' }} />
            )}

            <div className="scroll-y" style={{ flex: 1, overflowY: 'auto', padding: '13px 14px', minHeight: 0 }}>
              {(tab === 'details' || !showTabs) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
                  {selRows.map((row) => (
                    <div key={row.k}>
                      <div style={{ fontSize: 11, color: C.mute }}>{row.k}</div>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: row.color, marginTop: 2, overflowWrap: 'anywhere' }}>{row.v}</div>
                    </div>
                  ))}
                </div>
              )}

              {showTabs && tab === 'work' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {selWos.map((w) => {
                    const wo = w as EstateMarker & { priority?: number; trade?: string; raisedAt?: number; subject?: string };
                    const urgent = wo.priority === 1;
                    const warn = wo.status === 'overdue';
                    return (
                      <div key={wo.recordId} style={{ border: `1px solid ${urgent ? C.redBd : C.line}`, borderRadius: 8, padding: '9px 11px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: urgent ? C.redBg : warn ? C.amberBg : C.blueBg, color: urgent ? C.red : warn ? C.amberFg : C.blueDk, flex: 'none' }}>
                            {urgent ? 'P1 · Critical' : warn ? 'Overdue' : `P${wo.priority ?? 3} · Open`}
                          </span>
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.mute, flex: 'none' }}>{`${wo.trade ?? ''} · ${age(wo.raisedAt)}`}</span>
                        </div>
                        <div style={{ fontSize: 12.5, fontWeight: 500, marginTop: 5, lineHeight: 1.35 }}>{wo.subject}</div>
                      </div>
                    );
                  })}
                  {selWos.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: '4px 0' }}>No open work orders on this asset.</div>}
                </div>
              )}

              {showTabs && tab === 'insp' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {insp.map((i, ix) => (
                    <div key={ix} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 11px' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: i.status === 'overdue' ? C.redBg : C.blueBg, color: i.status === 'overdue' ? C.red : C.blueDk, flex: 'none' }}>
                        {i.status === 'overdue' ? 'Overdue' : 'Scheduled'}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: C.mute, flex: 'none' }}>{fmt(i.dueOn)}</span>
                    </div>
                  ))}
                  {insp.length === 0 && (
                    <div style={{ fontSize: 12.5, color: C.mute, padding: '4px 0' }}>
                      {estate.data?.inspectionsUnavailable
                        ? 'Inspections aren’t enabled in this org.'
                        : 'No inspections scheduled.'}
                    </div>
                  )}
                </div>
              )}

              {/* the honest dead-end: nowhere surveyed, so do not navigate */}
              {plan?.kind === 'unsurveyed' && (
                <div style={{ marginTop: 12, border: `1px solid ${C.line}`, borderRadius: 8, padding: '10px 11px', background: 'var(--bg-app)' }}>
                  <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.45 }}>{plan.caption}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                    <button className="est-link" onClick={() => goToTab('surveys')} style={{ fontSize: 12.5, fontWeight: 500, color: C.blue, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                      Survey this floor
                    </button>
                    <button className="est-link" onClick={() => goToTab('wayfinder')} style={{ fontSize: 12.5, fontWeight: 500, color: C.sub, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                      Directions to site
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div style={{ flex: 'none', display: 'flex', gap: 8, padding: '11px 14px', borderTop: `1px solid ${C.hair}`, flexWrap: 'wrap' }}>
              {selAsset && (
                <button className="est-primary" onClick={() => void findOnSite()} style={{ height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 12.5, fontWeight: 500, color: C.white, background: C.blue, borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap', border: 'none' }}>
                  Find it on site
                </button>
              )}
              {/* Assets only: the bridge's module union is workorder|asset and
                  there is no space link template, so a space would get a link
                  that goes to the wrong record type. */}
              {selAsset && canOpenAsset && (
                <button
                  className="est-ghost"
                  onClick={() => void openAsset(selAsset.recordId)}
                  style={{ height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 12.5, fontWeight: 500, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap', background: 'none' }}
                >
                  Open in Facilio
                </button>
              )}
              <button className="est-ghost" onClick={copyRef} style={{ height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 12.5, fontWeight: 500, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap', background: 'none' }}>
                Copy reference
              </button>
            </div>
          </div>
        )}

        {/* toolbar */}
        <div className="est-zoom-rail" style={{ position: 'absolute', right: 14, bottom: 14, zIndex: 22, display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
          {tools.map((t) => (
            <button key={t.label} className="est-tool" onClick={t.onClick} title={t.label} aria-label={t.label} style={{ width: 38, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.sub, borderBottom: `1px solid ${t.bd}`, background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.d} /></svg>
            </button>
          ))}
        </div>

        {/* legend + hint */}
        {!(selAsset || selSpace) && (
          <div className="est-legend" style={{ position: 'absolute', left: 0, right: 0, bottom: 14, display: 'flex', justifyContent: 'center', pointerEvents: 'none', padding: '0 66px' }}>
            <div
              title={`${estateCounts.buildings} buildings · ${estateCounts.floors} floors · ${estateCounts.spaces} spaces · ${estateCounts.assets} assets. Floors without a CAD plan use a schematic layout derived from the real containment hierarchy.`}
              style={{ display: 'flex', alignItems: 'center', gap: 16, width: 'max-content', maxWidth: '100%', overflow: 'hidden', background: 'rgba(255,255,255,0.94)', border: `1px solid ${C.line}`, borderRadius: 18, padding: '8px 18px', boxShadow: 'var(--shadow-md)', pointerEvents: 'auto' }}
            >
              {legend.map((l) => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.c }} />
                  <span style={{ fontSize: 12, color: 'var(--ink-700)', whiteSpace: 'nowrap' }}>{l.label}</span>
                </div>
              ))}
              {legend.length > 0 && <span style={{ width: 1, height: 14, background: C.line, flex: 'none' }} />}
              <span style={{ fontSize: 12, color: C.mute, whiteSpace: 'nowrap', flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</span>
            </div>
          </div>
        )}

        {/* Effi's overlay used to sit here. Removed at the client's request —
            on a desk screen the orb covered the zoom rail, and voice lives on
            the Voice screen and the camera surfaces where it earns its space. */}
      </div>
    </div>
  );
}
