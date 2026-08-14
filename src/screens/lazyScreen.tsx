import { Suspense, lazy, type ComponentType } from 'react';

/**
 * Defer a screen to its own chunk.
 *
 * EstateScreenLazy established the pattern for the 3D estate; this generalises
 * it, because the same argument applies to every screen that is not on the dock.
 * A technician who opens the camera in a plant room should not download and
 * parse Diagnostics, Settings and the org Dashboard to get there — and under
 * role-based access they may not be allowed to open them at all.
 *
 * It also buys the headroom this feature needed: the entry chunk was within
 * 395 bytes (gzipped) of the budget `npm run check:bundle` enforces, and that
 * guard exists to stop exactly this kind of creep, so it is not negotiable.
 *
 * The Suspense boundary lives with the screen, not in AppShell, so the shell
 * keeps treating every screen as a plain component.
 */
export function lazyScreen(
  load: () => Promise<{ default: ComponentType }>,
  label: string,
): ComponentType {
  const Screen = lazy(load);
  return function LazyScreen() {
    return (
      <Suspense
        fallback={
          <section className="screen">
            <p className="muted">Loading {label}…</p>
          </section>
        }
      >
        <Screen />
      </Suspense>
    );
  };
}
