// A cached index.html pinned this app to assets from two deploys earlier, and
// refreshing did not clear it — the platform sends no cache headers, so the
// browser cached the shell heuristically. These lock the self-heal.
import { describe, expect, it, vi } from 'vitest';
import { findNewerBuild } from '../shell/buildCheck';

function withEntry(name: string) {
  document.head.innerHTML = `<script src="/assets/${name}"></script>`;
}

const html = (name: string) =>
  `<!doctype html><html><head><script type="module" src="/assets/${name}"></script></head></html>`;

describe('stale-shell detection', () => {
  it('reports the newer entry when the deployed shell points elsewhere', async () => {
    withEntry('index-OLD111.js');
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(html('index-NEW222.js'), { status: 200 }),
    );
    await expect(findNewerBuild(fetchImpl as unknown as typeof fetch)).resolves.toBe(
      'index-NEW222.js',
    );
    // must bypass the very cache that caused the bug
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
  });

  it('is silent when this tab already runs the deployed build', async () => {
    withEntry('index-SAME.js');
    const fetchImpl = vi.fn(async () => new Response(html('index-SAME.js'), { status: 200 }));
    await expect(findNewerBuild(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('never reloads on a network failure — offline is not a new build', async () => {
    withEntry('index-SAME.js');
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(findNewerBuild(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});
