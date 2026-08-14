import { useEffect, useState, type ComponentType } from 'react';
import ErrorBoundary from './ErrorBoundary';
import ARScreen from '../screens/ARScreen';
import SurveysScreen from '../screens/SurveysScreen';
import PortfolioScreen from '../screens/PortfolioScreen';
import DiagnosticsScreen from '../screens/DiagnosticsScreen';
import BoomScreen from '../screens/BoomScreen';

interface Screen {
  id: string;
  label: string;
  /** Hidden screens are reachable by ?tab= and join the bar only while active. */
  visible: boolean;
  component: ComponentType;
}

const SCREENS: Screen[] = [
  { id: 'ar', label: 'AR', visible: true, component: ARScreen },
  { id: 'surveys', label: 'Surveys', visible: true, component: SurveysScreen },
  { id: 'portfolio', label: 'Portfolio', visible: false, component: PortfolioScreen },
  { id: 'diagnostics', label: 'Diagnostics', visible: false, component: DiagnosticsScreen },
  { id: 'boom', label: 'Boom', visible: false, component: BoomScreen },
];

const DEFAULT_TAB = 'ar';

function tabFromLocation(): string {
  const wanted = new URLSearchParams(window.location.search).get('tab');
  return SCREENS.some((s) => s.id === wanted) ? (wanted as string) : DEFAULT_TAB;
}

/** Rewrite ONLY the tab param — mock/capp_id/origin/login must survive navigation. */
function pushTab(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', id);
  window.history.pushState({}, '', url);
}

export default function TabShell() {
  const [active, setActive] = useState(tabFromLocation);

  useEffect(() => {
    const onPopState = () => setActive(tabFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const select = (id: string) => {
    if (id === active) return;
    pushTab(id);
    setActive(id);
  };

  const activeScreen = SCREENS.find((s) => s.id === active) ?? SCREENS[0];
  const barScreens = SCREENS.filter((s) => s.visible || s.id === activeScreen.id);
  const ActiveComponent = activeScreen.component;

  return (
    <div className="tab-shell">
      <nav className="tab-bar" role="tablist" aria-label="Screens">
        {barScreens.map((screen) => (
          <button
            key={screen.id}
            role="tab"
            aria-selected={screen.id === activeScreen.id}
            className={screen.id === activeScreen.id ? 'tab active' : 'tab'}
            onClick={() => select(screen.id)}
          >
            {screen.label}
          </button>
        ))}
      </nav>
      {/* key resets the boundary when the tab changes, so one crashed screen
          never poisons the next one the user switches to */}
      <ErrorBoundary key={activeScreen.id} screen={activeScreen.label}>
        <ActiveComponent />
      </ErrorBoundary>
    </div>
  );
}
