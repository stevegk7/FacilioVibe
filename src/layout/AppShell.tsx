import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import ErrorBoundary from '../shell/ErrorBoundary';
import { detectEmbed } from '../shell/embed';
import Sheet from '../components/Sheet';
import { LayoutGridIcon } from './icons';
import type { Capability } from '../api/roles';
import './layout.css';

/**
 * Adaptive shell — TabShell's registry/param-preserving navigation, rendered
 * in one of three chromes chosen at render time:
 *
 *   embedded  detectEmbed().embedded — compact top pill tabs (the current
 *             TabShell visual; `.app.embedded` paddings apply from styles.css)
 *   desktop   ≥1024px and NOT embedded — admin web layout: 56px topbar +
 *             240px sidebar. Hidden screens are ALWAYS listed here, under an
 *             'Admin' nav section — that is the point of the admin layout.
 *   mobile    everything else — camera-first: 52px bottom icon dock with only
 *             the visible screens; hidden ones join via ?tab= while active,
 *             exactly like today.
 *
 * Driven entirely by props so the integrator can swap it in for TabShell
 * without this file knowing the screen registry.
 */

export interface ShellScreen {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Hidden screens are reachable by ?tab= and join mobile/embedded nav only while active. */
  visible: boolean;
  /** Camera-first screens own the pane: no internal scroll, full bleed. */
  bleed?: boolean;
  /** Reachable by ?tab= for testing, but never listed in any navigation. */
  devOnly?: boolean;
  /**
   * Desktop sidebar grouping. Defaults to `visible ? 'workspace' : 'admin'`, so a
   * screen that does not set it behaves exactly as before.
   *
   * It exists because the two are no longer the same question. The mobile dock
   * holds three tabs; Surveys and Rounds lost their slots to the 3D estate but
   * are field tools, and filing them under "Admin" on a desktop beside
   * Diagnostics would misdescribe them.
   */
  section?: 'workspace' | 'admin';
  /**
   * Capability required to reach this screen at all. Screens without one are
   * open to everyone signed in — their CONTENT is scoped by the data layer
   * instead, which is the normal case (a technician opens the estate and sees
   * their own buildings, rather than being told the estate does not exist).
   *
   * The filtering happens in App.tsx BEFORE the list reaches this component, so
   * an unauthorised screen is not merely unlisted: `tabFromLocation` cannot
   * resolve an id that is not in `screens`, which is what closes ?tab=.
   */
  requires?: Capability;
  component: ComponentType;
}

export interface AppShellProps {
  screens: ShellScreen[];
  /** Fallback tab when the URL names none (or an unknown one). Defaults to the first visible screen. */
  initialTab?: string;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

function tabFromLocation(screens: ShellScreen[], initialTab?: string): string {
  const wanted = new URLSearchParams(window.location.search).get('tab');
  if (wanted !== null && screens.some((s) => s.id === wanted)) return wanted;
  if (initialTab !== undefined && screens.some((s) => s.id === initialTab)) return initialTab;
  return (screens.find((s) => s.visible) ?? screens[0])?.id ?? '';
}

/** Rewrite ONLY the tab param — mock/capp_id/origin/login must survive navigation. */
function pushTab(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', id);
  window.history.pushState({}, '', url);
}

/** jsdom (tests) has no matchMedia — treat "can't tell" as not-desktop. */
function desktopNow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
}

const COLLAPSE_KEY = 'fv.sidebarCollapsed';

export default function AppShell({ screens, initialTab }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage can be blocked in a third-party iframe */
    }
  }, [collapsed]);

  const [active, setActive] = useState(() => tabFromLocation(screens, initialTab));
  const [desktop, setDesktop] = useState(desktopNow);
  /** The dock's overflow sheet — see overflowScreens. */
  const [moreOpen, setMoreOpen] = useState(false);
  const embedded = detectEmbed().embedded;

  useEffect(() => {
    const onPopState = () => setActive(tabFromLocation(screens, initialTab));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [screens, initialTab]);

  // Live mode switch: rotating a tablet or resizing the admin window re-lays
  // the chrome without losing the mounted screen.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    setDesktop(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  if (screens.length === 0) return null;

  const activeScreen =
    screens.find((s) => s.id === active) ?? screens.find((s) => s.visible) ?? screens[0];
  const ActiveComponent = activeScreen.component;

  const select = (id: string) => {
    if (id === activeScreen.id) return;
    pushTab(id);
    setActive(id);
  };

  // Mobile/embedded nav: visible screens, plus the active one if hidden.
  const joinNav = screens.filter((s) => s.visible || s.id === activeScreen.id);
  const sectionOf = (s: ShellScreen) => s.section ?? (s.visible ? 'workspace' : 'admin');
  const visibleScreens = screens.filter((s) => !s.devOnly && sectionOf(s) === 'workspace');
  const hiddenScreens = screens.filter((s) => !s.devOnly && sectionOf(s) === 'admin');

  /**
   * Everything the dock has no room for.
   *
   * The desktop sidebar lists every screen; the dock lists three. That left
   * nine screens — Surveys and Rounds among them — reachable on a phone ONLY
   * by typing ?tab= or by finding the one deep link buried in the 3D estate's
   * empty state. Surveys is where standpoint QR codes are printed, so the
   * Wayfinder told people to do something the phone gave them no way to do.
   *
   * This is the overflow every mobile tab bar eventually grows. The three
   * primary destinations keep their slots (design rule 1.5); the rest are one
   * tap away in a sheet, grouped exactly as the sidebar groups them.
   */
  const overflowScreens = screens.filter((s) => !s.devOnly && !joinNav.includes(s));
  const overflowWorkspace = overflowScreens.filter((s) => sectionOf(s) === 'workspace');
  const overflowAdmin = overflowScreens.filter((s) => sectionOf(s) === 'admin');

  const openMore = (
    <>
      <Sheet open={moreOpen} title="All screens" onClose={() => setMoreOpen(false)} size="tall">
        {overflowWorkspace.length > 0 && (
          <>
            <div className="section-row">
              <span className="section-label">Workspace</span>
            </div>
            {overflowWorkspace.map((s) => (
              <button
                key={s.id}
                className="row-card as-more-row"
                onClick={() => {
                  setMoreOpen(false);
                  select(s.id);
                }}
              >
                <span className="as-more-icon" aria-hidden="true">{s.icon}</span>
                <span className="row-card-title">{s.label}</span>
              </button>
            ))}
          </>
        )}
        {overflowAdmin.length > 0 && (
          <>
            <div className="section-row">
              <span className="section-label">Admin</span>
            </div>
            {overflowAdmin.map((s) => (
              <button
                key={s.id}
                className="row-card as-more-row"
                onClick={() => {
                  setMoreOpen(false);
                  select(s.id);
                }}
              >
                <span className="as-more-icon" aria-hidden="true">{s.icon}</span>
                <span className="row-card-title">{s.label}</span>
              </button>
            ))}
          </>
        )}
      </Sheet>
    </>
  );

  // key resets the boundary when the tab changes, so one crashed screen
  // never poisons the next one the user switches to
  const body = (
    <ErrorBoundary key={activeScreen.id} screen={activeScreen.label}>
      <ActiveComponent />
    </ErrorBoundary>
  );

  if (embedded) {
    return (
      <div className="tab-shell as-embedded">
        <nav className="tab-bar" role="tablist" aria-label="Screens">
          {joinNav.map((screen) => (
            <button
              key={screen.id}
              role="tab"
              aria-selected={screen.id === activeScreen.id}
              className={screen.id === activeScreen.id ? 'tab active' : 'tab'}
              onClick={() => select(screen.id)}
            >
              {screen.label}
            </button>
          ))}
          {overflowScreens.length > 0 && (
            <button
              className={moreOpen ? 'tab active' : 'tab'}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
            >
              More
            </button>
          )}
        </nav>
        {body}
        {openMore}
      </div>
    );
  }

  const navItem = (screen: ShellScreen) => (
    <button
      key={screen.id}
      role="tab"
      aria-selected={screen.id === activeScreen.id}
      className={screen.id === activeScreen.id ? 'nav-item active' : 'nav-item'}
      // The label is hidden when collapsed, so it has to survive as the
      // accessible name and the tooltip.
      aria-label={screen.label}
      title={screen.label}
      onClick={() => select(screen.id)}
    >
      {screen.icon}
      <span>{screen.label}</span>
    </button>
  );

  if (desktop) {
    return (
      <div className={collapsed ? 'as-desktop collapsed' : 'as-desktop'}>
        <header className="as-topbar">
          <button
            className="as-collapse"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <div className="as-logo">
            <span className="as-logo-word">Facilio</span>
            <span className="as-logo-sub">Vision</span>
          </div>
        </header>
        <aside className="as-sidebar">
          <nav className="as-nav" role="tablist" aria-label="Sidebar">
            <div className="nav-section">Workspace</div>
            {visibleScreens.map(navItem)}
            {hiddenScreens.length > 0 && (
              <>
                <div className="nav-section">Admin</div>
                {hiddenScreens.map(navItem)}
              </>
            )}
          </nav>
        </aside>
        <main className="as-main">{body}</main>
      </div>
    );
  }

  return (
    <div className="as-mobile">
      {/* Camera-first screens own the whole pane (no scroll); everything
          else scrolls internally. */}
      <main className={activeScreen.bleed ? 'as-mobile-main bleed' : 'as-mobile-main'}>{body}</main>
      <nav className="as-dock" role="tablist" aria-label="Dock">
        {joinNav.map((screen) => (
          <button
            key={screen.id}
            role="tab"
            aria-selected={screen.id === activeScreen.id}
            className={screen.id === activeScreen.id ? 'dock-item active' : 'dock-item'}
            onClick={() => select(screen.id)}
          >
            {/* decorative: the label below is the button's accessible name */}
            <span className="dock-icon" aria-hidden="true">
              {screen.icon ?? <span className="dock-letter">{screen.label.slice(0, 1)}</span>}
            </span>
            <span className="dock-label">{screen.label}</span>
          </button>
        ))}
        {overflowScreens.length > 0 && (
          <button
            className={moreOpen ? 'dock-item active' : 'dock-item'}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
          >
            <span className="dock-icon" aria-hidden="true">
              <LayoutGridIcon size={24} />
            </span>
            <span className="dock-label">More</span>
          </button>
        )}
      </nav>
      {openMore}
    </div>
  );
}
