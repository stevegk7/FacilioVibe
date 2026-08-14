import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
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
