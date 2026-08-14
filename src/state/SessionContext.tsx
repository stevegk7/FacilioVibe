/**
 * Who is signed in, what they are allowed to do, and — crucially — telling the
 * data layer before anything reads from it.
 *
 * AuthGate has always known the user and thrown it away (App.tsx called its
 * render prop with no argument), so every screen that wanted identity re-fetched
 * it. Now that identity decides what data comes back, it needs to be resolved
 * ONCE, up front, and published in two directions: to React through this
 * context, and to the provider seam through setSessionScope().
 *
 * The children are deliberately NOT rendered until the role resolves. A moment
 * of "admin" chrome before a technician's role arrives would flash screens they
 * cannot open and fire org-wide queries in their name — and the resolve is one
 * KV read plus one employee lookup, not a page load.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { provider } from '../api/provider';
import { isMockMode } from '../api/provider';
import { can as allows, loadRole, type Capability, type Role, type RoleSource } from '../api/roles';
import { sessionScope, setSessionScope } from '../api/scope';
import type { CurrentUser } from '../api/types';

export interface Session {
  me: CurrentUser;
  role: Role;
  /** Why this role — lets the UI distinguish a real denial from an unreadable store. */
  source: RoleSource;
  can: (capability: Capability) => boolean;
}

const SessionCtx = createContext<Session | null>(null);

/**
 * `?role=` overrides the resolved role in MOCK MODE ONLY.
 *
 * Not a backdoor: the branch cannot be reached with live data, because
 * isMockMode() gates it and mock mode reads fixtures. It exists because the
 * mock identity is a single hardcoded user, so without it neither role can be
 * rehearsed — and rehearsing a permission gate is exactly what ?mock=1 is for.
 */
function mockRole(): Role {
  const wanted = new URLSearchParams(window.location.search).get('role');
  return wanted === 'technician' ? 'technician' : 'admin';
}

export function SessionProvider({ me, children }: { me: CurrentUser; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    const email = me.user?.email;

    void (async () => {
      const resolved = isMockMode()
        ? { role: mockRole(), source: 'map' as RoleSource }
        : await loadRole(email, me.admin);

      // Only a technician needs the employee id, and only in live mode — it is
      // the id space assignment uses. A failure here must not escalate anyone,
      // so it degrades to "no employee id" and leaves the other matches to work.
      let employeeId: number | undefined;
      if (resolved.role === 'technician' && email) {
        try {
          employeeId = (await provider.resolveEmployeeId(email)) ?? undefined;
        } catch {
          employeeId = undefined;
        }
      }
      if (cancelled) return;

      // The data layer learns the scope BEFORE any screen mounts and reads.
      setSessionScope({ role: resolved.role, uid: me.user?.uid, employeeId, email });
      setSession({
        me,
        role: resolved.role,
        source: resolved.source,
        can: (capability) => allows(resolved.role, capability),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [me]);

  if (!session) {
    return (
      <main className="shell auth-screen">
        <p className="muted">Checking your permissions…</p>
      </main>
    );
  }

  return <SessionCtx.Provider value={session}>{children}</SessionCtx.Provider>;
}

/**
 * Null only outside a provider — which in practice means a test rendering one
 * screen in isolation, since App always wraps.
 */
export function useSession(): Session | null {
  return useContext(SessionCtx);
}

/**
 * Outside a provider, fall back to the role the DATA LAYER is already using
 * rather than to a hardcoded guess. That keeps the two answers from ever
 * disagreeing — a screen cannot offer a button for data the seam would refuse
 * to return — and it still denies by default, because scope.ts starts as a
 * technician until a session resolves.
 */
export function useRole(): Role {
  return useContext(SessionCtx)?.role ?? sessionScope().role;
}

/**
 * The gate every screen should use: `const can = useCan(); can('wo.assign')`.
 *
 * Stable across renders on purpose. App.tsx memoises the screen registry on it,
 * and AppShell re-registers its popstate listener whenever that array changes —
 * so returning a fresh closure each render quietly rebuilt both every time
 * anything on the screen updated.
 */
export function useCan(): (capability: Capability) => boolean {
  const session = useContext(SessionCtx);
  const role = session?.role ?? sessionScope().role;
  return useCallback((capability: Capability) => allows(role, capability), [role]);
}
