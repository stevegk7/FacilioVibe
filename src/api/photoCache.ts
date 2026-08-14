/**
 * fileId → objectURL cache (roadmap 2.6). Object URLs are session-scoped and
 * must never be persisted — the react-query persister's isJsonSafe filter
 * would refuse them anyway, but photo URLs never enter the query cache at
 * all: components go through this module. A small LRU keeps memory bounded
 * when browsing large galleries. (Lifted from asset-lens/src/api/photoCache.ts.)
 */
const MAX = 120;

const cache = new Map<number, string>();
const pending = new Map<number, Promise<string>>();

export function cachedPhotoUrl(fileId: number): string | undefined {
  return cache.get(fileId);
}

export async function photoUrl(
  fileId: number,
  fetchBlob: (fileId: number) => Promise<Blob>,
): Promise<string> {
  const hit = cache.get(fileId);
  if (hit) {
    // refresh LRU position
    cache.delete(fileId);
    cache.set(fileId, hit);
    return hit;
  }
  const inFlight = pending.get(fileId);
  if (inFlight) return inFlight;
  const p = (async () => {
    const blob = await fetchBlob(fileId);
    const url = URL.createObjectURL(blob);
    cache.set(fileId, url);
    while (cache.size > MAX) {
      const [oldId, oldUrl] = cache.entries().next().value as [number, string];
      cache.delete(oldId);
      URL.revokeObjectURL(oldUrl);
    }
    return url;
  })().finally(() => pending.delete(fileId));
  pending.set(fileId, p);
  return p;
}
