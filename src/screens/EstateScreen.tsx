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
import { goToTab, navParamId, onNavigate, setNavParams } from '../shell/router';
import { useLocationScope } from '../state/LocationContext';
import { openRecordSummary, isEmbeddedInFacilio } from '../api/nav';
import { fillLink, loadLinks, EMPTY_LINKS, type LinkTemplates } from '../api/links';
import PortfolioScreen from './PortfolioScreen';
import EffiOverlay from '../voice/EffiOverlay';
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
  const [effiOpen, setEffiOpen] = useState(false);

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
  });
  const callbacks = useRef({
    onLevel: (n: EngineNav) => handlers.current.onLevel(n),
    onSelect: (s: EngineSelection | null) => handlers.current.onSelect(s),
    onTags: (t: EngineTag[], s: EngineTag[]) => handlers.current.onTags(t, s),
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
        engine.setScope({ canSeeFloor: () => true, canSeeMarker: () => true, showSpaces: true });
        engine.setSearch(search);
        setNav(engine.getState());
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
      <section className="screen">
        <p className="muted">Reading your estate from Facilio…</p>
      </section>
    );
  }
  if (estate.isError) {
    return (
      <section className="screen">
        <p className="error">{(estate.error as Error)?.message ?? 'Could not load the estate.'}</p>
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
        ) : (
          <button className="est-row" onClick={() => setPanelOpen(true)} style={{ position: 'absolute', left: 14, top: 14, zIndex: 24, display: 'flex', alignItems: 'center', gap: 8, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 13px', cursor: 'pointer', boxShadow: 'var(--shadow-md)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.sub} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z" /><path d="M4 12l8 4.5 8-4.5" /><path d="M4 16.5L12 21l8-4.5" /></svg>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: C.ink }}>Navigator</span>
          </button>
        )}

        {/* search + sample health, off the deleted header */}
        <div style={{ position: 'absolute', right: 14, top: 14, zIndex: 23, display: (selAsset || selSpace) ? 'none' : 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="est-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find an asset"
            aria-label="Find an asset"
            style={{ width: 190, height: 32, border: `1px solid ${C.line}`, borderRadius: 4, padding: '0 12px', fontSize: 12.5, fontFamily: 'var(--font-sans)', color: C.ink, outline: 'none', background: C.white }}
          />
          <button
            role="switch"
            aria-checked={sampleHealth}
            onClick={() => setSampleHealth((v) => !v)}
            title="Overlay sample work orders and asset health on the estate. Nothing is written back to Facilio."
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', color: sampleHealth ? C.blueDk : C.sub, background: sampleHealth ? C.blueBg : C.white, border: `1px solid ${sampleHealth ? C.blueBd : C.line}`, whiteSpace: 'nowrap' }}
          >
            <span style={{ width: 22, height: 12, borderRadius: 7, background: sampleHealth ? C.blue : '#c6d3e4', position: 'relative', flex: 'none', transition: 'background var(--dur-base) var(--ease-standard)' }}>
              <span style={{ position: 'absolute', top: 2, left: sampleHealth ? 12 : 2, width: 8, height: 8, borderRadius: '50%', background: C.white, transition: 'left var(--dur-base) var(--ease-standard)' }} />
            </span>
            Sample health
          </button>
        </div>

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
        <div style={{ position: 'absolute', right: 14, bottom: 14, zIndex: 22, display: 'flex', flexDirection: 'column', background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
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

        {/* Effi, on the desk surface.
            EffiOverlay already took assetInView as a prop; feeding it from the
            3D selection is what makes that prop surface-agnostic — "create a
            work order, it's leaking oil" now behaves identically whether the
            asset is in front of the camera or picked in the model. No
            captureFrame here: there is no camera on this screen, and the photo
            lanes degrade honestly without one. */}
        <EffiOverlay
          open={effiOpen}
          onOpenChange={setEffiOpen}
          assetInView={
            selAsset
              ? { id: selAsset.recordId, name: String(selAsset.name ?? selAsset.code ?? '') }
              : undefined
          }
          woUrl={(id) => fillLink(links.wo, id)}
          onShowAsset={(assetId) => engineRef.current?.flyToMarker(assetId)}
        />
      </div>
    </div>
  );
}
