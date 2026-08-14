import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { installMockProvider } from '../api/provider';
import { mockProvider } from '../api/mockProvider';

// The app fetches the fixture provider as a separate chunk (see provider.ts), so
// production never carries the demo lane. Tests set `?mock=1` per case, long
// after modules evaluate, and call the provider synchronously — so install it
// here, once. A static import in a test-only file costs the shipped bundle
// nothing.
installMockProvider(mockProvider);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
