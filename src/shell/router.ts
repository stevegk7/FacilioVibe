/**
 * Cross-screen navigation.
 *
 * AppShell keeps the active tab in local state and re-reads the URL only on
 * `popstate`, so a bare `history.pushState` changes the address bar without
 * changing the screen. Dispatching the event is what closes that loop.
 *
 * This generalises the one ad-hoc cross-nav that already existed in
 * WorkOrderPanel ("Navigate to asset"), and adds the part that was missing
 * there: only the named params are touched. `mock`, `capp_id`, `origin`,
 * `login` and `harness` must survive every navigation — the same rule
 * AppShell's own pushTab documents — or handing an asset from AR to the 3D
 * estate would quietly drop the user out of mock mode, or out of the connected-app
 * embed.
 *
 * Deliberately SDK-free so it stays on the right side of the provider seam.
 */

/** Params this module owns. Anything else in the URL is left exactly as it is. */
export type NavParam = 'asset' | 'focus' | 'view';

const OWNED: NavParam[] = ['asset', 'focus', 'view'];

export interface GoOptions {
  /**
   * Replace instead of push. Use for state that must not stack — the 3D estate
   * writing the open building/floor as the user drills, where pushing would turn
   * Back into forty presses.
   */
  replace?: boolean;
}

/**
 * Switch tab, optionally carrying params. A param set to null (or omitted from
 * a set that previously carried it) is cleared, so a there-and-back navigation
 * cannot re-fire a stale intent.
 */
export function goToTab(
  tab: string,
  params: Partial<Record<NavParam, string | number | null>> = {},
  opts: GoOptions = {},
): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);

  for (const key of OWNED) {
    const value = params[key];
    if (value === undefined || value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }

  if (opts.replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState({ from: currentTab() }, '', url);

  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Update owned params without changing tab (and without stacking history). */
export function setNavParams(params: Partial<Record<NavParam, string | number | null>>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params) as [NavParam, string | number | null][]) {
    if (value === undefined || value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  window.history.replaceState(window.history.state, '', url);
}

export function currentTab(): string | null {
  return new URLSearchParams(window.location.search).get('tab');
}

export function navParam(key: NavParam): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

/** Numeric owned param, or null when absent or not a number. */
export function navParamId(key: NavParam): number | null {
  const raw = navParam(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which tab the user came from, when this navigation was a push.
 * Inside a Facilio webview there may be no visible browser Back, so a screen
 * arrived at by handoff can offer its own way back.
 */
export function cameFrom(): string | null {
  const state = window.history.state as { from?: unknown } | null;
  return typeof state?.from === 'string' ? state.from : null;
}

/**
 * Subscribe to navigation. Screens must react while MOUNTED, not only at mount:
 * the pre-merge Wayfinder read `?asset` in a useState initialiser, so pushing a
 * new asset at an already-open Wayfinder did nothing at all.
 */
export function onNavigate(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
