/**
 * The app's own store (roadmap 2.5 + 2.6): KV collections backed by the
 * fvApi Studio function + the Vibe file store. Same mock/real split as the
 * data provider — ?mock=1 keeps everything in-page.
 *
 * Values must be JSON-safe objects; they travel as JSON strings.
 */
import { vibe } from './vibe';
import { isMockMode } from './provider';
import { photoUrl } from './photoCache';

export type Collection = 'surveys' | 'codes' | 'settings';

export interface KvEntry<T = unknown> {
  key: string;
  value: T;
}

interface AppStore {
  kvPut(collection: Collection, key: string, value: unknown): Promise<void>;
  kvGet<T = unknown>(collection: Collection, key: string): Promise<T | null>;
  kvList<T = unknown>(collection: Collection, prefix?: string, limit?: number): Promise<KvEntry<T>[]>;
  kvDelete(collection: Collection, key: string): Promise<void>;
  /** Uploads a photo blob, returns its fileId (persist the id, never the URL). */
  uploadPhoto(blob: Blob, name: string): Promise<number>;
  /** Session-scoped object URL for a stored photo — cached, never persisted. */
  getPhotoUrl(fileId: number): Promise<string>;
}

// Seed rows from `facilio vibe db import` — invisible to the app.
const SEED_KEY = '__seed__';

const FN = 'fvApi';

/**
 * The app store lives in a Studio function that is published PER CHANNEL.
 * A build promoted to production without its function promoted alongside it
 * answers every call with 404 "app not found" — and a whole screen used to
 * die on that, painting a raw exception where the content should be.
 *
 * READS therefore degrade to empty: the screen renders its normal empty state
 * and the app raises ONE quiet, app-level notice. WRITES still throw — a save
 * that did not happen must never look like it did.
 */
let unavailableReason: string | null = null;
const statusListeners = new Set<(reason: string | null) => void>();

export function onAppStoreStatus(listener: (reason: string | null) => void): () => void {
  statusListeners.add(listener);
  listener(unavailableReason);
  return () => statusListeners.delete(listener);
}

function setUnavailable(reason: string | null) {
  if (unavailableReason === reason) return;
  unavailableReason = reason;
  for (const listener of statusListeners) listener(reason);
}

/** A 404 / "app not found" means the store is not published on this channel. */
function isStoreMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /404|app not found|function not found/i.test(message);
}

/** Reads: swallow a missing store, surface everything else. */
async function read<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const value = await run();
    setUnavailable(null);
    return value;
  } catch (err) {
    if (isStoreMissing(err)) {
      setUnavailable('The app store is not published on this channel yet — saved data is unavailable.');
      return fallback;
    }
    throw err;
  }
}

const realStore: AppStore = {
  async kvPut(collection, key, value) {
    await vibe.executeFunction(FN, 'kvPut', { collection, key, value: JSON.stringify(value) });
    setUnavailable(null);
  },

  async kvGet<T>(collection: Collection, key: string): Promise<T | null> {
    return read(
      async () => {
        const row = (await vibe.executeFunction(FN, 'kvGet', { collection, key })) as {
          value?: string;
        } | null;
        if (!row?.value) return null;
        return JSON.parse(row.value) as T;
      },
      null,
    );
  },

  async kvList<T>(collection: Collection, prefix = '', limit = 100): Promise<KvEntry<T>[]> {
    return read(
      async () => {
        const res = (await vibe.executeFunction(FN, 'kvList', { collection, prefix, limit })) as {
          rows?: Array<{ key: string; value: string }>;
        };
        return (res.rows ?? [])
          .filter((row) => row.key !== SEED_KEY)
          .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
      },
      [] as KvEntry<T>[],
    );
  },

  async kvDelete(collection, key) {
    await vibe.executeFunction(FN, 'kvDelete', { collection, key });
  },

  async uploadPhoto(blob, name) {
    const stored = (await vibe.uploadFile(blob, name)) as { fileId?: number; id?: number };
    const fileId = stored.fileId ?? stored.id;
    if (!fileId) throw new Error('uploadFile returned no fileId');
    return fileId;
  },

  getPhotoUrl(fileId) {
    return photoUrl(fileId, async (id) => (await vibe.downloadFile(id)) as Blob);
  },
};

// ---- mock: localStorage KV + in-memory object URLs ----

const MOCK_NS = 'fv.mockKv';
let mockFileId = 1;
const mockFiles = new Map<number, string>();

function mockKey(collection: Collection, key: string) {
  return `${MOCK_NS}.${collection}.${key}`;
}

const mockStore: AppStore = {
  async kvPut(collection, key, value) {
    localStorage.setItem(mockKey(collection, key), JSON.stringify(value));
  },

  async kvGet<T>(collection: Collection, key: string): Promise<T | null> {
    const raw = localStorage.getItem(mockKey(collection, key));
    return raw === null ? null : (JSON.parse(raw) as T);
  },

  async kvList<T>(collection: Collection, prefix = '', limit = 100): Promise<KvEntry<T>[]> {
    const nsPrefix = `${MOCK_NS}.${collection}.`;
    const entries: KvEntry<T>[] = [];
    for (let i = 0; i < localStorage.length && entries.length < limit; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(nsPrefix)) continue;
      const key = storageKey.slice(nsPrefix.length);
      if (!key.startsWith(prefix)) continue;
      entries.push({ key, value: JSON.parse(localStorage.getItem(storageKey) as string) as T });
    }
    return entries;
  },

  async kvDelete(collection, key) {
    localStorage.removeItem(mockKey(collection, key));
  },

  async uploadPhoto(blob) {
    const id = mockFileId++;
    mockFiles.set(id, URL.createObjectURL(blob));
    return id;
  },

  async getPhotoUrl(fileId) {
    const url = mockFiles.get(fileId);
    if (!url) throw new Error(`mock file ${fileId} not found`);
    return url;
  },
};

// Same lazy per-access resolution as the data provider — no import-order trap.
export const appStore: AppStore = new Proxy({} as AppStore, {
  get(_target, prop: keyof AppStore) {
    const active = isMockMode() ? mockStore : realStore;
    return active[prop];
  },
});
