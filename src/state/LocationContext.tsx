import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LocationScope } from '../api/types';

// 2.7 — where the user is working, sticky for the session. sessionStorage (not
// local) on purpose: a technician moving to another site tomorrow should not
// inherit today's floor.

const STORAGE_KEY = 'fv.location';

export interface LocationState {
  scope: LocationScope;
  /** Human-readable labels for the chosen ids, for chips/headers. */
  names: { site?: string; building?: string; floor?: string };
}

interface LocationContextValue extends LocationState {
  setLocation(next: LocationState): void;
  clearLocation(): void;
}

const EMPTY: LocationState = { scope: {}, names: {} };

function load(): LocationState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as LocationState;
    return parsed && typeof parsed === 'object' && parsed.scope ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(state: LocationState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage can be blocked in third-party iframes — stickiness degrades,
    // the picker still works for the page's lifetime
  }
}

const LocationContext = createContext<LocationContextValue | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LocationState>(load);

  const value = useMemo<LocationContextValue>(
    () => ({
      ...state,
      setLocation(next) {
        setState(next);
        save(next);
      },
      clearLocation() {
        setState(EMPTY);
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      },
    }),
    [state],
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocationScope(): LocationContextValue {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocationScope must be used inside <LocationProvider>');
  return ctx;
}
