import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installMockProvider } from '../api/provider';
import { mockProvider } from '../api/mockProvider';
import { setSessionScope } from '../api/scope';

// The app fetches the fixture provider as a separate chunk (see provider.ts), so
// production never carries the demo lane. Tests set `?mock=1` per case, long
// after modules evaluate, and call the provider synchronously — so install it
// here, once. A static import in a test-only file costs the shipped bundle
// nothing.
installMockProvider(mockProvider);

/**
 * Give a `findBy*` a budget proportionate to the test's own.
 *
 * testTimeout is 20s (vite.config.ts, raised for the AR suites with a measured
 * reason). Testing Library's per-query budget was left at its 1s default, and
 * that mismatch is the whole flake: every intermittent failure in this suite has
 * the same shape — a `findByText`/`findByRole` immediately after mount, giving up
 * after one second while the test still had nineteen in hand.
 *
 * What must happen inside that second before the assertion can pass: the auth
 * check resolves, the demo dataset seeds into the mock KV, several react-query
 * reads settle, and — since screens became lazy — a dynamic import resolves too.
 * On an idle machine that fits comfortably. On a busy one it does not, and the
 * failure reads "Unable to find an element", which looks exactly like a
 * regression rather than like a stopwatch running out. That misreading cost real
 * time: a green commit was investigated as a regression because of it.
 *
 * No assertion is weakened. A genuinely missing element still fails — it takes
 * 5s to say so instead of 1s, and only on the path that was going to fail
 * anyway. A passing test pays nothing: these resolve the moment the element
 * appears, so the cap is a ceiling, not a delay.
 */
configure({ asyncUtilTimeout: 5000 });

/**
 * Every test starts as an ADMIN.
 *
 * The data layer denies by default (scope.ts) so that a read which somehow
 * beats session resolution returns nothing rather than everything. That is the
 * right production default and the wrong test default: a suite that sets no
 * session would otherwise assert against an empty app, and every existing test
 * would be testing the gate instead of the thing it was written for.
 *
 * So the shared setup restores the pre-RBAC behaviour, and the tests that care
 * about scoping opt into a technician explicitly with setSessionScope().
 */
beforeEach(() => {
  setSessionScope({ role: 'admin' });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
