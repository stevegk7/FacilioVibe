import { Suspense, lazy } from 'react';

/**
 * The 3D estate, deferred.
 *
 * EstateScreen pulls in buildEstate (~640 lines of layout maths) and, through
 * it, the whole 3D data path — and the screen is the only thing that ever
 * imports them. Statically imported, all of that rides in the entry chunk and is
 * parsed by the technician who only opens the camera. three.js is already behind
 * a dynamic import in loadEngine.ts; this puts the screen on the same footing.
 *
 * The Suspense boundary lives here rather than in AppShell so the shell keeps
 * treating every screen as a plain component and no other screen pays for a
 * wrapper it does not need.
 */
const EstateScreen = lazy(() => import('./EstateScreen'));

export default function EstateScreenLazy() {
  return (
    <Suspense
      fallback={
        <section className="screen">
          <p className="muted">Loading the 3D estate…</p>
        </section>
      }
    >
      <EstateScreen />
    </Suspense>
  );
}
