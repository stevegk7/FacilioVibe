import { useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import AuthGate from './auth/AuthGate';
import { detectEmbed } from './shell/embed';
import { installGlobalErrorHandlers, onGlobalError } from './shell/globalErrors';
import { createAppQueryClient, purgeLegacyPersistedCache } from './api/queryClient';
import { onQueueChange, flushQueue } from './api/offlineQueue';
import { isMockMode } from './api/provider';
import { LocationProvider } from './state/LocationContext';
import {
  AppShell,
  CameraIcon,
  ClipboardListIcon,
  CubeIcon,
  HomeIcon,
  LayoutGridIcon,
  MapPinIcon,
  MicIcon,
  RouteIcon,
  SettingsIcon,
  type ShellScreen,
} from './layout';
import ARScreen from './screens/ARScreen';
import EstateScreen from './screens/EstateScreenLazy';
import SurveysScreen from './screens/SurveysScreen';
import PortfolioScreen from './screens/PortfolioScreen';
import CaptureScreen from './screens/CaptureScreen';
import RoomsScreen from './screens/RoomsScreen';
import VoiceSheet from './screens/VoiceSheet';
import DashboardScreen from './screens/DashboardScreen';
import RoundsScreen, { ActiveRoundChip } from './screens/RoundsScreen';
import WayfinderScreen from './screens/WayfinderScreen';
import SettingsScreen from './screens/SettingsScreen';
import DiagnosticsScreen from './screens/DiagnosticsScreen';
import BoomScreen from './screens/BoomScreen';

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
  { id: 'estate', label: '3D Estate', icon: <CubeIcon />, visible: true, bleed: true, component: EstateScreen },
  { id: 'ar', label: 'AR', icon: <CameraIcon />, visible: true, bleed: true, component: ARScreen },
  { id: 'wayfinder', label: 'Wayfinder', icon: <RouteIcon />, visible: true, component: WayfinderScreen },
  { id: 'surveys', label: 'Surveys', icon: <MapPinIcon />, visible: false, section: 'workspace', component: SurveysScreen },
  { id: 'rounds', label: 'Rounds', icon: <RouteIcon />, visible: false, section: 'workspace', component: RoundsScreen },
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutGridIcon />, visible: false, component: DashboardScreen },
  { id: 'portfolio', label: 'Portfolio', icon: <HomeIcon />, visible: false, component: PortfolioScreen },
  { id: 'capture', label: 'Capture', icon: <CameraIcon />, visible: false, bleed: true, component: CaptureScreen },
  { id: 'rooms', label: 'Rooms', icon: <HomeIcon />, visible: false, component: RoomsScreen },
  { id: 'voice', label: 'Voice', icon: <MicIcon />, visible: false, component: VoiceSheet },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, visible: false, component: SettingsScreen },
  { id: 'diagnostics', label: 'Diagnostics', icon: <ClipboardListIcon />, visible: false, component: DiagnosticsScreen },
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

export default function App() {
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const embed = detectEmbed();

  const queryClient = useMemo(createAppQueryClient, []);
  // Clear anything a build with persistence left on disk.
  useMemo(purgeLegacyPersistedCache, []);

  useEffect(() => onGlobalError(setGlobalError), []);
  useEffect(() => onQueueChange(setPendingWrites), []);

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
        {pendingWrites > 0 && (
          <div className="offline-banner" role="status">
            <span>
              {pendingWrites} change{pendingWrites === 1 ? '' : 's'} waiting for connection
            </span>
            <button onClick={() => void flushQueue()}>Retry now</button>
          </div>
        )}
        <AuthGate embedded={embed.embedded}>
          {() => (
            <LocationProvider>
              <ActiveRoundChip />
              <AppShell screens={SCREENS} initialTab={landingTab()} />
            </LocationProvider>
          )}
        </AuthGate>
      </div>
    </QueryClientProvider>
  );
}
