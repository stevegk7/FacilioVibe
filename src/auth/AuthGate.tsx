import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DataProvider } from '../api/dataProvider';
import type { CurrentUser } from '../api/types';
import { provider as defaultProvider } from '../api/provider';

const ATTEMPT_KEY = 'fv.autoLoginAttempted';

// sessionStorage can throw in third-party iframe contexts — never let the
// auth gate die on the marker.
function marker(get: boolean, set?: boolean): boolean {
  try {
    if (set) sessionStorage.setItem(ATTEMPT_KEY, '1');
    if (set === false) sessionStorage.removeItem(ATTEMPT_KEY);
    return get ? sessionStorage.getItem(ATTEMPT_KEY) === '1' : false;
  } catch {
    return false;
  }
}

/**
 * `?login=1` boots this bundle top-level in a new tab, where `embedded` is
 * false, so the ordinary redirect path runs and the session lands on the
 * shared cookie the embedded copy also reads.
 */
function isLoginTab(): boolean {
  return new URLSearchParams(window.location.search).get('login') === '1';
}

type GateState =
  | { phase: 'checking' }
  | { phase: 'redirecting' }
  | { phase: 'ready'; me: CurrentUser }
  | { phase: 'embedded-signin' }
  | { phase: 'error'; reason: string | null };

interface Props {
  embedded: boolean;
  children: (me: CurrentUser) => ReactNode;
  /** Injectable for tests; defaults to the app-wide seam. */
  provider?: DataProvider;
}

/**
 * Session gate. getCurrentUser() is the single source of truth for
 * "signed in?" — null and thrown checks both land here, nowhere else.
 *
 * Standalone: a failed check triggers login() automatically AT MOST ONCE per
 * browser session (sessionStorage marker), so a broken identity round-trip
 * degrades to a visible sign-in button instead of a redirect loop.
 *
 * Embedded (iframe or native webview): NEVER auto-redirect — a full-page
 * login() inside a host frame renders in a 400px box or is blocked by
 * frame-ancestors. Open `?login=1` in a real tab and poll until the shared
 * cookie appears.
 */
export default function AuthGate({ embedded, children, provider = defaultProvider }: Props) {
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  const [retry, setRetry] = useState(0);
  const failReason = useRef<string | null>(null);

  const check = useCallback(async (): Promise<CurrentUser | null> => {
    try {
      return await provider.getCurrentUser();
    } catch (err: unknown) {
      // A thrown check usually means the request was bounced to the sign-in
      // page — a cross-origin redirect the browser won't let us read. Treat
      // it as "no session" rather than a hard failure, but keep the reason.
      failReason.current = err instanceof Error ? err.message : String(err);
      return null;
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    failReason.current = null;
    setState({ phase: 'checking' });

    void check().then((me) => {
      if (cancelled) return;
      if (me) {
        marker(false, false);
        setState({ phase: 'ready', me });
        return;
      }
      if (embedded && !isLoginTab()) {
        setState({ phase: 'embedded-signin' });
        return;
      }
      if (!marker(true)) {
        marker(false, true);
        setState({ phase: 'redirecting' });
        provider.login(); // navigates away; state above only shows if it doesn't
      } else {
        setState({ phase: 'error', reason: failReason.current });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [retry, embedded, check, provider]);

  // While waiting on the sign-in tab, re-check on a timer and whenever the
  // user returns to this frame.
  useEffect(() => {
    if (state.phase !== 'embedded-signin') return;
    const tick = () => {
      void check().then((me) => {
        if (me) {
          marker(false, false);
          setState({ phase: 'ready', me });
        }
      });
    };
    const interval = window.setInterval(tick, 2000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [state.phase, check]);

  if (state.phase === 'ready') {
    if (isLoginTab()) {
      return (
        <main className="shell auth-screen">
          <p>Signed in — you can close this tab and return to Facilio.</p>
        </main>
      );
    }
    return <>{children(state.me)}</>;
  }

  return (
    <main className="shell auth-screen">
      {state.phase === 'embedded-signin' ? (
        <div className="auth-stack">
          <h1>Facilio Vision</h1>
          <p className="muted">Sign in to Facilio to continue.</p>
          <button
            onClick={() => window.open(`${window.location.pathname}?login=1`, '_blank', 'noopener')}
          >
            Sign in
          </button>
          <p className="muted small">Opens a new tab. This panel updates as soon as you're signed in.</p>
        </div>
      ) : state.phase === 'error' ? (
        <div className="auth-stack">
          <h1>Facilio Vision</h1>
          <p className="muted">Couldn't check your session.</p>
          {state.reason && <p className="error">{state.reason}</p>}
          <div className="row">
            <button
              onClick={() => {
                marker(false, false);
                setRetry((r) => r + 1);
              }}
            >
              Retry
            </button>
            <button
              onClick={() => {
                marker(false, false);
                provider.login();
              }}
            >
              Sign in
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">
          {state.phase === 'redirecting' ? 'Redirecting to sign-in…' : 'Checking session…'}
        </p>
      )}
    </main>
  );
}
