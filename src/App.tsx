import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import AuthGate from './auth/AuthGate';
import { detectEmbed } from './shell/embed';
import { installGlobalErrorHandlers, onGlobalError } from './shell/globalErrors';
import { createAppQueryClient, purgeLegacyPersistedCache } from './api/queryClient';
import { onQueueChange, flushQueue } from './api/offlineQueue';
import { onAppStoreStatus } from './api/appStore';
import { isMockMode } from './api/provider';
import { LocationProvider } from './state/LocationContext';
import { warmOrientation } from './hooks/useHeading';
import { warmCameraGeometry } from './components/camera/useCamera';
import {
  AppShell,
  CameraIcon,
  CubeIcon,
  HomeIcon,
  LayoutGridIcon,
  MapPinIcon,
  MicIcon,
  RouteIcon,
  SettingsIcon,
  type ShellScreen,
} from './layout';
import { SessionProvider, useCan } from './state/SessionContext';
import ARScreen from './screens/ARScreen';
import EstateScreen from './screens/EstateScreenLazy';
import WayfinderScreen from './screens/WayfinderScreen';
import BoomScreen from './screens/BoomScreen';
import { lazyScreen } from './screens/lazyScreen';

// Only the dock three stay eager. Everything else is deferred — see lazyScreen
// for why the entry chunk had no room left.
//
// Rounds, Capture and Rooms are deliberately absent: all three were withdrawn
// from the product. Their source is still in the tree (src/rounds/,
// CaptureScreen, RoomsScreen, and the vision capture pipeline that AR,
// Dashboard and Voice all still import) but none is registered, so none is
// reachable — including by ?tab=, which resolves against this array.
// Diagnostics moved inside Settings.
const SurveysScreen = lazyScreen(() => import('./screens/SurveysScreen'), 'surveys');
const PortfolioScreen = lazyScreen(() => import('./screens/PortfolioScreen'), 'the portfolio');
const VoiceSheet = lazyScreen(() => import('./screens/VoiceSheet'), 'Effi');
const DashboardScreen = lazyScreen(() => import('./screens/DashboardScreen'), 'the dashboard');
const SettingsScreen = lazyScreen(() => import('./screens/SettingsScreen'), 'settings');

installGlobalErrorHandlers();

// Thumb economy on camera surfaces: three dock tabs, no more (design rule 1.5).
// Everything else is reachable by ?tab=, and on the desktop layout every screen
// is listed — under Workspace or Admin, per its `section`.
//
// The dock is 3D Estate · AR · Wayfinder. Estate is the navigation spine and the
// landing target for "Show in 3D"; AR is home in a corridor; Wayfinder both has
// a useful cold entry (it lists open work orders with a resource) and is where
// "Find it on site" lands when an asset has no AR pin yet. Surveys and Rounds
// give up their dock slots but stay in Workspace — they are field tools, not
// admin screens.
const SCREENS: ShellScreen[] = [
  // "3D plan" (the user's pick, 2026-08-15). id stays 'estate' for the same
  // reason 'ar' did: ?tab= and goToTab() are wired into hand-offs.
  { id: 'estate', label: '3D plan', icon: <CubeIcon />, visible: true, bleed: true, component: EstateScreen },
  // Label is "Vision" (the user's pick, 2026-08-15 — matches the app's own
  // name); the id stays 'ar' because ?tab=ar and goToTab('ar') are baked into
  // hand-offs, QR flows and bookmarks, and an id is plumbing, not copy.
  { id: 'ar', label: 'Vision', icon: <CameraIcon />, visible: true, bleed: true, component: ARScreen },
  { id: 'wayfinder', label: 'Wayfinder', icon: <RouteIcon />, visible: true, component: WayfinderScreen },
  { id: 'surveys', label: 'Surveys', icon: <MapPinIcon />, visible: false, section: 'workspace', component: SurveysScreen },
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutGridIcon />, visible: false, component: DashboardScreen },
  { id: 'portfolio', label: 'Portfolio', icon: <HomeIcon />, visible: false, component: PortfolioScreen },
  { id: 'voice', label: 'Voice', icon: <MicIcon />, visible: false, component: VoiceSheet },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, visible: false, component: SettingsScreen },
  // Deliberate crash screen for the error-boundary test — ?tab=boom only.
  { id: 'boom', label: 'Boom', visible: false, devOnly: true, component: BoomScreen },
];

/**
 * Estate is the spine on a large screen; AR is the spine in a corridor.
 *
 * jsdom has no working matchMedia and AppShell already treats "can't tell" as
 * not-desktop, so tests land on 'ar' — identical to the previous default.
 */
function landingTab(): string {
  const desktop =
    typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
  return desktop ? 'estate' : 'ar';
}

/**
 * The registry, minus anything this person may not open.
 *
 * Filtering HERE rather than inside AppShell is what makes the gate real: the
 * shell resolves ?tab= against the array it is handed, so a screen removed here
 * cannot be reached by typing its id into the URL — it is not merely hidden
 * from the dock, the sidebar and the More sheet.
 */
function RoleAwareShell() {
  const can = useCan();
  const screens = useMemo(
    () => SCREENS.filter((screen) => !screen.requires || can(screen.requires)),
    [can],
  );
  return <AppShell screens={screens} initialTab={landingTab()} />;
}

export default function App() {
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [storeUnavailable, setStoreUnavailable] = useState<string | null>(null);
  const embed = detectEmbed();

  const queryClient = useMemo(createAppQueryClient, []);
  // Clear anything a build with persistence left on disk.
  useMemo(purgeLegacyPersistedCache, []);

  useEffect(() => onGlobalError(setGlobalError), []);
  useEffect(() => onQueueChange(setPendingWrites), []);
  // The app store publishes this notice when its Studio function answers 404 —
  // the exact state of a build promoted to a channel without `fvApi` promoted
  // alongside it. Reads then degrade to empty by design, so without a subscriber
  // the whole app looked like a first-run org: Surveys empty, "This site has no
  // route map yet", every asset reported unpinned. appStore.ts has always
  // promised "ONE quiet, app-level notice"; nothing was listening for it.
  useEffect(() => onAppStoreStatus(setStoreUnavailable), []);

  // Sensors warm at load, not when a camera surface opens. The compass needs
  // seconds to settle and the projection needs the camera's real frame shape;
  // acquiring both on arrival at the AR tab meant the first aim of a session
  // was taken against a half-converged frame — and a survey keeps that error.
  // Neither call can raise a permission prompt on its own.
  useEffect(() => {
    warmOrientation();
    void warmCameraGeometry();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <div className={embed.embedded ? 'app embedded' : 'app'}>
        {globalError && (
          <div className="global-error-banner" role="alert">
            <span>{globalError}</span>
            <button onClick={() => setGlobalError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {/* Demo data is indistinguishable from the real org's seeded data by
            name, and ?mock=1 survives every navigation — so say so, loudly and
            permanently, rather than letting someone review fixtures as if they
            were live records. */}
        {isMockMode() && (
          <div className="demo-banner" role="status">
            <span>Demo data — not your live Facilio records</span>
            <button
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete('mock');
                window.location.replace(url.toString());
              }}
            >
              Use live data
            </button>
          </div>
        )}
        {/* Not dismissible while true: every saved-data screen is lying about
            being empty until this is fixed, and the fix is an admin action
            (promote fvApi on this channel), not something the user can retry. */}
        {storeUnavailable && (
          <div className="store-banner" role="alert">
            <span>{storeUnavailable}</span>
          </div>
        )}
        {pendingWrites > 0 && (
          <div className="offline-banner" role="status">
            <span>
              {pendingWrites} change{pendingWrites === 1 ? '' : 's'} waiting for connection
            </span>
            <button onClick={() => void flushQueue()}>Retry now</button>
          </div>
        )}
        <AuthGate embedded={embed.embedded}>
          {(me) => (
            <SessionProvider me={me}>
              <LocationProvider>
                <RoleAwareShell />
              </LocationProvider>
            </SessionProvider>
          )}
        </AuthGate>
      </div>
    </QueryClientProvider>
  );
}
