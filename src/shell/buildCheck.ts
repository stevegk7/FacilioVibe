/**
 * Self-healing against a stale shell.
 *
 * The platform sends NO cache headers for index.html, so browsers apply
 * heuristic caching: Safari kept serving a shell that pointed at asset hashes
 * from two deploys earlier, and a normal refresh did not clear it. Asset files
 * are content-hashed and immutable, so the shell is the only thing that can go
 * stale — and it is the one thing that decides which assets you load.
 *
 * So: fetch the shell with `cache: 'no-store'`, read the entry script it now
 * points at, and compare with the one this page actually loaded. If they
 * differ, a newer deploy exists and this tab is running old code — reload once
 * to pick it up.
 *
 * The once-guard is per detected version, so a genuinely broken deploy cannot
 * put the tab in a reload loop.
 */
const RELOADED_FOR = 'fv.reloadedFor';

function currentEntry(): string | null {
  const scripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[];
  const entry = scripts.map((s) => s.getAttribute('src') ?? '').find((src) => /index-.*\.js$/.test(src));
  return entry ? entry.split('/').pop() ?? null : null;
}

function entryFrom(html: string): string | null {
  const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return match ? match[1] : null;
}

/** Returns the newer entry filename when this tab is stale, else null. */
export async function findNewerBuild(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const loaded = currentEntry();
  if (!loaded) return null;
  try {
    const res = await fetchImpl(`/?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const latest = entryFrom(await res.text());
    return latest && latest !== loaded ? latest : null;
  } catch {
    return null; // offline: the queue handles that, this is not the place to shout
  }
}

export function installBuildCheck(): void {
  const check = async () => {
    const newer = await findNewerBuild();
    if (!newer) return;
    let already: string | null = null;
    try {
      already = sessionStorage.getItem(RELOADED_FOR);
    } catch {
      /* storage blocked — fall through, worst case we do not reload */
    }
    if (already === newer) return; // already tried this one; do not loop
    try {
      sessionStorage.setItem(RELOADED_FOR, newer);
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  void check();
  // Coming back to the tab is the moment a technician expects fresh data.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}
