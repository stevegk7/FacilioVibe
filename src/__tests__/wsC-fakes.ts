// Shared fake VoiceDeps for the WS-C suites. Injection, not monkey-patching:
// the provider Proxy resolves per property access and patching it is a trap.
import { vi } from 'vitest';
import type { VoiceDeps } from '../voice/deps';

export function fakeDeps(overrides: Partial<VoiceDeps> = {}): VoiceDeps {
  return {
    searchAssets: vi.fn(async () => []),
    listWorkOrdersForAssets: vi.fn(async () => []),
    listWorkOrderTasks: vi.fn(async () => []),
    setTaskStatus: vi.fn(async () => {}),
    getStatuses: vi.fn(async () => [
      { label: 'Open', value: 'Open' },
      { label: 'In Progress', value: 'In Progress' },
      { label: 'On Hold', value: 'On Hold' },
      { label: 'Closed', value: 'Closed' },
    ]),
    changeStatus: vi.fn(async () => {}),
    getWorkOrder: vi.fn(async () => null),
    addWorkOrderTask: vi.fn(async () => 9001),
    findLocations: vi.fn(async () => []),
    routeToPlace: vi.fn(async () => null),
    createWorkOrder: vi.fn(async () => 4242),
    listOpenWorkOrders: vi.fn(async () => []),
    routeToAsset: vi.fn(async () => null),
    uploadPhoto: vi.fn(async () => 77),
    draftWorkOrder: vi.fn(async (_fileId: number, _context: string) => ({
      subject: 'Leaking flange',
      description: 'Water pooling under the unit.',
      priority: 'Medium' as const,
    })),
    identifyAsset: vi.fn(async () => ({ assetId: null, confidence: 0, reason: 'unset' })),
    // The view-driving tools. Fakes never navigate — a test asserting a spoken
    // sentence must not also change the tab out from under the harness.
    showInEstate: vi.fn(async () => 'Showing it in the 3D estate.'),
    showOnSite: vi.fn(async () => 'Opening AR.'),
    currentPlace: vi.fn(async () => ({})),
    voiceTurn: vi.fn(async (_input: string) => 'ok'),
    speak: vi.fn(),
    ...overrides,
  };
}

/** A voiceTurn that walks a scripted list of replies, then repeats the last. */
export function scriptedTurns(replies: string[]) {
  let i = 0;
  return vi.fn(async (_input: string) => replies[Math.min(i++, replies.length - 1)]);
}
